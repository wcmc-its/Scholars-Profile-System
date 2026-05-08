/**
 * Path B per-division reconnaissance (issue #16).
 *
 * For every Division row in the DB, compute Path B candidates in memory
 * (without re-running the ETL) and rank them by signal strength. Output is a
 * per-division verdict so a human can decide:
 *   - which auto-detected chiefs to trust
 *   - which divisions need a manual entry in data/division-chiefs.txt
 *
 * Why in-memory: the live `Department.chairCwid` column may be stale (e.g.
 * Medicine's chair didn't match the old regex), so the probe applies the
 * UPDATED chair-detection rule against the SOR appointments directly. That
 * way the report reflects what the next ETL run *will* produce, not what's
 * currently in the DB.
 *
 * Usage:
 *   npx tsx etl/ed/probe-divisions.ts            # every division
 *   npx tsx etl/ed/probe-divisions.ts N1280      # restrict to one parent dept
 *
 * Read-only — does not modify any DB or LDAP state.
 */
import "dotenv/config";
import { prisma } from "../../lib/db";
import {
  type ChiefVerdict,
  detectDivisionChief,
  isChairTitleFor,
} from "./chief-detection";
import {
  collapseEmployeeRecordsByCwid,
  type EdFacultyAppointment,
  fetchActiveEmployeeRecords,
  fetchActiveFacultyAppointments,
  openLdap,
} from "../../lib/sources/ldap";

function verdictLabel(v: ChiefVerdict): string {
  switch (v) {
    case "HIGH": return "HIGH    ";
    case "MEDIUM": return "MEDIUM  ";
    case "LOW": return "LOW     ";
    case "NONE": return "NONE    ";
    case "GAP": return "GAP     ";
  }
}

