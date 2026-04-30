/**
 * ASMS ETL — Phase 4c. Education and training records.
 *
 * Pulls degrees from `asms.dbo.wcmc_person_school` joined with
 * `wcmc_person`, `wcmc_school`, and `wcmc_school_degree`. Filtered to
 * currently-active scholars (joined by cwid).
 *
 * Strategy:
 *   1. Read active CWIDs from local DB
 *   2. Batched IN-clause query against ASMS for education rows
 *   3. Truncate education table; bulk-insert fresh rows
 *
 * MSSQL note: the `mssql` driver doesn't have native array-IN binding, so we
 * generate parameter placeholders dynamically (@p0,@p1,...). Batch size 500
 * keeps us well under MSSQL's 2100-parameter ceiling.
 *
 * Usage: `npm run etl:asms`
 */
import { prisma } from "@/lib/db";
import { closeAsmsPool, getAsmsPool } from "@/lib/sources/mssql-asms";

type EducationRow = {
  cwid: string;
  degree: string | null;
  institution: string | null;
  year: number | null;
  field: string | null;
  asms_school_id: number; // for externalId / dedup
};

const IN_BATCH = 500;
const INSERT_BATCH = 1000;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: { source: "ASMS", status: "running" },
  });

  try {
    console.log("Loading active CWIDs from local DB...");
    const ourScholars = await prisma.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const cwidList = ourScholars.map((s) => s.cwid);
    const ourCwidSet = new Set(cwidList);
    console.log(`Querying ASMS for education of ${cwidList.length} active CWIDs...`);

    const pool = await getAsmsPool();
    const educationRows: EducationRow[] = [];

    for (const batch of chunks(cwidList, IN_BATCH)) {
      const placeholders = batch.map((_, i) => `@p${i}`).join(",");
      const req = pool.request();
      batch.forEach((c, i) => req.input(`p${i}`, c));
      const result = await req.query(`
        SELECT
          p.cwid          AS cwid,
          n.title         AS degree,
          c.title         AS institution,
          s.grad_year     AS year,
          s.degree_field  AS field,
          s.id            AS asms_school_id
        FROM asms.dbo.wcmc_person_school s
        JOIN asms.dbo.wcmc_person         p ON p.id = s.person_id
        LEFT JOIN asms.dbo.wcmc_school_degree n ON n.id = s.degree_id
        LEFT JOIN asms.dbo.wcmc_school        c ON c.id = s.school_id
        WHERE p.cwid IN (${placeholders})
          AND s.grad_year IS NOT NULL
      `);
      educationRows.push(...(result.recordset as EducationRow[]));
    }

    console.log(`Got ${educationRows.length} education rows.`);

    // Truncate and bulk-insert.
    console.log("Resetting education table...");
    await prisma.education.deleteMany();

    const inserts = educationRows
      .filter((r) => ourCwidSet.has(r.cwid))
      .map((r) => ({
        cwid: r.cwid,
        degree: r.degree ?? "(unspecified degree)",
        institution: r.institution ?? "(unspecified institution)",
        year: r.year,
        field: r.field,
        externalId: `ASMS-${r.asms_school_id}`,
        source: "ASMS",
      }));

    console.log(`Inserting ${inserts.length} education rows...`);
    let inserted = 0;
    for (const batch of chunks(inserts, INSERT_BATCH)) {
      await prisma.education.createMany({ data: batch, skipDuplicates: true });
      inserted += batch.length;
      if (inserted % (INSERT_BATCH * 10) === 0) {
        console.log(`  ...${inserted}/${inserts.length}`);
      }
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: inserts.length,
      },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`ASMS ETL complete in ${elapsed}s: education rows=${inserts.length}`);
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
    await closeAsmsPool();
  });
