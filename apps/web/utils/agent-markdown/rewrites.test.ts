import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKDOWN_PAGES, markdownRewrites } from "./rewrites";

const APP_DIR = path.resolve(import.meta.dirname, "../../app");

/**
 * Next wraps `has.value` into `^(?:<value>)$` and tests the raw header value, so
 * the contract is checked the same way instead of trusting the pattern by eye.
 */
function matchesAcceptRequest(value: string, accept: string | undefined) {
  if (accept === undefined) {
    return false;
  }

  return new RegExp(`^(?:${value})$`).test(accept);
}

function acceptMatcherFor(source: string) {
  const rewrite = markdownRewrites().find((entry) => entry.source === source);
  const matcher = rewrite?.has?.[0];

  if (!matcher) {
    throw new Error(`${source} has no accept matcher`);
  }

  return (accept: string | undefined) =>
    matchesAcceptRequest(matcher.value, accept);
}

describe("markdown rewrites", () => {
  it("answers a client that lists markdown", () => {
    const accepts = acceptMatcherFor("/");

    for (const accept of [
      "text/markdown",
      "text/markdown, text/html;q=0.8",
      "text/markdown; charset=utf-8",
      "text/html;q=0.5, text/markdown;q=0.9",
    ]) {
      expect(accepts(accept), accept).toBe(true);
    }
  });

  it("leaves a browser on the HTML page", () => {
    const accepts = acceptMatcherFor("/");

    for (const accept of [
      undefined,
      "text/html",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "*/*",
    ]) {
      expect(accepts(accept), String(accept)).toBe(false);
    }
  });

  it("only rewrites the pages that have a markdown document", () => {
    expect(markdownRewrites().map((entry) => entry.source)).toEqual(
      MARKDOWN_PAGES.map((page) => page.path),
    );
  });

  it("points every page at a markdown route that exists", () => {
    for (const { destination, path: pagePath } of MARKDOWN_PAGES) {
      expect(destination.endsWith(".md"), destination).toBe(true);
      expect(
        existsSync(path.join(APP_DIR, destination, "route.ts")),
        `${pagePath} -> ${destination}`,
      ).toBe(true);
    }
  });
});
