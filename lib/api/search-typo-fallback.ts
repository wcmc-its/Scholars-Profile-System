/**
 * Issue #2215 — typo-tolerant ZERO-RESULT fallback (`SEARCH_TYPO_FALLBACK`).
 *
 * No query body on the search path sets `fuzziness`, so a single-character typo
 * (`oncolgy`, `cardiolgy`, a surname like `Harrigton`) returns zero results on
 * every tab. This module holds the pure pieces of the fix:
 *
 *   - `buildTypoFuzzyClause` — the fuzzy admission clause that REPLACES the
 *     primary text clause on the retry (People: name / title / dept / area /
 *     pub-title fields; Publications: title / authors / MeSH labels / journal).
 *   - `isTypoFallbackEligible` — which queries may retry at all.
 *   - `withTypoFallback` — the control flow: run the primary search unchanged;
 *     ONLY when it returns `total === 0` (and the flag is on and the query is
 *     eligible) run the fuzzy variant, and serve it — marked
 *     `typoFallback: true` — iff it found something.
 *
 * Why a zero-result FALLBACK and not fuzziness on the primary body: the primary
 * bodies are heavily tuned (cross_fields + msm ladders, function_score
 * prominence, concept admission) and `fuzziness` is not supported on
 * `cross_fields` / phrase queries anyway. Firing only on total=0 leaves every
 * query that returns results today byte-identical — ranking is untouched by
 * construction, so the flag needs no relevance re-baseline.
 *
 * Why not a term-suggester "Did you mean": every searchable text field is
 * analyzed with an English stemmer (`scholar_text`, `pub_text`), so a term
 * suggester over them proposes STEMS ("oncolog", "cardiolog") that cannot be
 * shown to a user; a presentable suggester needs a new unstemmed (shingle)
 * subfield and a reindex of both indexes. The fallback needs neither — it reads
 * existing fields at query time. A "Did you mean" can be layered on later.
 *
 * Stemming note: `fuzziness` on a `match` applies per ANALYZED query term, so
 * the edit distance is measured stem-to-stem (`oncolgy` → `oncolgi` vs the
 * indexed `oncolog`: 2 edits, inside AUTO's 2 for ≥6 chars). A typo that is 2
 * edits from the surface word can be 3 from the stem (`onclagy`) and stays a
 * zero — accepted; AUTO's distance cap is the precision guard.
 */

/**
 * Fuzzy parameters shared by every fallback clause.
 *
 *   - `fuzziness: "AUTO"` — 0 edits for terms ≤ 2 chars, 1 for 3–5, 2 for ≥ 6,
 *     so short tokens (initials, "md", "ca") are never fuzzed.
 *   - `prefix_length: 1` — the first character must match: typos are rarely in
 *     the first letter, and it cuts the term-dictionary walk by ~26×.
 *   - `max_expansions: 25` — at most 25 candidate terms per query term (default
 *     50), bounding the disjunction on the large publications term dictionary.
 *   - `fuzzy_transpositions: true` — `cardoilogy` (ab→ba) costs one edit.
 */
export const TYPO_FUZZY_PARAMS = {
  fuzziness: "AUTO",
  prefix_length: 1,
  max_expansions: 25,
  fuzzy_transpositions: true,
} as const;

/**
 * People-index fields the fallback matches on. Names lead (a typo'd surname is
 * the commonest people-tab zero), then the short descriptive fields, then the
 * pub-derived topical fields so a typo'd topic (`oncolgy`) still finds the
 * scholars the exact word would. Deliberately EXCLUDED: `cwid` / keyword ids
 * (fuzzing an id matches a different person), `overview` and
 * `publicationAbstracts` (long prose — a fuzzy term lands on noise there).
 * Every listed field is `text` with the `scholar_text` analyzer.
 */
