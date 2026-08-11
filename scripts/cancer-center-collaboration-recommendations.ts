/**
 * Cancer Center collaboration-recommendation report (advisory, no writes).
 *
 * PubMed-only signal (co-authorship on `Publication`/`PublicationAuthor`) —
 * Phase 1 of the shipped Collaboration tab, not its Phase 2 grant axis. Flags
 * active research members with zero in-center collaboration (REMOVE) and
 * non-member full-time faculty who already collaborate heavily with the
 * center (ADD), then simulates the roster change and prints before/after
 * center-level numbers. A human applies the recommendation through the
 * existing `/edit` roster editor (`/api/edit/roster`) — this script writes
 * nothing.
 *
 * Reuses the pure, already-unit-tested edge/rollup helpers from
 * `lib/center-collaboration/graph.ts` (the same module the shipped
 * Collaboration tab uses) for the intra/inter-program split, rather than
 * reimplementing that subtree-adjacent grouping logic.
 *
 * `buildPmidIndex`/`buildGroups`/`centerMetrics`/`splitName`/`pct` live in
 * `lib/center-collaboration/recommendations-core.ts` — shared with
 * `etl/cancer-center-collab-report/index.ts` (v2's weekly precompute, adds
 * the cancer-relevance axis + the full-time-faculty candidate universe) so
 * the two can't drift on what "collaboration with the center" counts.
 *
 * Run (needs DATABASE_URL; in-VPC — see docs/DEPLOY-RUNBOOK.md TS-backfill
 * convention):
 *   npx tsx scripts/cancer-center-collaboration-recommendations.ts \
 *     [--cutoff-year=2016] [--center=meyer_cancer_center] > out.csv
 *
 *   npx tsx scripts/cancer-center-collaboration-recommendations.ts --self-check
 *     runs the synthetic-fixture check below and exits — no DB required.
 */
import { prisma, disconnect } from "@/lib/db";
import { isCenterMembershipActive } from "@/lib/api/centers";
import { computeCoPubCounts, UNCLASSIFIED_KEY, UNCLASSIFIED_LABEL } from "@/lib/center-collaboration/graph";
import {
  ADD_THRESHOLD,
  buildGroups,
  buildPmidIndex,
  centerMetrics,
  DEFAULT_CUTOFF_YEAR,
  pct,
  REMOVE_THRESHOLD,
  splitName,
  type AuthorRow,
  type CenterMetrics,
} from "@/lib/center-collaboration/recommendations-core";

export type { AuthorRow };
export { ADD_THRESHOLD, buildGroups, buildPmidIndex, centerMetrics, pct, REMOVE_THRESHOLD, splitName };

/** Papers touching program `key` at all (intra + any cross-program edge that
 *  names it) — the denominator for that program's own intra %. */
function papersTouching(m: CenterMetrics, key: string): number {
  const intra = m.perProgramIntra.get(key) ?? 0;
  const cross = m.programEdges.filter((e) => e.a === key || e.b === key).reduce((n, e) => n + e.weight, 0);
  return intra + cross;
}

/** Which current member an ADD candidate shares the most co-authored papers
 *  with — the simulated `programCode` placeholder (§ plan "Before/after
 *  simulation"). Deterministic: ties broken by the tied members' cwid. */
export function assignSimProgram(
  candidateRows: AuthorRow[],
  pmidToMemberIdxs: Map<string, Set<number>>,
  members: Array<{ cwid: string; programCode: string | null }>,
): string | null {
  const tally = new Map<number, number>();
  for (const r of candidateRows) {
    const idxs = pmidToMemberIdxs.get(r.pmid);
    if (!idxs) continue;
    for (const idx of idxs) tally.set(idx, (tally.get(idx) ?? 0) + 1);
  }
  let bestIdx: number | null = null;
  let bestCount = -1;
  let bestCwid = "";
  for (const [idx, count] of tally) {
    const cwid = members[idx].cwid;
    if (count > bestCount || (count === bestCount && cwid < bestCwid)) {
      bestIdx = idx;
      bestCount = count;
      bestCwid = cwid;
    }
  }
  return bestIdx !== null ? members[bestIdx].programCode : null;
}

