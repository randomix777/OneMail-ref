import { readFile } from "node:fs/promises";
import { parseConfigFileTextToJson } from "typescript";

const file = new URL("../wrangler.jsonc", import.meta.url);
const parsed = parseConfigFileTextToJson(
  file.pathname,
  await readFile(file, "utf8"),
);
if (parsed.error) throw new Error("Invalid wrangler.jsonc");
/** @type {unknown} */
const configuration = parsed.config;
if (!isRecord(configuration))
  throw new Error("Worker configuration must be an object");
/** @type {unknown[]} */
const hyperdrives = Array.isArray(configuration.hyperdrive)
  ? configuration.hyperdrive
  : [];
const configured = hyperdrives.some(
  (binding) =>
    isRecord(binding) &&
    binding.binding === "HYPERDRIVE" &&
    typeof binding.id === "string" &&
    /^[a-f0-9]{32}$/i.test(binding.id),
);
if (!configured) {
  throw new Error(
    "Configure a real HYPERDRIVE binding in apps/web/wrangler.jsonc before deploying. See docs/hosting/cloudflare-workers.mdx.",
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
