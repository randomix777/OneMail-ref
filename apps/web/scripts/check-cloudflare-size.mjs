import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const limit = 64 * 1024 * 1024;
const directories = process.argv.slice(2);
if (directories.length === 0)
  throw new Error("Provide the Wrangler bundle directories");

for (const directory of directories) {
  const bytes = await bundleBytes(directory);
  const size = (bytes / 1024 / 1024).toFixed(2);
  console.log(`${directory}: ${size} MiB / 64 MiB`);
  if (bytes > limit)
    throw new Error(`Worker bundle ${directory} exceeds 64 MiB`);
}

/** @param {string} directory @returns {Promise<number>} */
async function bundleBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith(".map") || entry.name === "README.md") continue;
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory()
      ? await bundleBytes(file)
      : (await stat(file)).size;
  }
  return bytes;
}
