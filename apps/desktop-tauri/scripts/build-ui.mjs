// Builds the renderer bundle the Tauri shell serves.
//
// The source lives in `apps/desktop-tauri/ui-src`; this script does not read or
// build anything from the legacy Electron package.
//
// Two Tauri differences: the bundle holds no Electron preload, so the shell
// injects `ui/init.js` as a webview initialization script instead, and the
// document-level CSP is dropped because `tauri.conf.json` sends the same policy
// as a header.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import {
  buildMailUiCss,
  withMailUiStylesheet,
} from "./mail-ui-css.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const outDir = resolve(appDir, "dist/ui");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await buildMailUiCss({ outFile: join(outDir, "mail-ui.css") });

await esbuild.build({
  absWorkingDir: appDir,
  entryPoints: ["ui-src/main.tsx"],
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
  await readFile(join(appDir, "ui-src/index.html"), "utf8"),
);
await writeFile(
  indexPath,
  html.replace(
    /[^\S\n]*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>\s*?\n/iu,
    "",
  ),
);

console.log(`Tauri UI bundle ready at ${outDir}`);