export const PEOPLE_TYPO_FALLBACK_FIELDS: readonly string[] = [
  "preferredName^10",
  "fullName^10",
  "primaryTitle^4",
  "primaryDepartment^4",
  "areasOfInterest^3",
  "publicationMesh^2",
  "publicationTitles^1",
];

/**
 * Publications-index fields the fallback matches on — the
 * `PUBLICATION_FIELD_BOOSTS` set minus `abstract` (long prose; fuzzy expansion
 * there admits off-topic papers by an incidental near-miss word). Keyword ids
 * (`pmid`, `doi`, `meshDescriptorUi`) are never fuzzed.
 */
export const PUBLICATION_TYPO_FALLBACK_FIELDS: readonly string[] = [
  "title^4",
  "meshTerms^2",
  "authorNames^2",
  "journal^1",
];

/**
 * The fuzzy admission clause. `best_fields` (the multi_match type that supports
 * `fuzziness`; `cross_fields` / `phrase` do not) with `operator: "and"`: every
 * query term must (fuzzily) appear in ONE field, so a multi-word typo query
 * stays as precise as the user's words — the fallback widens spelling, never
 * the term set.
 */
export function buildTypoFuzzyClause(
  query: string,
  fields: readonly string[],
): Record<string, unknown> {
  return {
    multi_match: {
      query,
      fields: [...fields],
      type: "best_fields",
      operator: "and",
      ...TYPO_FUZZY_PARAMS,
    },
  };
}

/** Upper bound on query terms the fallback will fuzz (each term expands up to
 *  `max_expansions`; a pasted abstract is not a typo). */
export const TYPO_FALLBACK_MAX_TERMS = 6;

// Single-token identifiers: a numeric id (PMID), a CWID-shaped token
// (letters + digits, e.g. `abc2001`), a PMCID, or a DOI. Fuzzing these
// resolves to a DIFFERENT record — never a helpful "similar spelling".
const ID_LIKE = /^(?:\d+|[a-z]{2,4}\d{3,5}|pmc\d+|10\.\d{4,}\/\S+)$/i;

/**
 * May this query retry fuzzily? Requires a non-empty query of at most
 * `TYPO_FALLBACK_MAX_TERMS` terms, not a bare identifier, with at least one term
 * of ≥ 3 letters/digits (AUTO fuzziness leaves ≤ 2-char terms exact, so a
 * query made only of those would just re-run the zero).
 */
export function isTypoFallbackEligible(q: string): boolean {
  const t = q.trim();
  if (t.length === 0) return false;
  const terms = t.split(/\s+/);
  if (terms.length > TYPO_FALLBACK_MAX_TERMS) return false;
  if (terms.length === 1 && ID_LIKE.test(t)) return false;
  return terms.some((term) => term.replace(/[^\p{L}\p{N}]/gu, "").length >= 3);
}

/**
 * Run `primary`; when it is empty, the flag is on, and the query is eligible,
 * run `fuzzy` and serve it (marked `typoFallback: true`) if it found anything.
 * Otherwise the primary result is returned untouched — the SAME object, so a
 * non-empty or flag-off search is byte-identical to today.
 *
 * A fuzzy-path failure (e.g. a cluster-side `too_many_clauses`) degrades to the
 * primary zero rather than failing a search that already succeeded.
 */
export async function withTypoFallback<R extends { total: number; typoFallback?: boolean }>(
  args: {
    enabled: boolean;
    q: string;
    corpus: "people" | "publications";
    primary: () => Promise<R>;
    fuzzy: () => Promise<R>;
  },
): Promise<R> {
  const first = await args.primary();
  if (!args.enabled || first.total > 0 || !isTypoFallbackEligible(args.q)) return first;
  let second: R;
  try {
    second = await args.fuzzy();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "search_typo_fallback_failed",
        corpus: args.corpus,
        qLen: args.q.length,
        error: String(err),
      }),
    );
    return first;
  }
  return second.total > 0 ? { ...second, typoFallback: true } : first;
}
