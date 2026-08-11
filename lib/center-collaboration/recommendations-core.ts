/**
 * Pure, DB-free core shared by `scripts/cancer-center-collaboration-
 * recommendations.ts` (v1, PubMed-collaboration-only CLI/CSV) and
 * `etl/cancer-center-collab-report/index.ts` (v2 weekly precompute, adds the
 * cancer-relevance axis + the full-time-faculty candidate universe). Pulled
 * out so the two callers cannot drift on what "collaboration with the
 * center" means — same functions, same answer either way.
 *
 * `buildPmidIndex`/`buildGroups`/`centerMetrics`/`splitName`/`pct` are lifted
 * verbatim from the v1 script (#2331). `computeCollabCandidateMetrics` is new
 * for v2: the one function that turns (candidate universe, their post-cutoff
 * authorship, a cancer-relevance predicate) into the raw per-person numbers
 * the weekly step persists — no threshold classification here, that's the
 * Reports tab's slider, applied at request time against these stored counts.
 */
import {
  buildProgramEdges,
  computeCoPubCounts,
  type ProgramEdge,
} from "@/lib/center-collaboration/graph";
import type { CollabGroup } from "@/lib/center-collaboration/types";

/** v1's CLI default and v2's weekly-step cutoff — one constant so a future
 *  change can't update one caller and silently miss the other. */
export const DEFAULT_CUTOFF_YEAR = 2016;

// ponytail: starting points, not a scoring rubric — tune once real output is
// seen. Shared so v1's CLI, the v2 Reports tab's default slider position, and
// any future caller read the SAME starting threshold rather than three
// hand-copied numbers drifting apart.
export const REMOVE_THRESHOLD = 0; // active research member exactly at this count → REMOVE
export const ADD_THRESHOLD = 2; // non-member faculty at/above this count → ADD (collaborator + relevant)

export type AuthorRow = { pmid: string; cwid: string };

/** Index authorship rows by pmid → the set of member indices on that pmid,
 *  restricted to (and index-mapped through) the given cwid→index table. Rows
 *  for a cwid outside the table are dropped. */
export function buildPmidIndex(
  rows: AuthorRow[],
  indexByCwid: Map<string, number>,
): Map<string, Set<number>> {
  const byPmid = new Map<string, Set<number>>();
  for (const r of rows) {
    const idx = indexByCwid.get(r.cwid);
    if (idx === undefined) continue;
    let s = byPmid.get(r.pmid);
    if (!s) byPmid.set(r.pmid, (s = new Set()));
    s.add(idx);
  }
  return byPmid;
}

/** `CollabGroup[]` from a pmid index — the shape `graph.ts`'s pure edge/rollup
 *  helpers consume. */
export function buildGroups(byPmid: Map<string, Set<number>>): CollabGroup[] {
  return [...byPmid.values()].map((s) => ({
    m: [...s].sort((a, b) => a - b),
    year: null,
  }));
}

export type CenterMetrics = {
  totalPapers: number;
  intraPapers: number;
  interPapers: number;
  perProgramIntra: Map<string, number>;
  programEdges: ProgramEdge[];
};

/** Center-level intra/inter-program split, via the shared-tab's edge builder. */
export function centerMetrics(
  groups: CollabGroup[],
  programOf: (idx: number) => string | null,
): CenterMetrics {
  const totalPapers = groups.filter((g) => g.m.length >= 2).length;
  const { internal, edges } = buildProgramEdges(groups, programOf);
  let intraPapers = 0;
  for (const n of internal.values()) intraPapers += n;
  return { totalPapers, intraPapers, interPapers: totalPapers - intraPapers, perProgramIntra: internal, programEdges: edges };
}

/** "Given ... Last" → { given, surname } by last-token split. `Scholar` has no
 *  authoritative first/last split (only `preferredName`/`fullName`), so this
 *  is a display heuristic, not a canonical field. */
