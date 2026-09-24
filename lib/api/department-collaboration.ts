/**
 * Server data layer for the department Collaboration tab.
 *
 * The department analogue of the center network (`center-collaboration.ts`,
 * #1137): nodes are the department's publicly-displayed members, colour groups
 * are its divisions, and edges come from confirmed co-authorship between
 * members. The browser builds edges / rollups / filters from this payload with
 * the same pure helpers (`lib/center-collaboration/graph.ts`).
 *
 * Privacy rides on the department roster's own public gate (`deptCode` +
 * `deletedAt: null, status: "active"` + `publicRoleWhere()`, then a fail-closed
 * `isPubliclyDisplayed` pass), so a hidden scholar is in NEITHER a node NOR an
 * edge. Publication suppression is applied (as on the center network): a dark
 * pmid forms no edge and counts in no member's `pubCount`; a per-author hide
 * removes that member from the paper and from their own `pubCount`.
 *
 * Cached via `cachedRead` under the `department:` prefix (≤1h stale, busted by
 * the existing department curation busts), like the other department rollups.
 */
import { prisma } from "@/lib/db";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import { cachedRead } from "@/lib/api/swr-cache";
import { extractLastNameSort } from "@/lib/name-sort";
import {
  buildAwards,
  buildPaperGroups,
  loadCollabSuppressions,
  type CollabAuthorRow,
} from "@/lib/api/collaboration-core";
import {
  assignProgramColors,
  EXTENDED_GROUP_PALETTE,
} from "@/lib/center-collaboration/graph";
import { isCenterCollaborationGrantAxisEnabled } from "@/lib/center-collaboration/flags";
import type {
  CollabNode,
  CollabProgram,
  UnitCollaborationPayload,
} from "@/lib/center-collaboration/types";

/** Legend label for members with no division in this department. */
export const NO_DIVISION_LABEL = "No division";

/**
 * The tab exists only for a department with ≥2 divisions that each have ≥1
 * public member — one division (or none) gives the network no groups to
 * compare. `divisionCounts` is the page's already-loaded
 * `getDepartmentDivisionMemberCounts` map (division code → public members).
 */
