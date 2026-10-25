// Builds the renderer bundle the Tauri shell serves.
//
// The renderer is still produced by `apps/desktop/esbuild.config.mjs` so both
// shells ship byte-identical UI code while the migration runs. Two differences:
// the bundle holds no Electron preload, so the shell injects `ui/init.js` as a
// webview initialization script instead, and the document-level CSP is dropped
// because `tauri.conf.json` already sends the same policy as a header.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repoRoot = resolve(appDir, "../..");
const rendererDir = resolve(appDir, "../desktop/dist/renderer");
const outDir = resolve(appDir, "dist/ui");

execFileSync("pnpm", ["--filter", "@inboxzero/desktop", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(rendererDir, outDir, { recursive: true });

const indexPath = join(outDir, "index.html");
const html = await readFile(indexPath, "utf8");
await writeFile(
  indexPath,
  html.replace(
    /[^\S\n]*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>\s*?\n/iu,
    "",
  ),
);

console.log(`Tauri UI bundle ready at ${outDir}`);
