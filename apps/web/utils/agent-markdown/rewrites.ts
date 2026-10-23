/**
 * The pages that have a markdown representation, and where that representation
 * lives. Both URLs are public: the rewrite below makes `/` and `/pricing`
 * answer an agent client with markdown, and the `.md` path is the stable URL a
 * crawler can fetch directly.
 */
export const MARKDOWN_PAGES = [
  { destination: "/index.md", path: "/" },
  { destination: "/pricing.md", path: "/pricing" },
] as const;

/**
 * Rewrites that answer a request whose `Accept` lists markdown with the
 * markdown document instead of the page.
 *
 * These belong in `beforeFiles`: a bare array return value is applied after the
 * filesystem check, so the page would win and the rewrite would look broken.
 *
 * The rewrite table is coarser than the proxy it replaced, in three ways worth
 * knowing. `has.value` is a bare regular expression, so the media type is
 * matched case sensitively, in the lowercase form the registry defines, and an
 * explicit `q=0` refusal is not distinguished. A rewrite cannot match on the
 * method, so a `POST` to these paths carrying the header is rewritten too. And
 * because a rewrite cannot add response headers, the HTML answer no longer
 * carries `Vary: Accept`; the `.md` URL is the canonical contract, and this
 * rewrite is a convenience for clients that ask for markdown at all.
 */
export function markdownRewrites() {
  return MARKDOWN_PAGES.map(({ destination, path }) => ({
    destination,
    has: [
      { key: "accept", type: "header" as const, value: ".*text/markdown.*" },
    ],
    source: path,
  }));
}
