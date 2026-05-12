/**
 * Jenzabar ETL — PhD primary-mentor (thesis advisor) relationships.
 *
 * Pulls every row from `TmsEPly.dbo.WCN_IDM_GS_ADVISOR_ADVISEE_View` where
 * ADVISOR_TYPE = 'MAJSP' (Major Sponsor). MDPHD-type rows are administrative
 * (4 distinct "advisors" who are MD-PhD program officers, not thesis mentors)
 * and intentionally skipped — see etl/jenzabar/probe-mdphd.ts.
 *
 * Truncate-and-rebuild into `phd_mentor_relationship`, matching the ASMS
 * education pattern (etl/asms/index.ts). No FK to Scholar — mentees may be
 * alumni not present locally; lib/api/mentoring.ts handles unlinked chips.
 *
 * Program-type resolution:
 *   - mentee CWID present in Scholar with roleCategory='doctoral_student_mdphd'
 *     → "MD-PhD"
 *   - otherwise → "PhD"
 *   (Pre-LDAP alumni absent from Scholar default to "PhD".)
 *
 * Usage: `npm run etl:jenzabar`
 */
import { prisma } from "../../lib/db";
import { closeJenzabarPool, getJenzabarPool } from "@/lib/sources/mssql-jenzabar";

const VIEW = "[TmsEPly].[dbo].[WCN_IDM_GS_ADVISOR_ADVISEE_View]";
const INSERT_BATCH = 500;

type MajspRow = {
  ADVISOR_ID: number;
  STUDENT_ID: number;
  ADVISOR_CWID: string | null;
  ADVISOR_FName: string | null;
  ADVISOR_LName: string | null;
  ADVISOR_EMAIL: string | null;
  GS_DEPT_DESC: string | null;
  GS_DIV_DESC: string | null;
  ADVISOR_STATUS: string;
  CWID: string | null;
  STUDENT_FName: string | null;
  STUDENT_LName: string | null;
  CONFERRAL_DATE: Date | null;
  MAJOR1_DESC: string | null;
};

function trim(s: string | null): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" ? null : t;
}

function stripLocatedAt(s: string | null): string | null {
  const t = trim(s);
  if (!t) return null;
  return t.replace(/^Located at\s+/i, "");
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: { id: crypto.randomUUID(), source: "Jenzabar", status: "running" },
  });

  try {
    console.log("Querying Jenzabar for MAJSP mentor-mentee rows...");
    const pool = await getJenzabarPool();
    const result = await pool.request().query<MajspRow>(`
      SELECT
        ADVISOR_ID, STUDENT_ID,
        ADVISOR_CWID, ADVISOR_FName, ADVISOR_LName, ADVISOR_EMAIL,
        GS_DEPT_DESC, GS_DIV_DESC, ADVISOR_STATUS,
        CWID, STUDENT_FName, STUDENT_LName, CONFERRAL_DATE, MAJOR1_DESC
      FROM ${VIEW}
      WHERE ADVISOR_TYPE = 'MAJSP'
        AND ADVISOR_CWID IS NOT NULL AND ADVISOR_CWID <> ''
        AND CWID IS NOT NULL AND CWID <> ''
    `);
    const rows = result.recordset;
    console.log(`Got ${rows.length} MAJSP rows.`);

    // Resolve programType per mentee CWID via local Scholar role.
    const menteeCwids = [...new Set(rows.map((r) => r.CWID!.trim()))];
    const mdphdSet = new Set(
      (
        await prisma.scholar.findMany({
          where: {
            cwid: { in: menteeCwids },
            roleCategory: "doctoral_student_mdphd",
            deletedAt: null,
          },
          select: { cwid: true },
        })
      ).map((s) => s.cwid),
    );
    console.log(`Of ${menteeCwids.length} distinct mentees, ${mdphdSet.size} resolve as MD-PhD via Scholar.`);

    const inserts = rows.map((r) => {
      const menteeCwid = r.CWID!.trim();
      const conferralYear =
        r.CONFERRAL_DATE && !Number.isNaN(r.CONFERRAL_DATE.getTime())
          ? r.CONFERRAL_DATE.getFullYear()
          : null;
      return {
        mentorCwid: r.ADVISOR_CWID!.trim(),
        menteeCwid,
        mentorFirstName: trim(r.ADVISOR_FName),
        mentorLastName: trim(r.ADVISOR_LName),
        mentorEmail: trim(r.ADVISOR_EMAIL),
        mentorDepartment: trim(r.GS_DEPT_DESC),
        mentorInstitution: stripLocatedAt(r.GS_DIV_DESC),
        menteeFirstName: trim(r.STUDENT_FName),
        menteeLastName: trim(r.STUDENT_LName),
        conferralYear,
        majorDesc: trim(r.MAJOR1_DESC),
        advisorStatus: r.ADVISOR_STATUS?.trim() || "I",
        programType: mdphdSet.has(menteeCwid) ? "MD-PhD" : "PhD",
        externalId: `JENZABAR-${r.ADVISOR_ID}-${r.STUDENT_ID}`,
        source: "JENZABAR-MAJSP",
      };
    });

    console.log("Truncating phd_mentor_relationship...");
    await prisma.phdMentorRelationship.deleteMany();

    console.log(`Inserting ${inserts.length} rows...`);
    let inserted = 0;
    for (const batch of chunks(inserts, INSERT_BATCH)) {
      await prisma.phdMentorRelationship.createMany({
        data: batch,
        skipDuplicates: true,
      });
      inserted += batch.length;
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: inserts.length },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `Jenzabar ETL complete in ${elapsed}s: rows=${inserts.length} (PhD=${inserts.filter((i) => i.programType === "PhD").length}, MD-PhD=${inserts.filter((i) => i.programType === "MD-PhD").length})`,
    );
  } catch (err) {
    await prisma.etlRun.update({
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
    await prisma.$disconnect();
    await closeJenzabarPool();
  });
