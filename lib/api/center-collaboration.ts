/**
 * Server data layer for the Cancer Center collaboration network (#1137).
 *
 * Computes the on-demand co-authorship graph for one center from live data —
 * no schema change, no precompute. Privacy rides on the SAME public gate the
 * roster uses (`deletedAt: null, status: "active"` + active-membership predicate),
 * so #536-hidden faculty and soft-deleted students can appear in NEITHER a node
 * NOR an edge. Edges/rollups/filters are built in the browser from this payload
 * (`lib/center-collaboration/graph.ts`); this module is filter-agnostic.
 *
 * Phase 2 (#1137) adds an optional grant co-investigator axis: when
 * `includeGrantAxis` is set, the gated members' `Grant` rows are grouped by
 * shared `awardNumber` into `awards`. The #160 grant-suppression gate is applied
 * BEFORE grouping, so a suppressed grant can never form an edge — the
 * load-bearing privacy task for the grant axis (handoff §5.6).
 *
 * See `docs/cancer-center-collaboration-network-spec.md` §3–§5 and
 * `docs/grant-coinvestigator-axis-handoff.md` §7.
 */
import { prisma } from "@/lib/db";
import { isCenterMembershipActive } from "@/lib/api/centers";
import { resolveActiveGrantSuppression } from "@/lib/api/manual-layer";
import { extractLastNameSort } from "@/lib/name-sort";
import {
  assignProgramColors,
  UNCLASSIFIED_COLOR,
  UNCLASSIFIED_LABEL,
} from "@/lib/center-collaboration/graph";
import { isUmbrellaAward } from "@/lib/center-collaboration/grants";
import type {
  CenterCollaborationPayload,
  CollabAward,
  CollabNode,
  CollabPaper,
  CollabProgram,
} from "@/lib/center-collaboration/types";

/** UTC date string for "now" — matches the roster's membership-active compare. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const emptyPayload = (
  center: { code: string; name: string },
  grantAxis: boolean,
): CenterCollaborationPayload => ({
  center,
  programs: [],
  nodes: [],
  papers: [],
  awards: [],
  grantAxis,
  generatedAt: new Date().toISOString(),
});

/**
 * Build the collaboration payload for a center by code. Returns `null` if the
 * center does not exist; an empty (nodes/papers `[]`) payload if it has no
 * active publicly-displayed members. Pass `includeGrantAxis` to additionally
 * build the grant co-investigator groups (`awards`).
 */
