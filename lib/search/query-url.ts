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

/** `/search?q=<q>` with the #1954 rewrite applied. */
export function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(searchQueryForUrl(q))}`;
}
