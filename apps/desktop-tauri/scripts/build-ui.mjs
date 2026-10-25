// Builds the renderer bundle the Tauri shell serves.
//
// The React renderer source still lives in `apps/desktop/src/renderer` while the
// migration is in progress, but this script builds only that renderer. It does
// not build or depend on the Electron main/preload bundles.
//
// Two Tauri differences: the bundle holds no Electron preload, so the shell
// injects `ui/init.js` as a webview initialization script instead, and the
// document-level CSP is dropped because `tauri.conf.json` sends the same policy
// as a header.
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMailUiCss,
  withMailUiStylesheet,
} from "../../desktop/scripts/mail-ui-css.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const desktopDir = resolve(appDir, "../desktop");
const outDir = resolve(appDir, "dist/ui");
const desktopRequire = createRequire(join(desktopDir, "package.json"));
const esbuild = desktopRequire("esbuild");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await buildMailUiCss({ outFile: join(outDir, "mail-ui.css") });

await esbuild.build({
  absWorkingDir: desktopDir,
  entryPoints: ["src/renderer/main.tsx"],
  outfile: join(outDir, "main.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
});

const indexPath = join(outDir, "index.html");
const html = withMailUiStylesheet(
  await readFile(join(desktopDir, "src/renderer/index.html"), "utf8"),
);
await writeFile(
  indexPath,
  html.replace(
    /[^\S\n]*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>\s*?\n/iu,
    "",
  ),
);

console.log(`Tauri UI bundle ready at ${outDir}`);
