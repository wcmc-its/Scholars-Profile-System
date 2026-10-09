/**
 * Issue #2215 — notice shown above a People / Publications result list when the
 * exact query matched nothing and the rows come from the typo-tolerant fuzzy
 * retry (`SEARCH_TYPO_FALLBACK`, `result.typoFallback === true`). Without it a
 * fuzzy list would read as exact matches for a word that appears in none of
 * them.
 *
 * Server Component — purely presentational, no hooks. `role="status"` so the
 * swap from "no results" to similar-spelling results is announced.
 */
export function TypoFallbackNotice({
  query,
  noun,
}: {
  /** The user's query, verbatim. */
  query: string;
  /** What the list holds, for the sentence ("people" / "publications"). */
  noun: "people" | "publications";
}) {
  return (
    <p
      role="status"
      data-testid="typo-fallback-notice"
      className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground"
    >
      No exact matches for{" "}
      <span className="font-medium text-[#4a4a4a]">&ldquo;{query.trim()}&rdquo;</span>
      {" "}&mdash; showing {noun} with similar spellings.
    </p>
  );
}
