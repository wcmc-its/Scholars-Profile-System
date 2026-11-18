/**
 * #1954 — an edge appliance in front of CloudFront (outside this repo) 302s any
 * request whose query string holds the token `head` followed by `&` back to `/`,
 * so `/search?q=head%20%26%20neck` never reaches the app. Rewrite a standalone
 * `&` between two words to ` and ` wherever we build a `/search?q=` URL. Search
 * results are unchanged: the `scholar_text` analyzer drops both `&` (standard
 * tokenizer) and `and` (English stopword), and `normalizeForMatch` (MeSH
 * resolution) strips both too.
 */
export function searchQueryForUrl(q: string): string {
  return q.replace(/(\w)\s*&\s*(?=\w)/g, "$1 and ");
}

/**
 * Where a `/search?q=` link came from when the user did not type the term:
 * `chip` is a home-page "Try:" chip, `suggest` a MeSH concept picked from the
 * search-box typeahead. Carried as `&src=` so the nightly CloudFront usage
 * rollup can count suggestion clicks apart from typed searches (the access logs
 * see only the URL). Untagged means typed. The search page ignores the param
 * and drops it from every link it builds ({@link withoutSearchSource}), so it
 * marks only the click itself, never the paging/filtering that follows.
 * Keep in sync with SUGGESTED_SEARCH_SOURCES in
 * cdk/lambda/cf-usage-rollup/queries.ts.
 */
export const SEARCH_SOURCES = ["chip", "suggest"] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/** The query param that carries a {@link SearchSource}. */
export const SEARCH_SOURCE_PARAM = "src";

/** `/search?q=<q>` with the #1954 rewrite applied, tagged `&src=` when given. */
export function searchHref(q: string, source?: SearchSource): string {
  const href = `/search?q=${encodeURIComponent(searchQueryForUrl(q))}`;
  return source ? `${href}&${SEARCH_SOURCE_PARAM}=${source}` : href;
}

/** `sp` without the {@link SEARCH_SOURCE_PARAM} tag (for building onward links). */
export function withoutSearchSource<T extends Record<string, unknown>>(sp: T): T {
  if (!(SEARCH_SOURCE_PARAM in sp)) return sp;
  const out = { ...sp };
  delete out[SEARCH_SOURCE_PARAM];
  return out;
}