async function main() {
  const restrictToDept = process.argv[2]?.trim() || null;

  const client = await openLdap();
  console.log("Fetching employee SOR records...");
  const empRecords = await fetchActiveEmployeeRecords(client);
  console.log(`  ${empRecords.length} active employee SOR rows`);
  const empByCwid = collapseEmployeeRecordsByCwid(empRecords);
  const managerByCwid = new Map<string, string | null>();
  for (const [cwid, rec] of empByCwid) managerByCwid.set(cwid, rec.managerCwid);

  console.log("Fetching faculty SOR appointments...");
  const apptRecords = await fetchActiveFacultyAppointments(client);
  console.log(`  ${apptRecords.length} active faculty appointment rows`);
  await client.unbind();

  const apptsByCwid = new Map<string, EdFacultyAppointment[]>();
  for (const a of apptRecords) {
    const arr = apptsByCwid.get(a.cwid) ?? [];
    arr.push(a);
    apptsByCwid.set(a.cwid, arr);
  }
  const divisionMembers = new Map<string, Set<string>>();
  for (const a of apptRecords) {
    if (!a.divCode) continue;
    const set = divisionMembers.get(a.divCode) ?? new Set<string>();
    set.add(a.cwid);
    divisionMembers.set(a.divCode, set);
  }

  const departments = await prisma.department.findMany({
    select: { code: true, name: true, chairCwid: true },
  });

  // Compute fresh chair per dept using the in-memory SOR appointments and the
  // updated regex. Bypasses the DB's possibly-stale chairCwid.
  const computedChairByDept = new Map<string, { cwid: string; title: string } | null>();
  for (const dept of departments) {
    let best: { cwid: string; title: string; isPrimary: boolean; startDate: number } | null = null;
    for (const a of apptRecords) {
      if (a.endDate !== null) continue;
      if (!isChairTitleFor(a.title, dept.name)) continue;
      const score = {
        cwid: a.cwid,
        title: a.title,
        isPrimary: a.isPrimary,
        startDate: a.startDate?.getTime() ?? 0,
      };
      if (
        !best ||
        (score.isPrimary && !best.isPrimary) ||
        (score.isPrimary === best.isPrimary && score.startDate > best.startDate)
      ) {
        best = score;
      }
    }
    computedChairByDept.set(
      dept.code,
      best ? { cwid: best.cwid, title: best.title } : null,
    );
  }

  let divisions = await prisma.division.findMany({
    select: { code: true, name: true, deptCode: true, chiefCwid: true },
    orderBy: [{ deptCode: "asc" }, { name: "asc" }],
  });
  if (restrictToDept) {
    divisions = divisions.filter((d) => d.deptCode === restrictToDept);
  }
  const deptByCode = new Map(departments.map((d) => [d.code, d]));

  // Pull preferred names for any CWID that surfaces in the report — read once.
  const reportCwids = new Set<string>();
  for (const div of divisions) {
    for (const m of divisionMembers.get(div.code) ?? []) reportCwids.add(m);
  }
  for (const v of computedChairByDept.values()) {
    if (v) reportCwids.add(v.cwid);
  }
  for (const m of managerByCwid.values()) if (m) reportCwids.add(m);
  const scholars = await prisma.scholar.findMany({
    where: { cwid: { in: Array.from(reportCwids) } },
    select: { cwid: true, preferredName: true },
  });
  const nameByCwid = new Map(scholars.map((s) => [s.cwid, s.preferredName]));
  function label(cwid: string | null | undefined): string {
    if (!cwid) return "<null>";
    const n = nameByCwid.get(cwid);
    return n ? `${cwid} (${n})` : `${cwid} (not in DB)`;
  }

  const counts: Record<ChiefVerdict, number> = {
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    NONE: 0,
    GAP: 0,
  };

  console.log("\n# Per-division chief detection report\n");

  for (const div of divisions) {
    const dept = deptByCode.get(div.deptCode);
    const computedChair = computedChairByDept.get(div.deptCode);
    const members = Array.from(divisionMembers.get(div.code) ?? []);

    const result = detectDivisionChief({
      divCode: div.code,
      members,
      parentChairCwid: computedChair?.cwid ?? null,
      managerByCwid,
      appointmentsByCwid: apptsByCwid,
    });
    const verdict = result.verdict;
    const bestPick = result.topPick;
    const candidatesRanked = result.candidates;

    counts[verdict] += 1;

    console.log(
      `[${verdictLabel(verdict)}] ${div.code} ${div.name}  (parent ${dept?.code ?? "?"} ${dept?.name ?? ""})`,
    );
    console.log(
      `   parent chair (computed): ${computedChair ? label(computedChair.cwid) + " — " + computedChair.title : "<not found>"}`,
    );
    console.log(`   division members:        ${members.length}`);
    if (bestPick) {
      const action = result.valueToWrite ? "WRITE" : "skip (verdict gate)";
      console.log(`   → best pick:             ${label(bestPick)}  [${action}]`);
    }
    if (candidatesRanked.length > 0) {
      console.log(`   candidates (ranked):`);
      for (const c of candidatesRanked.slice(0, 5)) {
        const earliestStr =
          c.earliest === Infinity ? "?" : new Date(c.earliest).toISOString().slice(0, 10);
        console.log(
          `     - ${label(c.cwid)}  reportees=${c.reportees}  primary-in-div=${c.primaryCount}/${c.apptCount}  earliest=${earliestStr}`,
        );
      }
      if (candidatesRanked.length > 5) {
        console.log(`     ... and ${candidatesRanked.length - 5} more`);
      }
    } else if (verdict === "NONE") {
      console.log(`   no division member reports to the parent chair`);
    }
    if (div.chiefCwid && div.chiefCwid !== bestPick) {
      console.log(`   note: DB currently has chiefCwid=${label(div.chiefCwid)}`);
    }
    console.log();
  }

  console.log("--- summary ---");
  for (const v of ["HIGH", "MEDIUM", "LOW", "NONE", "GAP"] as ChiefVerdict[]) {
    console.log(`  ${verdictLabel(v).trim()}: ${counts[v]}`);
  }
  const total = divisions.length;
  const usable = counts.HIGH + counts.MEDIUM;
  console.log(
    `  Path B usable (HIGH+MEDIUM): ${usable}/${total} (${total > 0 ? ((usable / total) * 100).toFixed(0) : 0}%)`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
