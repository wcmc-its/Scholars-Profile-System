/**
 * Shared server-side builders for the unit collaboration networks — the center
 * Collaboration tab (#1137, `center-collaboration.ts`) and the department
 * Collaboration tab (`department-collaboration.ts`).
 *
 * Both loaders resolve their own gated member set (`indexByCwid`: cwid → node
 * index) and hand it here; these helpers turn the raw authorship / grant rows
 * into the positional `CollabPaper` / `CollabAward` groups the browser builds
 * edges from. Server-only (reads `prisma`); never import from a client module.
 */
import { prisma } from "@/lib/db";
import {
  loadAllPublicationSuppressions,
  resolveActiveGrantSuppression,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import { isUmbrellaAward } from "@/lib/center-collaboration/grants";
import type { CollabAward, CollabPaper } from "@/lib/center-collaboration/types";

/** One confirmed authorship row, as the collaboration loaders select it. */
export type CollabAuthorRow = {
  pmid: string;
  cwid: string | null;
  publication: { year: number | null } | null;
};

/**
 * The publication suppressions that touch a collaboration network: the dark
 * pmids (whole-publication takedown or derived-dark) and the per-author hides,
 * restricted to pmids with ≥1 gated member authorship.
 *
 * Covers EVERY gated pmid, not just co-authored ones, so a suppressed paper
 * also leaves its authors' `pubCount` (a single-author takedown included).
 * Follows the #1505 inversion the unit publication rollups use: the active
 * suppression set is tiny, so read it whole and intersect in memory rather
 * than send a 50k–100k-pmid IN list for a large department. Derived-dark is
 * resolved only for the few pmids that carry a per-author hide.
 */
export async function loadCollabSuppressions(
  authorRows: readonly CollabAuthorRow[],
  indexByCwid: ReadonlyMap<string, number>,
): Promise<{
  darkPmids: Set<string>;
  hiddenAuthorsByPmid: Map<string, ReadonlySet<string>>;
}> {
  const all = await loadAllPublicationSuppressions(prisma);
  const hiddenAuthorsByPmid = new Map<string, ReadonlySet<string>>();
  if (all.darkPmids.size === 0 && all.hiddenAuthorsByPmid.size === 0) {
    return { darkPmids: new Set(), hiddenAuthorsByPmid };
  }
  const gatedPmids = new Set<string>();
  for (const r of authorRows) {
    if (r.cwid != null && indexByCwid.has(r.cwid)) gatedPmids.add(r.pmid);
  }
  const darkIn = new Set<string>();
  for (const pmid of all.darkPmids) if (gatedPmids.has(pmid)) darkIn.add(pmid);
  for (const [pmid, cwids] of all.hiddenAuthorsByPmid) {
    if (gatedPmids.has(pmid)) hiddenAuthorsByPmid.set(pmid, cwids);
  }
  if (darkIn.size === 0 && hiddenAuthorsByPmid.size === 0) {
    return { darkPmids: darkIn, hiddenAuthorsByPmid };
  }
  const touched = [...new Set([...darkIn, ...hiddenAuthorsByPmid.keys()])];
  const darkPmids = await resolveDarkPmids(
    touched,
    { darkPmids: darkIn, hiddenAuthorsByPmid },
    prisma,
  );
  return { darkPmids, hiddenAuthorsByPmid };
}

/**
 * Group confirmed authorships into co-authored paper groups over the gated
 * member set.
 *
 * - A row whose cwid is not in `indexByCwid` (not a publicly-displayed member)
 *   is ignored, so a hidden scholar forms neither a node count nor an edge.
 * - A pmid in `darkPmids` (whole-publication takedown / derived-dark) is dropped
 *   entirely — from the groups AND from every member's `pubCount`. Both loaders
 *   pass {@link loadCollabSuppressions} over ALL gated pmids, so this holds for
 *   single-author papers too.
 * - A `(pmid, cwid)` pair in `hiddenAuthorsByPmid` (per-author hide) removes
 *   that one member from that paper and from their `pubCount`.
 * - A paper is kept only with ≥2 remaining members.
 *
 * With empty suppression inputs this is byte-for-byte the center loader's
 * original grouping (same iteration order, same counts).
 */
export function buildPaperGroups({
  authorRows,
  indexByCwid,
  darkPmids = new Set<string>(),
  hiddenAuthorsByPmid = new Map<string, ReadonlySet<string>>(),
}: {
  authorRows: readonly CollabAuthorRow[];
  indexByCwid: ReadonlyMap<string, number>;
  darkPmids?: ReadonlySet<string>;
  hiddenAuthorsByPmid?: ReadonlyMap<string, ReadonlySet<string>>;
}): { papers: CollabPaper[]; pubCount: Map<string, number> } {
  const pubCount = new Map<string, number>();
  const groupByPmid = new Map<string, { members: Set<number>; year: number | null }>();
  for (const r of authorRows) {
    const cwid = r.cwid;
    if (cwid == null) continue;
    const idx = indexByCwid.get(cwid);
    if (idx === undefined) continue; // not a publicly-displayed member
    if (darkPmids.has(r.pmid)) continue;
    if (hiddenAuthorsByPmid.get(r.pmid)?.has(cwid)) continue;
    pubCount.set(cwid, (pubCount.get(cwid) ?? 0) + 1);
    let g = groupByPmid.get(r.pmid);
    if (!g) {
      g = { members: new Set<number>(), year: r.publication?.year ?? null };
      groupByPmid.set(r.pmid, g);
    }
    g.members.add(idx);
  }

  const papers: CollabPaper[] = [];
  for (const [pmid, g] of groupByPmid) {
    if (g.members.size < 2) continue;
    papers.push({ pmid, year: g.year, m: [...g.members].sort((a, b) => a - b) });
  }
  return { papers, pubCount };
}

/**
 * Build the grant co-investigator groups for a set of gated members (#1137
 * Phase 2). One award group per distinct sponsor `awardNumber` that ≥2 gated
 * members share. The #160 grant-suppression gate (`resolveActiveGrantSuppression`)
 * drops suppressed rows BEFORE grouping, so a member's hidden grant never forms
 * an edge or reveals a tie. Active = any grouped row whose `endDate ≥ today`;
 * `umbrella` flags center/training-mechanism or oversized awards (handoff §4).
 */
export async function buildAwards(
  memberCwids: string[],
  indexByCwid: Map<string, number>,
  today: string,
): Promise<CollabAward[]> {
  const grantRows = (await prisma.grant.findMany({
    // Exclude source='RePORTER' — individual prior-institution/history rows are
    // not WCM-administered awards and would corrupt the collaboration axis.
    where: { cwid: { in: memberCwids }, source: { not: "RePORTER" } },
    select: {
      cwid: true,
      externalId: true,
      id: true,
      awardNumber: true,
      mechanism: true,
      startDate: true,
      endDate: true,
    },
  })) as Array<{
    cwid: string;
    externalId: string | null;
    id: string;
    awardNumber: string | null;
    mechanism: string | null;
    startDate: Date;
    endDate: Date;
  }>;
  if (grantRows.length === 0) return [];

  // #160/#481(b) — drop suppressed grant rows before grouping (per-investigator
  // `externalId` keying). A suppressed row contributes to no award group, so a
  // hidden grant can neither form an edge nor reveal a co-investigation tie.
  const { suppressed } = await resolveActiveGrantSuppression(grantRows, prisma);

  type AwardGroup = {
    members: Set<number>;
    mechanisms: Set<string | null>;
    startYear: number | null;
    endYear: number | null;
    active: boolean;
  };
  const groups = new Map<string, AwardGroup>();
  for (const r of grantRows) {
    if (r.externalId !== null && suppressed.has(r.externalId)) continue;
    const awardId = r.awardNumber;
    if (!awardId) continue; // null award number can't form a join key (~0.2%)
    const idx = indexByCwid.get(r.cwid);
    if (idx === undefined) continue; // defensive: not a gated member
    let g = groups.get(awardId);
    if (!g) {
      g = {
        members: new Set<number>(),
        mechanisms: new Set<string | null>(),
        startYear: null,
        endYear: null,
        active: false,
      };
      groups.set(awardId, g);
    }
    g.members.add(idx);
    g.mechanisms.add(r.mechanism);
    const sy = r.startDate.getUTCFullYear();
    const ey = r.endDate.getUTCFullYear();
    if (g.startYear === null || sy < g.startYear) g.startYear = sy;
    if (g.endYear === null || ey > g.endYear) g.endYear = ey;
    if (r.endDate.toISOString().slice(0, 10) >= today) g.active = true;
  }

  const awards: CollabAward[] = [];
  for (const [awardId, g] of groups) {
    if (g.members.size < 2) continue; // an award needs ≥2 in-unit members to tie
    const m = [...g.members].sort((a, b) => a - b);
    awards.push({
      awardId,
      m,
      year: g.startYear,
      endYear: g.endYear,
      active: g.active,
      umbrella: isUmbrellaAward([...g.mechanisms], m.length),
    });
  }
  return awards;
}
