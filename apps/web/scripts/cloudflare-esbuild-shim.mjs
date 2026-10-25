// Wraps the real esbuild so every bundling pass the OpenNext adapters run gets
// the adjustments a Cloudflare Worker build needs. It is installed by
// `cloudflare-esbuild-hook.mjs`, which resolves the "esbuild" specifier to this
// file, so nothing else in the build is affected.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");

const realEsbuildPath = process.env.ONEMAIL_CLOUDFLARE_REAL_ESBUILD;

if (!realEsbuildPath) {
  throw new Error(
    "cloudflare-esbuild-shim.mjs must be loaded by cloudflare-esbuild-hook.mjs",
  );
}

const real = createRequire(import.meta.url)(realEsbuildPath);

/**
 * Next vendors its own OpenTelemetry packages under `next/dist/compiled`. When
 * the tracer copies them into the standalone output their internal
 * `next/dist/compiled/@opentelemetry/api` requires no longer resolve, because
 * the copies no longer live inside `next`. `@opentelemetry/api` is API-only, so
 * pointing the specifier at Next's vendored copy keeps a single copy in the
 * bundle instead of dropping the dependency on the floor.
 */
const NEXT_VENDORED_OTEL = "next/dist/compiled/@opentelemetry/api";

/**
 * `sharp` is a native addon, so it can never be bundled for workerd. Nothing on
 * the Worker path optimizes images (there is no `.node` loader and no sharp
 * binary), and externalizing it keeps the bundler from following the native
 * requires into `@img/*`.
 */
const NATIVE_EXTERNALS = ["sharp"];

const otelAlias = path.join(
  APP_ROOT,
  "node_modules",
  "next",
  "dist",
  "compiled",
  "@opentelemetry",
  "api",
);

/**
 * `pg-cloudflare` exports a socket that runs on workerd, but only under the
 * `workerd` export condition; everything else gets `dist/empty.js`, an object
 * with no exports. `pg` decides at runtime whether the host is a Worker and, when
 * it is, does `new CloudflareSocket(...)` from that module — so a bundle that
 * resolved the empty variant throws `b9 is not a constructor` on the first query.
 * The build here does not add the condition, so the specifier is pointed at the
 * real entry instead. It is only reachable from `pg`'s Worker branch and its
 * `cloudflare:sockets` import stays dynamic, so the alias costs nothing on Node.
 */
function pgCloudflareEntry() {
  try {
    const pgRequire = createRequire(
      createRequire(import.meta.url).resolve("pg/package.json"),
    );
    return path.join(
      path.dirname(pgRequire.resolve("pg-cloudflare/package.json")),
      "dist/index.js",
    );
  } catch {
    return null;
  }
}

const pgCloudflareAlias = pgCloudflareEntry();

function withCloudflareDefaults(options = {}, allowPlugins = true) {
  // `alias` and `external` are bundling-only options; esbuild rejects them on
  // the transform calls some of the adapter steps make.
  if (options.bundle !== true) return options;

  const external = options.external ?? [];

  return {
    ...options,
    alias: {
      ...(options.alias ?? {}),
      [NEXT_VENDORED_OTEL]: otelAlias,
      // Native JOBS delivery replaces the Node process that would run BullMQ.
      bullmq: path.join(APP_ROOT, "cloudflare/node-queue-unavailable.ts"),
      "@vercel/queue": path.join(
        APP_ROOT,
        "cloudflare/vercel-queue-unavailable.mjs",
      ),
      ...(pgCloudflareAlias ? { "pg-cloudflare": pgCloudflareAlias } : {}),
    },
    external: [
      ...new Set([
        ...(Array.isArray(external) ? external : [external]),
        ...NATIVE_EXTERNALS,
      ]),
    ],
    // The synchronous API rejects plugins outright.
    plugins: allowPlugins
      ? [
          prismaCompilerModule(),
          ...(options.plugins ?? []),
          ...bundleOutputPlugins(options),
        ]
      : options.plugins,
  };
}

function bundleOutputPlugins(options) {
  if (!options.outfile) return [];

  return [wasmModuleImports(), patchServerBundle(options.outfile)];
}

function prismaCompilerModule() {
  // The Worker imports the compiled wasm module; patchServerBundle replaces
  // the runtime compiler call, so its duplicate base64 payload is unused.
  return {
    name: "onemail-precompiled-prisma",
    setup(build) {
      build.onLoad(
        { filter: /query_compiler_fast_bg\.postgresql\.wasm-base64\.mjs$/ },
        () => ({ contents: 'export const wasm = "";', loader: "js" }),
      );
    },
  };
}

