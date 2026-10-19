#!/usr/bin/env node

/**
 * Mail Adapter Test Checker
 *
 * PROBLEM:
 * The mail transport adapters are the code that talks to a real mailbox, and they
 * are easy to leave untested because nothing forces a test to exist. The IMAP
 * provider reached ~1,000 lines with no test of its own; the folder-delta adapter
 * had 40 tests while being wired to nothing. Coverage totals hid both, because the
 * totals were fine.
 *
 * SOLUTION:
 * Every non-test module in the directories below must ship with a test beside it:
 * either `<name>.test.ts` or `<name>.<qualifier>.test.ts` (a provider can have one
 * test file per concern, such as `provider.client.test.ts`).
 *
 * USAGE:
 * - Manually: pnpm check-adapter-tests (from apps/web)
 * - CI/CD: runs with the other check-* scripts before the test suite
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKS = [
  {
    dir: "utils/imap",
    why: "IMAP is a real network protocol; a hand-rolled adapter needs its folder roles, flags and MIME mapping pinned.",
  },
];

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function testExists(directory, name) {
  const entries = readdirSync(directory);
  const exact = `${name}.test.ts`;
  if (entries.includes(exact)) return true;
  // `provider.client.test.ts` counts as a test for `provider.ts`.
  return entries.some(
    (entry) => entry.startsWith(`${name}.`) && entry.endsWith(".test.ts"),
  );
}

const violations = [];

for (const { dir, why } of CHECKS) {
  const directory = join(appRoot, dir);
  if (!existsSync(directory)) continue;

  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;

    const name = basename(entry, ".ts");
    if (!testExists(directory, name)) {
      violations.push({ file: join(dir, entry), why });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n${violations.length} mail adapter module(s) have no test beside them:\n`,
  );
  for (const { file, why } of violations) {
    console.error(`  ${file}`);
    console.error(`      ${why}`);
  }
  console.error(
    "\nAdd `<name>.test.ts` (or `<name>.<qualifier>.test.ts`) next to the module.\n",
  );
  process.exit(1);
}

// A checker that finds nothing because its globs broke looks exactly like a pass.
const checked = CHECKS.reduce(
  (total, { dir }) =>
    total +
    readdirSync(join(appRoot, dir)).filter(
      (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
    ).length,
  0,
);

if (checked === 0) {
  console.error(
    "\nNo adapter modules were found. The checker's paths are probably wrong.\n",
  );
  process.exit(1);
}

const packageJson = readFileSync(join(appRoot, "package.json"), "utf8");
if (!packageJson.includes("check-adapter-tests")) {
  console.warn(
    "warning: this checker is not referenced by package.json, so nothing runs it.",
  );
}

console.log(`Mail adapter tests: ${checked} module(s) checked, all covered.`);
