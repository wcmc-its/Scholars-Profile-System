/**
 * Server data layer for the Cancer Center collaboration network (#1137).
 *
 * Computes the on-demand co-authorship graph for one center from live data —
 * no schema change, no precompute. Privacy rides on the SAME public gate the
 * roster uses (`deletedAt: null, status: "active"` + `publicRoleWhere()` + the
 * active-membership predicate, then a fail-closed `isPubliclyDisplayed` pass),
 * so #536-hidden faculty and soft-deleted students can appear in NEITHER a node
 * NOR an edge. Publication suppression (whole-publication takedown, derived-dark,
 * per-author hide) is applied to both edges and `pubCount`. Edges/rollups/filters are built in the browser from this payload
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
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import { isCenterMembershipActive } from "@/lib/api/centers";
import {
  buildAwards,
  buildPaperGroups,
  loadCollabSuppressions,
  type CollabAuthorRow,
} from "@/lib/api/collaboration-core";
import { extractLastNameSort } from "@/lib/name-sort";
import {
  assignProgramColors,
  UNCLASSIFIED_COLOR,
  UNCLASSIFIED_LABEL,
} from "@/lib/center-collaboration/graph";
import type {
  CenterCollaborationPayload,
  CollabNode,
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
    select: { cwid: true, programCode: true, startDate: true, endDate: true, membershipRoleKey: true },
  })) as Array<{
    cwid: string;
    programCode: string | null;
    startDate: Date | null;
    endDate: Date | null;
    membershipRoleKey: string | null;
  }>;
  const programByCwid = new Map<string, string | null>();
  for (const m of memberships) {
    if (isCenterMembershipActive(m, today)) {
      programByCwid.set(m.cwid, m.programCode);
    }
  }
  const activeCwids = [...programByCwid.keys()];
  if (activeCwids.length === 0) return emptyPayload(center, grantAxis);

  // 2. Public-display gate — identical to the public roster (drop dormant /
  //    soft-deleted / #536-hidden). A scholar dropped here is dropped from nodes
  //    AND edges. #2271 — the role carve was asserted in three places but never
  //    applied here; #2256 added it to `centers.ts` and parity was lost.
  const loaded = (await prisma.scholar.findMany({
    where: {
      cwid: { in: activeCwids },
      deletedAt: null,
      status: "active",
      ...publicRoleWhere(),
    },
    select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
  })) as Array<{
    cwid: string;
    preferredName: string;
    slug: string | null;
    roleCategory: string | null;
  }>;
  // Fail-closed on the RAW column: `publicRoleWhere()` is a denylist that cannot
  // express the `doctoral_student*` prefix, so an out-of-band suffix passes it.
  const scholars = loaded.filter((s) => isPubliclyDisplayed(s.roleCategory));
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
  })) as CollabAuthorRow[];

  // Per-member total pub count + the per-PMID member groups (≥2 members), with
  // publication suppression applied exactly as on the department network: a
  // dark pmid forms no edge and no count; a per-author hide drops that member.
  const { darkPmids, hiddenAuthorsByPmid } = await loadCollabSuppressions(
    authorRows,
    indexByCwid,
  );
  const { papers, pubCount } = buildPaperGroups({
    authorRows,
    indexByCwid,
    darkPmids,
    hiddenAuthorsByPmid,
  });

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

  // 6. Legend = programs that actually have ≥1 active member, in sortOrder,
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

  // 7. Grant co-investigator groups (#1137 Phase 2) — only when the sub-flag is
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