/**
 * Keeps `import mod from "./query_compiler_fast_bg.wasm?module"` working in a
 * bundled file.
 *
 * Prisma's workerd client imports its query compiler through the Workers
 * `?module` suffix, which makes the import resolve to a `WebAssembly.Module`
 * instead of bytes (workerd refuses `new WebAssembly.Module(...)` from a
 * buffer, which is exactly what Prisma's other runtimes do). esbuild has no
 * loader that encodes that semantics, and leaving the import for wrangler to
 * compile only works if the `.wasm` file sits next to the bundle, which
 * esbuild's `file` loader would not give us either (it yields a URL string).
 *
 * So the specifier stays external — verbatim, `?module` included — and the
 * file it points at is copied beside the bundle, where wrangler's default
 * `CompiledWasm` rule picks it up.
 */
function wasmModuleImports() {
  const suffix = "?module";

  return {
    name: "onemail-wasm-module",
    setup(build) {
      const sources = new Map();

      build.onResolve({ filter: /\.wasm\?module$/ }, (args) => {
        sources.set(
          path.basename(args.path.slice(0, -suffix.length)),
          path.resolve(args.resolveDir, args.path.slice(0, -suffix.length)),
        );

        return { external: true, path: args.path };
      });

      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;

        const outfile = build.initialOptions.outfile;
        if (!outfile) return;

        const outputDir = path.dirname(outfile);

        for (const [name, source] of sources) {
          await copyFile(source, path.join(outputDir, name));
        }
      });
    },
  };
}

/**
 * Rewrites `NextNodeServer.getMiddlewareManifest` so it stops reading
 * `.next/server/middleware-manifest.json` at runtime, and hands Prisma the
 * query compiler the Worker entry imported as a `WebAssembly.Module`.
 *
 * The manifest read is `require(this.middlewareManifestPath)`, a require of an
 * absolute path computed at runtime, which esbuild cannot resolve and workerd
 * cannot perform from a filesystem it does not have. Next calls it on every
 * request (through `getMiddleware` and `getEdgeFunctionsPages`), so without this
 * every route answers 500:
 *
 *   Error: Dynamic require of "/.next/server/middleware-manifest.json" is not supported
 *
 * The adapter inlines `loadManifest` for the same reason, but not this method,
 * and the upstream `main` branch has no patch for it either. Returning `null`
 * is the state a build with no middleware already reports through `minimalMode`,
 * which is what this app is: Workers cannot run Node middleware, so it has none.
 * A future Node-middleware file would silently stop running here — the same
 * outcome the adapter's own disabled `loadNodeMiddleware` gives it.
 *
 * Prisma's `decodeBase64AsWasm` compiles the compiler with
 * `new WebAssembly.Module(bytes)`, which workerd refuses outright ("Wasm code
 * generation disallowed by embedder"). The compile call is replaced with the
 * module `cloudflare/worker.ts` imported through `?module`, which the platform
 * compiles at deploy time. Prisma is only in the server bundle, so a bundle
 * without that function is left alone.
 *
 * Both rewrites happen on the emitted bundle rather than through `onLoad` hooks
 * on `next/dist/server/next-server.js` or the generated client: the adapters
 * resolve those through their own plugins, so a load hook on their paths never
 * runs. The bundle is the one artefact every path agrees on.
 */
function patchServerBundle(outfile) {
  return {
    name: "onemail-next-server-manifest",
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;

        const bundle = await readFile(outfile, "utf-8");
        // esbuild renames the CommonJS `require` it cannot statically resolve
        // (`__require`, `__require2`, …), so match whatever prefix it chose.
        let patched = bundle.replaceAll(
          /[A-Za-z0-9_$]*require\(this\.middlewareManifestPath\)/g,
          "null",
        );

        if (bundle.includes("query_compiler")) {
          const prismaCompile =
            /(from\(\w+,\s*"base64"\);\s*return\s*)new WebAssembly\.Module\(\w+\)/g;
          const calls = patched.match(prismaCompile)?.length ?? 0;

          if (calls === 0) {
            throw new Error(
              `Prisma is bundled in ${outfile} but its base64 compile call was not found. The rewrite in scripts/cloudflare-esbuild-shim.mjs needs updating.`,
            );
          }

          patched = patched.replaceAll(
            prismaCompile,
            "$1globalThis.__prismaQueryCompiler",
          );
        }

        if (patched === bundle) return;

        await writeFile(outfile, patched);
      });
    },
  };
}

export const build = (options) => real.build(withCloudflareDefaults(options));
export const buildSync = (options) =>
  real.buildSync(withCloudflareDefaults(options, false));
export const context = (options) =>
  real.context(withCloudflareDefaults(options));

export const transform = real.transform;
export const transformSync = real.transformSync;
export const formatMessages = real.formatMessages;
export const formatMessagesSync = real.formatMessagesSync;
export const analyzeMetafile = real.analyzeMetafile;
export const analyzeMetafileSync = real.analyzeMetafileSync;
export const version = real.version;
export const initialize = real.initialize;
export const stop = real.stop;
export default real.default ?? real;