export function isDepartmentCollaborationEligible(
  divisionCounts: ReadonlyMap<string, number>,
): boolean {
  let populated = 0;
  for (const n of divisionCounts.values()) if (n > 0) populated += 1;
  return populated >= 2;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const emptyPayload = (grantAxis: boolean): UnitCollaborationPayload => ({
  programs: [],
  nodes: [],
  papers: [],
  awards: [],
  grantAxis,
  generatedAt: new Date().toISOString(),
});

/**
 * Build the collaboration payload for one department. Returns an empty
 * (nodes/papers `[]`) payload when it has no publicly-displayed members. Pass
 * `includeGrantAxis` to also build the grant co-investigator groups.
 */
export async function buildDepartmentCollaboration(
  dept: { code: string },
  opts: { includeGrantAxis?: boolean } = {},
): Promise<UnitCollaborationPayload> {
  const grantAxis = opts.includeGrantAxis ?? false;
  const deptCode = dept.code;
  const memberWhere = {
    deptCode,
    deletedAt: null,
    status: "active",
    ...publicRoleWhere(),
  };

  // 1. Gated members + the department's divisions (independent — one batch).
  const [loaded, divisions] = (await Promise.all([
    prisma.scholar.findMany({
      where: memberWhere,
      select: { cwid: true, preferredName: true, slug: true, roleCategory: true, divCode: true },
    }),
    prisma.division.findMany({
      where: { deptCode },
      select: { code: true, name: true, source: true },
    }),
  ])) as [
    Array<{
      cwid: string;
      preferredName: string;
      slug: string | null;
      roleCategory: string | null;
      divCode: string | null;
    }>,
    Array<{ code: string; name: string; source: string }>,
  ];

  // Fail-closed on the RAW column (#2271 carve, as the center loader):
  // `publicRoleWhere()` is a denylist that cannot express `doctoral_student*`.
  const scholars = loaded.filter((s) => isPubliclyDisplayed(s.roleCategory));
  if (scholars.length === 0) return emptyPayload(grantAxis);

  scholars.sort(
    (a, b) =>
      extractLastNameSort(a.preferredName).localeCompare(
        extractLastNameSort(b.preferredName),
      ) || a.preferredName.localeCompare(b.preferredName),
  );
  const indexByCwid = new Map<string, number>();
  scholars.forEach((s, i) => indexByCwid.set(s.cwid, i));
  const memberCwids = scholars.map((s) => s.cwid);

  // 2. Division per member: the LDAP `divCode` when it belongs to this
  //    department; else the first (by division name) manual roster division;
  //    else null ("No division"). One group per node — a manual member listed
  //    in several divisions shows under one.
  const divisionByCode = new Map(divisions.map((d) => [d.code, d]));
  const manualCodes = divisions.filter((d) => d.source === "manual").map((d) => d.code);
  const manualRows =
    manualCodes.length > 0
      ? ((await prisma.divisionMembership.findMany({
          where: { divisionCode: { in: manualCodes }, cwid: { in: memberCwids } },
          select: { divisionCode: true, cwid: true },
        })) as Array<{ divisionCode: string; cwid: string }>)
      : [];
  const manualByCwid = new Map<string, string>();
  for (const r of manualRows) {
    const current = manualByCwid.get(r.cwid);
    const name = divisionByCode.get(r.divisionCode)?.name ?? r.divisionCode;
    const currentName = current ? (divisionByCode.get(current)?.name ?? current) : null;
    if (currentName === null || name.localeCompare(currentName) < 0) {
      manualByCwid.set(r.cwid, r.divisionCode);
    }
  }
  const groupOf = (s: { cwid: string; divCode: string | null }): string | null => {
    if (s.divCode && divisionByCode.has(s.divCode)) return s.divCode;
    return manualByCwid.get(s.cwid) ?? null;
  };

  // 3. ONE authorship read, membership pushed into the relation (no 2,000-cwid
  //    IN list); rows re-filtered to the fail-closed gated set via indexByCwid.
  const authorRows = (await prisma.publicationAuthor.findMany({
    where: { isConfirmed: true, scholar: memberWhere },
    select: { pmid: true, cwid: true, publication: { select: { year: true } } },
  })) as CollabAuthorRow[];

  // 4. Publication suppression over every gated pmid (edges AND pubCount).
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

  // 5. Legend: divisions with ≥1 node, largest first (so the biggest divisions
  //    take the most distinct colours), then "No division" when any node has none.
  const groupByCwid = new Map(scholars.map((s) => [s.cwid, groupOf(s)]));
  const memberCount = new Map<string, number>();
  let anyUngrouped = false;
  for (const g of groupByCwid.values()) {
    if (g === null) anyUngrouped = true;
    else memberCount.set(g, (memberCount.get(g) ?? 0) + 1);
  }
  const ordered = [...memberCount.keys()]
    .map((code) => divisionByCode.get(code)!)
    .sort(
      (a, b) =>
        (memberCount.get(b.code) ?? 0) - (memberCount.get(a.code) ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const programs: CollabProgram[] = assignProgramColors(
    [
      ...ordered.map((d) => ({ code: d.code, label: d.name })),
      ...(anyUngrouped ? [{ code: null, label: NO_DIVISION_LABEL }] : []),
    ],
    // Its first six slots ARE Okabe-Ito, so a ≤6-division department colours
    // exactly as a center; Medicine's 14 divisions get distinct hues.
    EXTENDED_GROUP_PALETTE,
  );

  const nodes: CollabNode[] = scholars.map((s, i) => ({
    i,
    cwid: s.cwid,
    name: s.preferredName,
    slug: s.slug ?? null,
    programCode: groupByCwid.get(s.cwid) ?? null,
    pubCount: pubCount.get(s.cwid) ?? 0,
  }));

  // 6. Grant co-investigator groups — only when the grant sub-flag is on.
  const awards = grantAxis
    ? await buildAwards(memberCwids, indexByCwid, todayIso())
    : [];

  return {
    programs,
    nodes,
    papers,
    awards,
    grantAxis,
    generatedAt: new Date().toISOString(),
  };
}

/** Cached public wrapper (`department:` prefix — picked up by department busts). */
export const getDepartmentCollaboration = (dept: { code: string }) => {
  const includeGrantAxis = isCenterCollaborationGrantAxisEnabled();
  return cachedRead(
    `department:collaboration:${dept.code}:${includeGrantAxis ? "g" : ""}`,
    () => buildDepartmentCollaboration(dept, { includeGrantAxis }),
  );
};
