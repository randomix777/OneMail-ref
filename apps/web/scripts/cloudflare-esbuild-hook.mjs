// @opennextjs/cloudflare imports "esbuild" from its CLI bundle without declaring
// it as a dependency. That resolves under npm because dependencies are hoisted,
// but in this pnpm workspace the package lives in the global virtual store, where
// apps/web/node_modules is not an ancestor. Registering this hook resolves
// esbuild as if the adapter had imported it from the app, and points it at a
// shim that applies the Cloudflare-specific bundling defaults.
import { createRequire, register } from "node:module";

const APP_PACKAGE_URL = new URL("../package.json", import.meta.url).href;
const REAL_ESBUILD_PATH = createRequire(APP_PACKAGE_URL).resolve("esbuild");
const SHIM_URL = new URL("./cloudflare-esbuild-shim.mjs", import.meta.url).href;

process.env.ONEMAIL_CLOUDFLARE_REAL_ESBUILD = REAL_ESBUILD_PATH;

register(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "esbuild") {
    return { url: SHIM_URL, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
