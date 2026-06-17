/**
 * Pure ranking core for the method-badge hover exemplar (Variant 2 of
 * `docs/search-snippet-handoff.md` §7). Given the candidate publications for a
 * scholar's matched method FAMILY, pick the ONE most-representative paper.
 *
 * Why family-level, not per-tool (the original §7 "Variant 3"): the gate
 * (2026-06-16) found per-(scholar, tool)→PMID data is unreachable at request
 * time — `scholar_tool.pmids` is written `[]` by the active S3 loader and the
 * displayed tool DISPLAY NAMES don't key into the legacy DynamoDB `TOOL#` slug,
 * which the app can't reach anyway. `scholar_family.pmids` IS populated (100% on
 * staging, `len == pmid_count`) and request-time readable, so the hover keys at
 * the family level: one representative paper for the matched family.
 *
 * Pure + side-effect-free (no DB / no `server-only`) so the ranking is
 * unit-testable without a DB, mirroring the other pure mappers (e.g.
 * `etl/dynamodb/scholar-tool-mapper.ts`). The impure loader that assembles the
 * candidates lives in `lib/api/method-exemplar.ts`.
 */
import type { EvidencePub } from "@/lib/api/result-evidence";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";

/** Publication-type string that marks original research (the spotlight/ranking
 *  convention — `lib/api/spotlight.ts`, `lib/ranking.ts`). Used as the TOP sort
 *  key so an original outranks a review/preprint when one exists, WITHOUT hard-
 *  dropping non-originals (a family that is all reviews still yields its best). */
export const ORIGINAL_RESEARCH_TYPE = "Academic Article";

/** Corrections (`Retraction`, `Erratum`) are never original scholarship and must
 *  never be surfaced — the one HARD exclusion (matches `NEVER_DISPLAY_TYPES`,
 *  already excluded from the publications index). */
const NEVER_DISPLAY = new Set<string>(NEVER_DISPLAY_TYPES);

/** One candidate paper for the (scholar, family) exemplar pick. */
export type ExemplarCandidate = {
  pmid: string;
  title: string;
  year: number | null;
  publicationType: string | null;
  /** ReCiterAI GPT-rubric impact (0–100), global per-pmid; null when unscored.
   *  Independent of `citationCount` (not citation-derived), so the two are
   *  separate sort keys, not a double-count. */
  impactScore: number | null;
  citationCount: number;
  /** This scholar is first OR senior (last / sole) author on the pub. */
  isFirstOrSenior: boolean;
};

/** Age-normalized citations (citations per year since publication). 0 when the
 *  year is unknown so an undated pub never wins this tier on a divide-by-small. */
function citationsPerYear(c: ExemplarCandidate, currentYear: number): number {
  if (c.year == null) return 0;
  return c.citationCount / Math.max(1, currentYear - c.year + 1);
}

/**
 * Rank the candidate set and return the single best exemplar (handoff §7
 * `argmax`, lexicographic — each key breaks ties of the one above):
 *   1. original research first  (Academic Article ▸ review/preprint/other)
 *   2. first/senior ownership   (the scholar's own paper ▸ middle-author)
 *   3. curated impact           (impactScore desc, nulls last)
 *   4. citations-per-year       (age-normalized, independent of impactScore)
 *   5. recency                  (newer year)
 *   6. pmid                     (stable deterministic tiebreak)
 * Line 5's per-(sub)topic relevance from §7 is OMITTED for the method path (no
 * per-pub-per-topic signal in the data — see handoff §7 "Index reality").
 * Returns null only when nothing renderable survives (empty title / corrections).
 */
/**
 * The candidates a representative-paper surface may actually show: a non-empty
 * title and not a correction (Retraction / Erratum, `NEVER_DISPLAY_TYPES`).
 * Exported so the loader's "+N more" total counts the SAME renderable set the
 * ranker slices from, not the raw candidate rows (which can include corrections /
 * untitled stubs the profile would never list).
 */
export function filterRenderableExemplars(
  candidates: ExemplarCandidate[],
): ExemplarCandidate[] {
  return candidates.filter(
    (c) =>
      c.title.trim().length > 0 &&
      !(c.publicationType != null && NEVER_DISPLAY.has(c.publicationType)),
  );
}

export function rankMethodExemplarList(
  candidates: ExemplarCandidate[],
  currentYear: number,
  limit = 3,
): EvidencePub[] {
  const pool = filterRenderableExemplars(candidates);
  if (pool.length === 0) return [];

  pool.sort((a, b) => {
    const ao = a.publicationType === ORIGINAL_RESEARCH_TYPE ? 1 : 0;
    const bo = b.publicationType === ORIGINAL_RESEARCH_TYPE ? 1 : 0;
    if (ao !== bo) return bo - ao;

    if (a.isFirstOrSenior !== b.isFirstOrSenior) return a.isFirstOrSenior ? -1 : 1;

    const ai = a.impactScore ?? -1;
    const bi = b.impactScore ?? -1;
    if (ai !== bi) return bi - ai;

    const ac = citationsPerYear(a, currentYear);
    const bc = citationsPerYear(b, currentYear);
    if (ac !== bc) return bc - ac;

    const ay = a.year ?? -1;
    const by = b.year ?? -1;
    if (ay !== by) return by - ay;

    return a.pmid.localeCompare(b.pmid);
  });

  return pool.slice(0, Math.max(0, limit)).map((c) => ({
    pmid: c.pmid,
    title: c.title,
    year: c.year ?? null,
  }));
}

/**
 * Back-compat single-paper pick — the top of {@link rankMethodExemplarList}, or
 * null when nothing renderable survives. Kept so the existing one-paper callers
 * (and `method-exemplar-rank.test.ts`) are unchanged.
 */
export function rankMethodExemplar(
  candidates: ExemplarCandidate[],
  currentYear: number,
): EvidencePub | null {
  return rankMethodExemplarList(candidates, currentYear, 1)[0] ?? null;
}
