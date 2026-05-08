/**
 * Probe for Path B viability (issue #16, "Populate Division.chiefCwid").
 *
 * For each known-chief CWID provided on the command line, dump:
 *   1. employee SOR  → manager CWID (parsed from the `manager` DN)
 *   2. faculty SOR   → primary appointment's division code (level2) and name
 *   3. our DB        → parent department's chair CWID
 *   4. verdict       → does the manager equal the parent-dept chair?
 *
 * The Path B hypothesis is: "the chief of division X under dept Y is the
 * faculty member in X whose manager is the chair of Y." This probe answers
 * whether that hypothesis holds in WCM data; if 80%+ of known chiefs come up
 * YES, ship Path B as the primary detector.
 *
 * Usage:
 *   npx tsx etl/ed/probe-chiefs.ts <cwid> [<cwid> ...]
 *
 * Requires SCHOLARS_LDAP_URL, SCHOLARS_LDAP_BIND_PASSWORD, DATABASE_URL.
 * Read-only — does not modify any DB or LDAP state.
 */
import "dotenv/config";
import { prisma } from "../../lib/db";
import {
  collapseEmployeeRecordsByCwid,
  fetchActiveEmployeeRecords,
  fetchActiveFacultyAppointments,
  openLdap,
} from "../../lib/sources/ldap";

async function main() {
  const cwids = process.argv
    .slice(2)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (cwids.length === 0) {
    console.error(
      "Usage: tsx etl/ed/probe-chiefs.ts <cwid> [<cwid> ...]\n" +
        "Provide CWIDs of faculty you know to be division chiefs.",
    );
    process.exit(1);
  }

  console.log(`Probing ${cwids.length} candidate chief CWID(s) against ED + DB...\n`);

  const client = await openLdap();
  console.log("Fetching employee SOR records...");
  const empRecords = await fetchActiveEmployeeRecords(client);
  console.log(`  ${empRecords.length} active employee SOR rows`);
  const empByCwid = collapseEmployeeRecordsByCwid(empRecords);

  console.log("Fetching faculty SOR appointments...");
  const apptRecords = await fetchActiveFacultyAppointments(client);
  console.log(`  ${apptRecords.length} active faculty appointment rows`);
  await client.unbind();

  const apptsByCwid = new Map<string, typeof apptRecords>();
  for (const a of apptRecords) {
    const arr = apptsByCwid.get(a.cwid.toLowerCase()) ?? [];
    arr.push(a);
    apptsByCwid.set(a.cwid.toLowerCase(), arr);
  }

  let yes = 0;
  let no = 0;
  let inconclusive = 0;

  for (const cwid of cwids) {
    const emp = empByCwid.get(cwid);
    const appts = apptsByCwid.get(cwid) ?? [];
    const primaryAppt = appts.find((a) => a.isPrimary) ?? appts[0] ?? null;
    const divCode = primaryAppt?.divCode ?? null;
    const divName = primaryAppt?.divName ?? null;

    let parentDeptCode: string | null = null;
    let parentDeptName: string | null = null;
    let chairCwid: string | null = null;

    if (divCode) {
      const div = await prisma.division.findUnique({
        where: { code: divCode },
        include: { department: true },
      });
      if (div) {
        parentDeptCode = div.deptCode;
        parentDeptName = div.department.name;
        chairCwid = div.department.chairCwid;
      }
    }

    const managerCwid = emp?.managerCwid ?? null;
    let verdict: "YES" | "NO" | "INCONCLUSIVE";
    if (!managerCwid || !chairCwid) {
      verdict = "INCONCLUSIVE";
      inconclusive += 1;
    } else if (managerCwid === chairCwid) {
      verdict = "YES";
      yes += 1;
    } else {
      verdict = "NO";
      no += 1;
    }

    console.log(`\n=== ${cwid} ===`);
    console.log(`  manager CWID (employee SOR):     ${managerCwid ?? "<null>"}`);
    console.log(`  primary division (faculty SOR):  ${divCode ?? "<null>"}  ${divName ?? ""}`);
    console.log(`  parent dept (DB):                ${parentDeptCode ?? "<null>"}  ${parentDeptName ?? ""}`);
    console.log(`  parent dept chair (DB):          ${chairCwid ?? "<null>"}`);
    console.log(`  manager == chair?                ${verdict}`);
    if (appts.length > 1) {
      console.log(`  (this scholar has ${appts.length} active appointments; reporting primary)`);
    }
  }

  const total = cwids.length;
  const ratio = total > 0 ? yes / total : 0;
  console.log("\n--- summary ---");
  console.log(`  YES:           ${yes}/${total}`);
  console.log(`  NO:            ${no}/${total}`);
  console.log(`  INCONCLUSIVE:  ${inconclusive}/${total}`);
  console.log(`  YES ratio:     ${(ratio * 100).toFixed(0)}%`);
  if (ratio >= 0.8) {
    console.log("  → Path B viable. Ship manager-graph detection.");
  } else if (yes >= no) {
    console.log("  → Path B borderline. Run with a larger sample or rely on Path C overrides.");
  } else {
    console.log("  → Path B not viable. Rely on Path C overrides only (set SCHOLARS_DISABLE_CHIEF_DETECTION=true).");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