export function splitName(preferredName: string): { given: string; surname: string } {
  const tokens = preferredName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { given: "", surname: "" };
  return { given: tokens.slice(0, -1).join(" "), surname: tokens[tokens.length - 1] };
}

export function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((1000 * n) / d) / 10;
}

// --- v2: candidate-universe metrics -------------------------------------

export type CollabUniverseMember = {
  cwid: string;
  /** Active `CenterMembership` with `membershipType === "research"` — v1's
   *  exact REMOVE-eligible population. A person who is a member under some
   *  OTHER type is neither a research member here nor a fresh candidate
   *  (they're already on the roster) — the caller excludes them from the
   *  universe entirely rather than growing a third bucket this table has no
   *  column for. */
  isResearchMember: boolean;
  programCode: string | null;
};

export type CollabAuthorRow = AuthorRow & { meshUis: string[] };

export type CollabCandidateMetrics = {
  cwid: string;
  totalPapersPostCutoff: number;
  collaborationsWithCenter: number;
  cancerRelatedPapers: number;
  isCurrentMember: boolean;
  currentProgramCode: string | null;
};

/**
 * Raw per-person numbers for the v2 Reports tab — no REMOVE/ADD/recruit
 * classification here; that's threshold filtering the UI applies at request
 * time against these already-computed counts.
 *
 * `collaborationsWithCenter` for a research member comes from `computeCoPubCounts`
 * (co-occurrence with ANOTHER research member on the same pmid — counting a
 * member's own solo papers would be wrong). Everyone else uses a simpler
 * check: do any of their own post-cutoff pmids also carry a research member's
 * authorship? Both answer the same question ("did this person co-author with
 * an active research member of the center"); the two paths exist because a
 * member's own membership can't be used to detect their own co-authorship.
 */
export function computeCollabCandidateMetrics(
  universe: CollabUniverseMember[],
  authorRows: CollabAuthorRow[],
  isCancerRelated: (meshUis: string[]) => boolean,
): CollabCandidateMetrics[] {
  const researchMembers = universe.filter((u) => u.isResearchMember);
  const indexByCwid = new Map(researchMembers.map((m, i) => [m.cwid, i]));
  const researchRows = authorRows.filter((r) => indexByCwid.has(r.cwid));
  const pmidToMemberIdxs = buildPmidIndex(researchRows, indexByCwid);
  const memberGroups = buildGroups(pmidToMemberIdxs);
  const memberCollab = computeCoPubCounts(memberGroups, researchMembers.length);
  const pmidsWithMember = new Set(pmidToMemberIdxs.keys());

  const rowsByCwid = new Map<string, CollabAuthorRow[]>();
  for (const r of authorRows) {
    const arr = rowsByCwid.get(r.cwid) ?? [];
    arr.push(r);
    rowsByCwid.set(r.cwid, arr);
  }

  return universe.map((u) => {
    const rows = rowsByCwid.get(u.cwid) ?? [];
    // pmid-deduped, same as cancerPmids/collab below — `PublicationAuthor` has
    // no DB-unique on (pmid, cwid) (etl/reciter/change-detection.ts's own
    // reconcile treats a duplicate row as a known, real state), so counting
    // raw rows here would inflate this denominator while the other two stay
    // deduped, silently deflating every percent-mode threshold.
    const totalPmids = new Set(rows.map((r) => r.pmid));
    const cancerPmids = new Set(rows.filter((r) => isCancerRelated(r.meshUis)).map((r) => r.pmid));
    const idx = indexByCwid.get(u.cwid);
    const collab =
      idx !== undefined
        ? memberCollab[idx]
        : new Set(rows.map((r) => r.pmid).filter((p) => pmidsWithMember.has(p))).size;
    return {
      cwid: u.cwid,
      totalPapersPostCutoff: totalPmids.size,
      collaborationsWithCenter: collab,
      cancerRelatedPapers: cancerPmids.size,
      isCurrentMember: u.isResearchMember,
      currentProgramCode: u.isResearchMember ? u.programCode : null,
    };
  });
}
