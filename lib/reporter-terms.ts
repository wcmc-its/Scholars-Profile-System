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
 * Max keywords stored per grant — a guard against a pathological upstream,
 * not a relevance filter.
 *
 * Was 50 (issue #291 OQ2), which was doing real damage. Measured against live
 * RePORTER on six on-disease grants (2026-08-04): `pref_terms` runs 89-124
 * entries and `terms` 201-288, and RePORTER returns them in no useful order —
 * not alphabetical, not by relevance. The MeSH descriptor name that makes a
 * grant resolvable to its disease sat at union index 98 and 131 on the two
 * awards that carry one, so a 50-cap cut precisely the term the whole pipeline
 * exists to find.
 *
 * 500 clears the observed maximum with headroom. It is deliberately still a
 * cap: an unbounded upstream array would flow into `Grant.keywords`, the
 * OpenSearch `keywordsText` field, and the resolver pass with no ceiling at
 * all. Downstream noise is handled by STOPWORD_TERMS in `etl/reporter/mesh.ts`,
 * not by truncation — truncation cannot distinguish noise from signal, and at
 * 50 it was removing more signal than noise.
 */
export const MAX_GRANT_KEYWORDS = 500;

/**
 * Normalize RePORTER project terms into a keyword array for `Grant.keywords`.
 *
 * Takes the UNION of both vocabularies, `pref_terms` first, de-duped. Each
 * term is trimmed, lowercased, and de-duped (first occurrence wins); the
 * result is capped at {@link MAX_GRANT_KEYWORDS}. Returns `null` when neither
 * field yields a usable term — the caller stores `null`, never `[]`.
 *
 * #2182 — this used to prefer `pref_terms` whenever it held one non-empty
 * entry and discard `terms` entirely. `pref_terms` is RCDC/UMLS vocabulary and
 * carries NO MeSH neoplasm descriptor names; `terms` carries `Breast
 * Neoplasms` and the `Breast Cancer` / `Prostate Cancer` entry terms the MeSH
 * resolver matches on. Since `resolveGrantKeywords` does an exact normalized
 * lookup, discarding `terms` meant an on-disease grant stored
 * `malignant breast neoplasm` and resolved to nothing. Measured: 7 of 16
 * already-enriched grants across four investigators were on-disease and
 * resolved to zero descriptors.
 *
 * `pref_terms` stays first because it is NIH's curated preferred set and the
 * cap, if it ever binds, should bind on the legacy field.
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
  // Union, not either/or: the two vocabularies overlap heavily but only
  // `terms` carries MeSH descriptor and entry-term names.
  const source = [...fromPref, ...fromTerms];

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
