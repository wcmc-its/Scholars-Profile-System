/**
 * Standalone runner for the issue-#183 postdoc mentor-relationship pass.
 *
 * Pulls postdoc role records from ED (`ou=employees,ou=sors`, active +
 * expired) on a short-lived dedicated LDAP client, resolves alumni names
 * from `ou=people`, then upserts the local `postdoc_mentor_relationship`
 * table and tombstones rows whose externalId is no longer in ED.
 *
 * This is the same logic the full ED ETL runs at the end of every refresh —
 * factored out for two reasons:
 *   1. Re-run after fixing connection-state bugs without redoing the full
 *      ED chain (4+ min).
 *   2. Local backfill when the relationship table is empty but the rest of
 *      the Scholar state is already current.
 *
 * Usage: `npx tsx scripts/etl-postdoc-mentees.ts`
 */
import { prisma } from "../lib/db";
import {
  type EdPostdocEmploymentRecord,
  fetchAllPostdocEmploymentRecords,
  fetchPersonNamesByCwid,
} from "../lib/sources/ldap";

async function main(): Promise<void> {
  console.log("Fetching postdoc employment role records (active + expired)...");
  let records: EdPostdocEmploymentRecord[];
  try {
    records = await fetchAllPostdocEmploymentRecords();
  } catch (err) {
    console.error(
      `Postdoc role-record fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const fetchedActive = records.filter((r) => r.status === "employee:active").length;
  const fetchedExpired = records.filter((r) => r.status === "employee:expired").length;
  console.log(
    `ED returned ${records.length} postdoc role records ` +
      `(${fetchedActive} active, ${fetchedExpired} expired).`,
  );
  if (fetchedActive > 0 && fetchedExpired === 0) {
    console.warn(
      "[ED] postdoc role-record fetch returned zero expired entries " +
        "despite an active+expired filter. The LDAP bind DN may be scoped " +
        "to employee:active rows only — alumni postdocs will not surface. " +
        "Verify the bind DN's read ACL covers " +
        "weillCornellEduStatus=employee:expired under ou=employees,ou=sors.",
    );
  }

  const withMentor = records.filter((r) => r.managerCwid);
  const orphanRoleRecords = records.length - withMentor.length;

  const allMenteeCwids = Array.from(new Set(withMentor.map((r) => r.cwid)));
  const scholarsByCwid = new Map(
    (
      await prisma.scholar.findMany({
        where: { cwid: { in: allMenteeCwids } },
        select: { cwid: true, preferredName: true, fullName: true },
      })
    ).map((s) => [s.cwid, s]),
  );
  const alumniCwids = allMenteeCwids.filter((c) => !scholarsByCwid.has(c));

  let alumniNames = new Map<
    string,
    { firstName: string | null; lastName: string | null }
  >();
  if (alumniCwids.length > 0) {
    try {
      alumniNames = await fetchPersonNamesByCwid(alumniCwids);
    } catch (err) {
      console.warn(
        `Alumni postdoc name lookup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const nameByCwid = new Map<
    string,
    { firstName: string | null; lastName: string | null }
  >();
  for (const cwid of allMenteeCwids) {
    const ldap = alumniNames.get(cwid);
    if (ldap) {
      nameByCwid.set(cwid, ldap);
      continue;
    }
    const scholar = scholarsByCwid.get(cwid);
    if (scholar) {
      const parts = (scholar.preferredName || scholar.fullName).trim().split(/\s+/);
      nameByCwid.set(cwid, {
        firstName: parts[0] ?? null,
        lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
      });
    }
  }

  const seenExternalIds = new Set<string>();
  let upserted = 0;
  for (const r of withMentor) {
    const externalId = `ED-POSTDOC-${r.sorId}`;
    seenExternalIds.add(externalId);
    const name = nameByCwid.get(r.cwid);
    await prisma.postdocMentorRelationship.upsert({
      where: { externalId },
      create: {
        externalId,
        mentorCwid: r.managerCwid!,
        menteeCwid: r.cwid,
        menteeFirstName: name?.firstName ?? null,
        menteeLastName: name?.lastName ?? null,
        startDate: r.startDate,
        endDate: r.endDate,
        title: r.title,
        status: r.status,
        programType: "POSTDOC",
        source: "ED-EMPLOYEE-SOR",
      },
      update: {
        mentorCwid: r.managerCwid!,
        menteeCwid: r.cwid,
        menteeFirstName: name?.firstName ?? null,
        menteeLastName: name?.lastName ?? null,
        startDate: r.startDate,
        endDate: r.endDate,
        title: r.title,
        status: r.status,
        lastRefreshedAt: new Date(),
      },
    });
    upserted += 1;
  }

  const existing = await prisma.postdocMentorRelationship.findMany({
    select: { externalId: true },
  });
  const stale = existing
    .map((row) => row.externalId)
    .filter((eid) => !seenExternalIds.has(eid));
  let deleted = 0;
  if (stale.length > 0) {
    const res = await prisma.postdocMentorRelationship.deleteMany({
      where: { externalId: { in: stale } },
    });
    deleted = res.count;
  }

  const activeCount = withMentor.filter((r) => r.status === "employee:active").length;
  const expiredCount = withMentor.length - activeCount;
  console.log(
    `[ED] postdoc mentees: ${upserted} relationships upserted ` +
      `(${activeCount} active, ${expiredCount} alumni; ` +
      `${orphanRoleRecords} role records skipped — no manager DN; ` +
      `${alumniCwids.length} alumni names resolved from ou=people; ` +
      `${deleted} stale rows tombstoned)`,
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("FATAL", err);
  await prisma.$disconnect();
  process.exit(1);
});
