/**
 * Faculty Review Tool mentees → frt_mentee.
 *
 * FRT is an annual self-report: each faculty member (cwid) lists mentees by
 * free-text name. Reads the current review year and the historic table, keeps
 * one row per (mentor, name key) with the latest year's name/type, and resolves
 * a CWID only for an internal mentee whose first+last key matches exactly one
 * person (scholar + the PhD/postdoc/AOC mentee rosters). A name that reaches one
 * person only through a nickname is stored as `suggested_cwid` for the mentor
 * to confirm on /edit, never as the link. Runs weekly so a new
 * review year shows up whenever FRT publishes it.
 *
 * Usage: `npm run etl:frt`
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { frtNameKey, resolveFrtMentee } from "@/lib/frt/mentee-name";
import { closeCoiFrtPool, getCoiFrtPool } from "@/lib/sources/mssql-coi-frt";

type Row = {
  cwid: string;
  review_year: number | null;
  external_mentee: string | null;
  external_mentee_name: string;
  external_mentee_type: string | null;
};

const INSERT_BATCH = 1000;
const clip = (s: string | null) => (s ? s.trim().slice(0, 255) || null : null);

async function buildNameIndex(): Promise<Map<string, Set<string>>> {
  const idx = new Map<string, Set<string>>();
  const add = (cwid: string, ...names: (string | null | undefined)[]) => {
    for (const n of names) {
      const k = frtNameKey(n);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k)!.add(cwid);
    }
  };
  for (const s of await db.write.scholar.findMany({
    where: { deletedAt: null },
    select: { cwid: true, preferredName: true, fullName: true },
  }))
    add(s.cwid, s.preferredName, s.fullName);
  for (const m of await db.write.phdMentorRelationship.findMany({
    select: { menteeCwid: true, menteeFirstName: true, menteeLastName: true },
  }))
    add(m.menteeCwid, `${m.menteeFirstName ?? ""} ${m.menteeLastName ?? ""}`);
  for (const m of await db.write.postdocMentorRelationship.findMany({
    select: { menteeCwid: true, menteeFirstName: true, menteeLastName: true },
  }))
    add(m.menteeCwid, `${m.menteeFirstName ?? ""} ${m.menteeLastName ?? ""}`);
  for (const m of await db.write.aocMentee.findMany({
    select: { menteeCwid: true, firstName: true, lastName: true },
  }))
    add(m.menteeCwid, `${m.firstName ?? ""} ${m.lastName ?? ""}`);
  return idx;
}

async function main() {
  const start = new Date();
  const run = await db.write.etlRun.create({ data: { source: "FRT", status: "running" } });

  try {
    const mentors = new Set(
      (
        await db.write.scholar.findMany({
          where: { deletedAt: null, status: "active" },
          select: { cwid: true },
        })
      ).map((s) => s.cwid),
    );

    const pool = await getCoiFrtPool();
    const cols = `cwid, review_year, external_mentee, external_mentee_name, external_mentee_type`;
    const where = `WHERE cwid IS NOT NULL AND ISNULL(external_mentee_name, '') <> ''`;
    const rows = (
      await pool.request().query<Row>(
        `SELECT ${cols} FROM dbo.frt_mentor_mentees ${where}
           UNION ALL SELECT ${cols} FROM dbo.frt_mentor_mentees_historic ${where}`,
      )
    ).recordset;
    console.log(`FRT returned ${rows.length} named-mentee rows.`);

    // One entry per (mentor, name key); the latest review year wins the display fields.
    type Agg = { row: Row; key: string; first: number; last: number };
    const byPair = new Map<string, Agg>();
    for (const r of rows) {
      if (!mentors.has(r.cwid)) continue;
      const key = frtNameKey(r.external_mentee_name);
      if (!key) continue;
      const year = r.review_year ?? 0;
      const id = `${r.cwid}|${key}`;
      const a = byPair.get(id);
      if (!a) byPair.set(id, { row: r, key, first: year, last: year });
      else {
        a.first = Math.min(a.first, year);
        if (year >= a.last) {
          a.last = year;
          a.row = r;
        }
      }
    }

    const idx = await buildNameIndex();
    // Mentor decisions (dismissals, hand-assigned CWIDs) survive the rebuild.
    const decided = new Map(
      (
        await db.write.frtMentee.findMany({
          where: { OR: [{ dismissedAt: { not: null } }, { cwidAssignedAt: { not: null } }] },
          select: {
            mentorCwid: true,
            nameKey: true,
            menteeCwid: true,
            dismissedAt: true,
            dismissedBy: true,
            cwidAssignedAt: true,
            cwidAssignedBy: true,
          },
        })
      ).map((d) => [`${d.mentorCwid}|${d.nameKey}`, d]),
    );

    let matched = 0;
    // Unlinked internal mentees whose name reaches exactly one person only via a
    // nickname: stored as a suggestion for the mentor, never as the link.
    let suggested = 0;
    const inserts = [...byPair.entries()].map(([id, a]) => {
      const external = a.row.external_mentee === "Yes";
      const d = decided.get(id);
      let menteeCwid: string | null;
      let suggestedCwid: string | null = null;
      if (d?.cwidAssignedAt) menteeCwid = d.menteeCwid;
      else ({ menteeCwid, suggestedCwid } = resolveFrtMentee(idx, a.key, a.row.cwid, external));
      if (suggestedCwid) suggested++;
      if (menteeCwid) matched++;
      return {
        mentorCwid: a.row.cwid,
        menteeCwid,
        suggestedCwid,
        menteeName: clip(a.row.external_mentee_name)!,
        nameKey: a.key,
        mentoringType: clip(a.row.external_mentee_type),
        external,
        firstReviewYear: a.first,
        lastReviewYear: a.last,
        refreshedAt: start,
        dismissedAt: d?.dismissedAt ?? null,
        dismissedBy: d?.dismissedBy ?? null,
        cwidAssignedAt: d?.cwidAssignedAt ?? null,
        cwidAssignedBy: d?.cwidAssignedBy ?? null,
      };
    });
    console.log(
      `Mentor/mentee pairs: ${inserts.length} (CWID-matched: ${matched}; ` +
        `nickname-only suggestions, not linked: ${suggested}).`,
    );

    assertSourceVolume("frt:mentees", {
      incoming: inserts.length,
      existing: await db.write.frtMentee.count(),
      maxDropPct: 50,
    });

    await db.write.$transaction(
      async (tx) => {
        await tx.frtMentee.deleteMany();
        for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
          await tx.frtMentee.createMany({ data: inserts.slice(i, i + INSERT_BATCH) });
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: inserts.length },
    });
    console.log(`FRT ETL complete in ${Math.round((Date.now() - start.getTime()) / 1000)}s.`);
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
    await closeCoiFrtPool();
  });