export async function buildCenterCollaboration(
  centerCode: string,
  opts: { includeGrantAxis?: boolean } = {},
): Promise<CenterCollaborationPayload | null> {
  const grantAxis = opts.includeGrantAxis ?? false;
  const center = await prisma.center.findUnique({
    where: { code: centerCode },
    select: { code: true, name: true },
  });
  if (!center) return null;

  const today = todayIso();

  // 1. Active memberships (§3.3 predicate) + each member's program code.
  const memberships = (await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, programCode: true, startDate: true, endDate: true },
  })) as Array<{
    cwid: string;
    programCode: string | null;
    startDate: Date | null;
    endDate: Date | null;
  }>;
  const programByCwid = new Map<string, string | null>();
  for (const m of memberships) {
    if (isCenterMembershipActive(m.startDate, m.endDate, today)) {
      programByCwid.set(m.cwid, m.programCode);
    }
  }
  const activeCwids = [...programByCwid.keys()];
  if (activeCwids.length === 0) return emptyPayload(center, grantAxis);

  // 2. Public-display gate — identical to the public roster (drop dormant /
  //    soft-deleted). A scholar dropped here is dropped from nodes AND edges.
  const scholars = (await prisma.scholar.findMany({
    where: { cwid: { in: activeCwids }, deletedAt: null, status: "active" },
    select: { cwid: true, preferredName: true, slug: true },
  })) as Array<{ cwid: string; preferredName: string; slug: string | null }>;
  if (scholars.length === 0) return emptyPayload(center, grantAxis);

  // Stable, legible node order: surname A–Z (preferredName is "Given … Last").
  scholars.sort(
    (a, b) =>
      extractLastNameSort(a.preferredName).localeCompare(
        extractLastNameSort(b.preferredName),
      ) || a.preferredName.localeCompare(b.preferredName),
  );
  const indexByCwid = new Map<string, number>();
  scholars.forEach((s, i) => indexByCwid.set(s.cwid, i));
  const memberCwids = scholars.map((s) => s.cwid);

  // 3. Program taxonomy → stable colors (by sortOrder) for the legend.
  const programRows = (await prisma.centerProgram.findMany({
    where: { centerCode },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    select: { code: true, label: true },
  })) as Array<{ code: string; label: string }>;
  const validCodes = new Set(programRows.map((p) => p.code));
  const colored = assignProgramColors(programRows); // by sortOrder
  const colorByCode = new Map<string, string>();
  const labelByCode = new Map<string, string>();
  for (const p of colored) {
    if (p.code !== null) {
      colorByCode.set(p.code, p.color);
      labelByCode.set(p.code, p.label);
    }
  }

  // 4. ONE query: every confirmed authorship of every member, with the pub year.
  //    Yields BOTH per-member total pub count AND the per-PMID member groups.
  const authorRows = (await prisma.publicationAuthor.findMany({
    where: { cwid: { in: memberCwids }, isConfirmed: true },
    select: { pmid: true, cwid: true, publication: { select: { year: true } } },
  })) as Array<{
    pmid: string;
    cwid: string | null;
    publication: { year: number | null } | null;
  }>;

  const pubCount = new Map<string, number>();
  const groupByPmid = new Map<string, { members: Set<number>; year: number | null }>();
  for (const r of authorRows) {
    const cwid = r.cwid;
    if (cwid == null) continue;
    const idx = indexByCwid.get(cwid);
    if (idx === undefined) continue; // not a publicly-displayed member
    pubCount.set(cwid, (pubCount.get(cwid) ?? 0) + 1);
    let g = groupByPmid.get(r.pmid);
    if (!g) {
      g = { members: new Set<number>(), year: r.publication?.year ?? null };
      groupByPmid.set(r.pmid, g);
    }
    g.members.add(idx);
  }

  // 5. Nodes (program code normalized — a stale/unknown code → Unclassified).
  const nodes: CollabNode[] = scholars.map((s, i) => {
    const raw = programByCwid.get(s.cwid) ?? null;
    const programCode = raw != null && validCodes.has(raw) ? raw : null;
    return {
      i,
      cwid: s.cwid,
      name: s.preferredName,
      slug: s.slug ?? null,
      programCode,
      pubCount: pubCount.get(s.cwid) ?? 0,
    };
  });

  // 6. Papers = PMIDs with ≥2 in-center members.
  const papers: CollabPaper[] = [];
  for (const [pmid, g] of groupByPmid) {
    if (g.members.size < 2) continue;
    papers.push({ pmid, year: g.year, m: [...g.members].sort((a, b) => a - b) });
  }

  // 7. Legend = programs that actually have ≥1 active member, in sortOrder,
  //    plus the Unclassified group when any node is null/unknown-program.
  const presentCodes = new Set<string>();
  let anyUnclassified = false;
  for (const n of nodes) {
    if (n.programCode === null) anyUnclassified = true;
    else presentCodes.add(n.programCode);
  }
  const programs: CollabProgram[] = programRows
    .filter((p) => presentCodes.has(p.code))
    .map((p) => ({
      code: p.code,
      label: labelByCode.get(p.code) ?? p.label,
      color: colorByCode.get(p.code) ?? UNCLASSIFIED_COLOR,
    }));
  if (anyUnclassified) {
    programs.push(assignProgramColors([{ code: null, label: UNCLASSIFIED_LABEL }])[0]);
  }

  // 8. Grant co-investigator groups (#1137 Phase 2) — only when the sub-flag is
  //    on. Built over the SAME gated member set, with the #160 suppression gate
  //    applied before grouping.
  const awards = grantAxis
    ? await buildAwards(memberCwids, indexByCwid, today)
    : [];

  return {
    center,
    programs,
    nodes,
    papers,
    awards,
    grantAxis,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the grant co-investigator groups for a set of gated members (#1137
 * Phase 2). One award group per distinct sponsor `awardNumber` that ≥2 gated
 * members share. The #160 grant-suppression gate (`resolveActiveGrantSuppression`)
 * drops suppressed rows BEFORE grouping, so a member's hidden grant never forms
 * an edge or reveals a tie. Active = any grouped row whose `endDate ≥ today`;
 * `umbrella` flags center/training-mechanism or oversized awards (handoff §4).
 */
async function buildAwards(
  memberCwids: string[],
  indexByCwid: Map<string, number>,
  today: string,
): Promise<CollabAward[]> {
  const grantRows = (await prisma.grant.findMany({
    where: { cwid: { in: memberCwids } },
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
    if (g.members.size < 2) continue; // an award needs ≥2 in-center members to tie
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
