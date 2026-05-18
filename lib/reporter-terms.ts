/**
 * RePORTER project-term parsing (issue #291).
 *
 * NIH RePORTER's `/projects/search` returns two NIH-curated keyword
 * vocabularies per project, captured raw into `reciterdb.grant_reporter_project`
 * by ReCiterDB's `retrieveReporter.py`:
 *
 *   - `pref_terms`   — the modern vocabulary, `;`-delimited:
 *                      `"Adult;Alternative Splicing;Bar Codes;..."`
 *   - `project_terms` (RePORTER `terms`) — the legacy vocabulary, each term
 *                      angle-bracket-wrapped: `"<Adult><Adult Human><Bar Codes>..."`
 *
 * `parseReporterTerms` normalizes whichever is available into a deduped,
 * lowercased keyword array for `Grant.keywords`. Pure (no I/O), so the reporter
 * ETL and its unit tests both import it directly — the ETL module itself runs
 * `main()` on import and can't be imported from a test.
 */

/**
 * Max keywords stored per grant. RePORTER `terms` can run to 100+ entries;
 * this caps the funding doc's keyword payload (issue #291 OQ2). Applied after
 * trim/lowercase/dedupe, keeping RePORTER's returned order.
 */
export const MAX_GRANT_KEYWORDS = 50;

/**
 * Normalize RePORTER project terms into a keyword array for `Grant.keywords`.
 *
 * Prefers `pref_terms` (cleaner, less check-tag noise — issue #291 OQ1) and
 * falls back to `terms` for older awards that carry only it. Each term is
 * trimmed, lowercased, and de-duped (first occurrence wins); the result is
 * capped at {@link MAX_GRANT_KEYWORDS}. Returns `null` when neither field
 * yields a usable term — the caller stores `null`, never `[]`.
 *
 * @param prefTerms raw `pref_terms` string (`;`-delimited) or null/undefined
 * @param terms     raw `terms` string (`<a><b>`-wrapped) or null/undefined
 */
export function parseReporterTerms(
  prefTerms: string | null | undefined,
  terms: string | null | undefined,
): string[] | null {
  const fromPref = (prefTerms ?? "").split(";");
  const fromTerms = Array.from(
    (terms ?? "").matchAll(/<([^>]*)>/g),
    (m) => m[1],
  );
  // `pref_terms` wins whenever it carries at least one non-empty entry.
  const source = fromPref.some((t) => t.trim().length > 0)
    ? fromPref
    : fromTerms;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of source) {
    const norm = term.trim().toLowerCase();
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= MAX_GRANT_KEYWORDS) break;
  }
  return out.length > 0 ? out : null;
}