export type PersonRow = {
  cwid: string;
  surname: string;
  givenName: string;
  primaryDepartment: string;
  currentMembershipType: string;
  currentProgramCode: string;
  totalPapersPostCutoff: number;
  collaborationsWithCenter: number;
  percentageCollaborations: number;
  recommendation: string;
};

export function toCsv(rows: PersonRow[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head =
    "cwid,surname,givenName,primaryDepartment,currentMembershipType,currentProgramCode," +
    "totalPapersPostCutoff,collaborationsWithCenter,percentageCollaborations,recommendation";
  const lines = rows.map((r) =>
    [
      r.cwid, q(r.surname), q(r.givenName), q(r.primaryDepartment),
      r.currentMembershipType, r.currentProgramCode, r.totalPapersPostCutoff,
      r.collaborationsWithCenter, r.percentageCollaborations, r.recommendation,
    ].join(","),
  );
  return [head, ...lines].join("\n") + "\n";
}

export function summaryBlock(before: CenterMetrics & { members: number }, after: CenterMetrics & { members: number }): string {
  const row = (label: string, b: string, a: string) =>
    `${label.padEnd(24)}${b.padStart(8)}${a.padStart(8)}`;
  return [
    `${"".padEnd(24)}${"before".padStart(8)}${"after".padStart(8)}`,
    row("intra-center papers", String(before.totalPapers), String(after.totalPapers)),
    row("% intra-program", `${pct(before.intraPapers, before.totalPapers).toFixed(1)}%`, `${pct(after.intraPapers, after.totalPapers).toFixed(1)}%`),
    row("% inter-program", `${pct(before.interPapers, before.totalPapers).toFixed(1)}%`, `${pct(after.interPapers, after.totalPapers).toFixed(1)}%`),
    row("active research members", String(before.members), String(after.members)),
  ].join("\n");
}

/** Per-program breakdown (plan "Metrics": "% intra-program vs % inter-program
 *  ... center aggregate, plus a per-program breakdown table [of] the same
 *  computation, ungrouped"). For each program: its intra-program paper count
 *  and, of every paper touching that program at all, what % stayed intra. */
export function perProgramBlock(before: CenterMetrics, after: CenterMetrics): string {
  const label = (k: string) => (k === UNCLASSIFIED_KEY ? UNCLASSIFIED_LABEL : k);
  const keys = [...new Set([...before.perProgramIntra.keys(), ...after.perProgramIntra.keys()])].sort();
  if (keys.length === 0) return "";
  const cell = (m: CenterMetrics, k: string) => {
    const intra = m.perProgramIntra.get(k) ?? 0;
    return `${intra} (${pct(intra, papersTouching(m, k)).toFixed(1)}%)`;
  };
  const row = (label_: string, b: string, a: string) => `${label_.padEnd(24)}${b.padStart(14)}${a.padStart(14)}`;
  return [
    "\nper-program intra-program papers (count, % of that program's papers):",
    `${"".padEnd(24)}${"before".padStart(14)}${"after".padStart(14)}`,
    ...keys.map((k) => row(label(k), cell(before, k), cell(after, k))),
  ].join("\n");
}

// --- self-check: DB-free synthetic fixture ---------------------------------
export function selfCheck(): void {
  // 5 members: m1/m2 in P1, m3/m4 in P2, m5 in P1 with zero collaboration.
  // 1 non-member candidate c1, who co-authors 2 papers with m1 only.
  const members = [
    { cwid: "m1", programCode: "P1" },
    { cwid: "m2", programCode: "P1" },
    { cwid: "m3", programCode: "P2" },
    { cwid: "m4", programCode: "P2" },
    { cwid: "m5", programCode: "P1" },
  ];
  const indexByCwid = new Map(members.map((m, i) => [m.cwid, i]));
  const memberRows: AuthorRow[] = [
    { pmid: "A", cwid: "m1" }, { pmid: "A", cwid: "m2" }, // P1-P1 intra
    { pmid: "B", cwid: "m3" }, { pmid: "B", cwid: "m4" }, // P2-P2 intra
    { pmid: "C", cwid: "m1" }, { pmid: "C", cwid: "m3" }, // P1-P2 inter
    { pmid: "D", cwid: "m1" }, // shared with c1 below, not another member
    { pmid: "E", cwid: "m1" },
  ];
  const pmidIdxs = buildPmidIndex(memberRows, indexByCwid);
  const memberGroups = buildGroups(pmidIdxs);

  const collab = computeCoPubCounts(memberGroups, members.length);
  if (collab[4] !== 0) throw new Error(`m5 should have 0 collaborations, got ${collab[4]}`);
  if (collab[0] !== 2) throw new Error(`m1 should have 2 collaborations (A,C), got ${collab[0]}`);
  const removeFlagged = members.filter((_, i) => collab[i] === REMOVE_THRESHOLD).map((m) => m.cwid);
  if (!removeFlagged.includes("m5") || removeFlagged.length !== 1) {
    throw new Error(`expected only m5 flagged REMOVE, got ${removeFlagged}`);
  }

  const before = centerMetrics(memberGroups, (i) => members[i].programCode);
  if (before.intraPapers + before.interPapers !== before.totalPapers) {
    throw new Error("before: intra + inter must sum to total");
  }
  if (before.totalPapers !== 3 || before.intraPapers !== 2 || before.interPapers !== 1) {
    throw new Error(`before metrics wrong: ${JSON.stringify(before)}`);
  }
  if (before.perProgramIntra.get("P1") !== 1 || before.perProgramIntra.get("P2") !== 1) {
    throw new Error(`per-program intra split wrong: ${JSON.stringify([...before.perProgramIntra])}`);
  }

  // c1: 2 shared papers with m1 (D, E) → ADD, sim program = m1's (P1).
  const candidateRows: AuthorRow[] = [{ pmid: "D", cwid: "c1" }, { pmid: "E", cwid: "c1" }];
  const c1Collab = candidateRows.filter((r) => pmidIdxs.has(r.pmid)).length;
  if (c1Collab < ADD_THRESHOLD) throw new Error(`c1 should cross ADD_THRESHOLD, got ${c1Collab}`);
  const simProgram = assignSimProgram(candidateRows, pmidIdxs, members);
  if (simProgram !== "P1") throw new Error(`c1 should simulate into P1, got ${simProgram}`);

  // Simulated roster: drop m5, add c1(P1). D/E now qualify (m1+c1, size 2).
  const simMembers = members.filter((m) => m.cwid !== "m5").concat([{ cwid: "c1", programCode: "P1" }]);
  const simIndexByCwid = new Map(simMembers.map((m, i) => [m.cwid, i]));
  const simRows = memberRows.filter((r) => r.cwid !== "m5").concat(candidateRows);
  const simGroups = buildGroups(buildPmidIndex(simRows, simIndexByCwid));
  const after = centerMetrics(simGroups, (i) => simMembers[i].programCode);
  if (after.intraPapers + after.interPapers !== after.totalPapers) {
    throw new Error("after: intra + inter must sum to total");
  }
  if (after.totalPapers <= before.totalPapers) {
    throw new Error(`expected totalPapers to move up after simulation: ${before.totalPapers} -> ${after.totalPapers}`);
  }
  if (simMembers.length !== members.length) {
    throw new Error("active member count should be unchanged (1 removed, 1 added)");
  }
}

// --- DB shell ----------------------------------------------------------
function argValue(flag: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : def;
}

async function main(): Promise<void> {
  selfCheck();
  if (process.argv.includes("--self-check")) {
    console.error("self-check OK");
    return;
  }

  const cutoffYear = Number(argValue("cutoff-year", String(DEFAULT_CUTOFF_YEAR)));
  if (!Number.isInteger(cutoffYear)) {
    throw new Error(`--cutoff-year must be an integer, got: ${argValue("cutoff-year", String(DEFAULT_CUTOFF_YEAR))}`);
  }
  const centerCode = argValue("center", "meyer_cancer_center");
  const today = new Date().toISOString().slice(0, 10);

  // 1. Active research members.
  const memberships = (await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, programCode: true, membershipType: true, startDate: true, endDate: true },
  })) as Array<{ cwid: string; programCode: string | null; membershipType: string | null; startDate: Date | null; endDate: Date | null }>;
  const anyActiveMemberCwids = new Set(
    memberships.filter((m) => isCenterMembershipActive(m.startDate, m.endDate, today)).map((m) => m.cwid),
  );
  const activeResearch = memberships.filter(
    (m) => m.membershipType === "research" && isCenterMembershipActive(m.startDate, m.endDate, today),
  );
  const scholarByCwid = new Map(
    (
      await prisma.scholar.findMany({
        where: { cwid: { in: activeResearch.map((m) => m.cwid) }, deletedAt: null, status: "active" },
        select: { cwid: true, preferredName: true, primaryDepartment: true },
      })
    ).map((s: { cwid: string; preferredName: string; primaryDepartment: string | null }) => [s.cwid, s]),
  );
  const members = activeResearch
    .filter((m) => scholarByCwid.has(m.cwid))
    .map((m) => ({ programCode: m.programCode, ...scholarByCwid.get(m.cwid)! }))
    .sort((a, b) => a.cwid.localeCompare(b.cwid));
  if (members.length === 0) {
    console.error(`no active research members found for center '${centerCode}'`);
    process.stdout.write(toCsv([]));
    return;
  }
  const memberCwids = members.map((m) => m.cwid);
  const indexByCwid = new Map(members.map((m, i) => [m.cwid, i]));

  // 2. Members' post-cutoff confirmed Academic Article authorship.
  const memberAuthorRows = (await prisma.publicationAuthor.findMany({
    where: {
      cwid: { in: memberCwids },
      isConfirmed: true,
      publication: { publicationType: "Academic Article", year: { gte: cutoffYear } },
    },
    select: { pmid: true, cwid: true },
  })) as Array<{ pmid: string; cwid: string | null }>;
  const rows = memberAuthorRows.filter((r): r is AuthorRow => r.cwid !== null);
  const totalByCwid = new Map<string, number>();
  for (const r of rows) totalByCwid.set(r.cwid, (totalByCwid.get(r.cwid) ?? 0) + 1);
  const pmidToMemberIdxs = buildPmidIndex(rows, indexByCwid);
  const memberGroups = buildGroups(pmidToMemberIdxs);
  const pmidsWithMember = new Set(pmidToMemberIdxs.keys());

  const memberCollab = computeCoPubCounts(memberGroups, members.length);
  const before = centerMetrics(memberGroups, (i) => members[i].programCode);

  // 3. ADD candidate pool: non-member co-authors on those same pmids.
  const coAuthorRows = pmidsWithMember.size
    ? ((await prisma.publicationAuthor.findMany({
        where: { pmid: { in: [...pmidsWithMember] }, isConfirmed: true, cwid: { not: null } },
        select: { cwid: true },
      })) as Array<{ cwid: string | null }>)
    : [];
  const candidatePoolCwids = [...new Set(coAuthorRows.map((r) => r.cwid!).filter((c) => !indexByCwid.has(c)))];
  const candidateScholars = candidatePoolCwids.length
    ? ((await prisma.scholar.findMany({
        where: { cwid: { in: candidatePoolCwids }, deletedAt: null, status: "active", roleCategory: "full_time_faculty" },
        select: { cwid: true, preferredName: true, primaryDepartment: true },
      })) as Array<{ cwid: string; preferredName: string; primaryDepartment: string | null }>)
    : [];
  const candidates = candidateScholars.filter((s) => !anyActiveMemberCwids.has(s.cwid));

  // 4. Candidates' post-cutoff confirmed Academic Article authorship.
  const candidateCwids = candidates.map((c) => c.cwid);
  const candidateAuthorRows = candidateCwids.length
    ? (
        (await prisma.publicationAuthor.findMany({
          where: {
            cwid: { in: candidateCwids },
            isConfirmed: true,
            publication: { publicationType: "Academic Article", year: { gte: cutoffYear } },
          },
          select: { pmid: true, cwid: true },
        })) as Array<{ pmid: string; cwid: string | null }>
      ).filter((r): r is AuthorRow => r.cwid !== null)
    : [];
  const candTotal = new Map<string, number>();
  const candCollab = new Map<string, number>();
  const rowsByCandidate = new Map<string, AuthorRow[]>();
  for (const r of candidateAuthorRows) {
    candTotal.set(r.cwid, (candTotal.get(r.cwid) ?? 0) + 1);
    if (pmidsWithMember.has(r.pmid)) candCollab.set(r.cwid, (candCollab.get(r.cwid) ?? 0) + 1);
    const arr = rowsByCandidate.get(r.cwid) ?? [];
    arr.push(r);
    rowsByCandidate.set(r.cwid, arr);
  }
  const addFlagged = candidates
    .map((c) => ({ ...c, total: candTotal.get(c.cwid) ?? 0, collab: candCollab.get(c.cwid) ?? 0 }))
    .filter((c) => c.collab >= ADD_THRESHOLD);

  // 5. Per-person CSV rows: every active research member + only ADD-flagged.
  const personRows: PersonRow[] = [];
  members.forEach((m, i) => {
    const total = totalByCwid.get(m.cwid) ?? 0;
    const c = memberCollab[i];
    const { given, surname } = splitName(m.preferredName);
    personRows.push({
      cwid: m.cwid, surname, givenName: given, primaryDepartment: m.primaryDepartment ?? "",
      currentMembershipType: "research", currentProgramCode: m.programCode ?? "",
      totalPapersPostCutoff: total, collaborationsWithCenter: c, percentageCollaborations: pct(c, total),
      recommendation: c === REMOVE_THRESHOLD ? "REMOVE" : "",
    });
  });
  for (const c of addFlagged) {
    const { given, surname } = splitName(c.preferredName);
    personRows.push({
      cwid: c.cwid, surname, givenName: given, primaryDepartment: c.primaryDepartment ?? "",
      currentMembershipType: "", currentProgramCode: "",
      totalPapersPostCutoff: c.total, collaborationsWithCenter: c.collab, percentageCollaborations: pct(c.collab, c.total),
      recommendation: "ADD",
    });
  }
  personRows.sort((a, b) => b.collaborationsWithCenter - a.collaborationsWithCenter || a.cwid.localeCompare(b.cwid));

  // 6. Simulated roster + after-metrics.
  const removedCwids = new Set(members.filter((_, i) => memberCollab[i] === REMOVE_THRESHOLD).map((m) => m.cwid));
  const simMembers = members
    .filter((m) => !removedCwids.has(m.cwid))
    .map((m) => ({ cwid: m.cwid, programCode: m.programCode }))
    .concat(
      addFlagged.map((c) => ({
        cwid: c.cwid,
        programCode: assignSimProgram(rowsByCandidate.get(c.cwid) ?? [], pmidToMemberIdxs, members),
      })),
    );
  const simIndexByCwid = new Map(simMembers.map((m, i) => [m.cwid, i]));
  const simRows = rows.filter((r) => !removedCwids.has(r.cwid)).concat(
    addFlagged.flatMap((c) => rowsByCandidate.get(c.cwid) ?? []),
  );
  const simGroups = buildGroups(buildPmidIndex(simRows, simIndexByCwid));
  const after = centerMetrics(simGroups, (i) => simMembers[i].programCode);

  process.stdout.write(toCsv(personRows));
  console.error("");
  console.error(summaryBlock({ ...before, members: members.length }, { ...after, members: simMembers.length }));
  console.error(perProgramBlock(before, after));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
