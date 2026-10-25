import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";

// Builds the optional MCP mail client UI when its source is installed.
const builder = new URL("../mcp-app/build.mjs", import.meta.url);
if (existsSync(builder)) await import(builder.href);

// Workers serves runtime resources through its ASSETS binding, not a filesystem.
const source = new URL("../generated/mcp-app/mail.html", import.meta.url);
const destination = new URL("../public/_mcp/mail.html", import.meta.url);
if (existsSync(source)) {
  await mkdir(new URL("../public/_mcp/", import.meta.url), { recursive: true });
  await copyFile(source, destination);
} else {
  await rm(destination, { force: true });
}
