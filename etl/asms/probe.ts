/**
 * ASMS schema probe — confirm columns and row counts of the tables we plan to
 * query for education. Mirrors the institutional client's join shape:
 *
 *   wcmc_person_school s
 *     LEFT JOIN wcmc_person p   ON p.id = s.person_id
 *     LEFT JOIN wcmc_school_degree n ON n.id = s.degree_id
 *     LEFT JOIN wcmc_school c   ON c.id = s.school_id
 *
 * Usage: `npm run etl:asms:probe`
 */
import { closeAsmsPool, getAsmsPool } from "@/lib/sources/mssql-asms";

const TABLES = [
  "asms.dbo.wcmc_person",
  "asms.dbo.wcmc_person_school",
  "asms.dbo.wcmc_school",
  "asms.dbo.wcmc_school_degree",
  "asms.dbo.fc_doctoral_training",
  "asms.dbo.wcmc_institution",
];

async function main() {
  const pool = await getAsmsPool();
  for (const t of TABLES) {
    const [db, schema, table] = t.split(".");
    console.log(`\n=== ${t} ===`);
    try {
      const cols = (
        await pool
          .request()
          .input("schema", schema)
          .input("table", table)
          .query(
            `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
             FROM ${db}.INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
             ORDER BY ORDINAL_POSITION`,
          )
      ).recordset as Array<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>;

      if (cols.length === 0) {
        console.log("  (no columns / table not found)");
        continue;
      }
      for (const c of cols) {
        console.log(`  ${c.COLUMN_NAME.padEnd(30)} ${c.DATA_TYPE.padEnd(15)} ${c.IS_NULLABLE}`);
      }
      const cnt = (await pool.request().query(`SELECT COUNT(*) AS n FROM ${t}`)).recordset[0]
        ?.n;
      console.log(`  -- ${cnt ?? "?"} rows`);
    } catch (e) {
      console.log(`  (probe error: ${(e as Error).message.split("\n")[0]})`);
    }
  }

  // Sample rows from the join, to confirm column meanings.
  console.log("\n=== sample education rows (top 3) ===");
  try {
    const rows = (
      await pool.request().query(`
        SELECT TOP 3
          p.cwid, n.title AS degree, n.short_title AS degree_short, c.title AS institution,
          s.grad_year AS year, s.major AS field
        FROM asms.dbo.wcmc_person_school s
        LEFT JOIN asms.dbo.wcmc_person p ON p.id = s.person_id
        LEFT JOIN asms.dbo.wcmc_school_degree n ON n.id = s.degree_id
        LEFT JOIN asms.dbo.wcmc_school c ON c.id = s.school_id
        WHERE p.cwid IS NOT NULL AND p.cwid <> '' AND s.grad_year IS NOT NULL
        ORDER BY p.cwid
      `)
    ).recordset;
    console.log(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.log(`  (sample error: ${(e as Error).message.split("\n")[0]})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await closeAsmsPool();
  });
