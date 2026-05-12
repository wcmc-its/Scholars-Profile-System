/**
 * Jenzabar connectivity + schema probe.
 *
 * Goals:
 *   1. Verify SQL login + network reachability.
 *   2. Discover which database hosts WCN_IDM_GS_ADVISOR_ADVISEE_View (the user's
 *      SCHOLARS_JENZABAR_DATABASE may be unset; we enumerate sys.databases and
 *      check each for the view).
 *   3. Dump the view's column list, row count, ADVISOR_TYPE distribution, and
 *      5 sample rows filtered to ADVISOR_TYPE = 'MAJSP'.
 *
 * Run: npx tsx etl/jenzabar/probe.ts
 *
 * Read-only.
 */
import "dotenv/config";
import { closeJenzabarPool, getJenzabarPool } from "@/lib/sources/mssql-jenzabar";

const VIEW_NAME = "WCN_IDM_GS_ADVISOR_ADVISEE_View";

async function main() {
  const pool = await getJenzabarPool();

  console.log("\n========== Connection ==========");
  const conn = (
    await pool.request().query<{
      server_name: string;
      current_database: string;
      login_name: string;
    }>(
      `SELECT @@SERVERNAME AS server_name, DB_NAME() AS current_database, SUSER_SNAME() AS login_name`,
    )
  ).recordset[0];
  console.log(`  server:    ${conn.server_name}`);
  console.log(`  login:     ${conn.login_name}`);
  console.log(`  default DB: ${conn.current_database}`);

  console.log("\n========== Locating view across databases ==========");
  const dbs = (
    await pool.request().query<{ name: string }>(
      `SELECT name FROM sys.databases
       WHERE state_desc = 'ONLINE' AND name NOT IN ('master','tempdb','model','msdb')
       ORDER BY name`,
    )
  ).recordset.map((r) => r.name);

  let foundDb: string | null = null;
  let foundSchema: string | null = null;
  for (const db of dbs) {
    try {
      const rows = (
        await pool.request().input("vname", VIEW_NAME).query<{
          TABLE_SCHEMA: string;
          TABLE_NAME: string;
        }>(
          `SELECT TABLE_SCHEMA, TABLE_NAME
           FROM [${db}].INFORMATION_SCHEMA.VIEWS
           WHERE TABLE_NAME = @vname`,
        )
      ).recordset;
      if (rows.length > 0) {
        foundDb = db;
        foundSchema = rows[0].TABLE_SCHEMA;
        console.log(`  FOUND  ${db}.${rows[0].TABLE_SCHEMA}.${rows[0].TABLE_NAME}`);
        break;
      }
    } catch (e) {
      console.log(`  skip   ${db} (${(e as Error).message.slice(0, 60)})`);
    }
  }
  if (!foundDb || !foundSchema) {
    console.log(`  View ${VIEW_NAME} not found in any accessible database.`);
    await closeJenzabarPool();
    return;
  }
  const fq = `[${foundDb}].[${foundSchema}].[${VIEW_NAME}]`;
  console.log(`\n  >>> Set SCHOLARS_JENZABAR_DATABASE="${foundDb}" in your env <<<\n`);

  console.log("\n========== Columns ==========");
  const cols = (
    await pool
      .request()
      .input("schema", foundSchema)
      .input("table", VIEW_NAME)
      .query<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
         FROM [${foundDb}].INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
         ORDER BY ORDINAL_POSITION`,
      )
  ).recordset;
  for (const c of cols) {
    console.log(`  ${c.COLUMN_NAME.padEnd(40)} ${c.DATA_TYPE.padEnd(15)} ${c.IS_NULLABLE}`);
  }

  console.log("\n========== Row count ==========");
  const total = (await pool.request().query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${fq}`))
    .recordset[0].n;
  console.log(`  total rows: ${total}`);

  console.log("\n========== ADVISOR_TYPE distribution ==========");
  const dist = (
    await pool.request().query<{ ADVISOR_TYPE: string | null; n: number }>(
      `SELECT ADVISOR_TYPE, COUNT(*) AS n FROM ${fq} GROUP BY ADVISOR_TYPE ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of dist) {
    console.log(`  ${(r.ADVISOR_TYPE ?? "(null)").padEnd(20)} ${r.n}`);
  }

  console.log("\n========== Sample rows (MAJSP, first 5) ==========");
  const sample = (
    await pool.request().query<Record<string, unknown>>(
      `SELECT TOP 5 * FROM ${fq} WHERE ADVISOR_TYPE = 'MAJSP'`,
    )
  ).recordset;
  for (const r of sample) {
    console.log("  ---");
    for (const [k, v] of Object.entries(r)) {
      console.log(`    ${k.padEnd(30)} ${v === null ? "(null)" : String(v).slice(0, 100)}`);
    }
  }

  await closeJenzabarPool();
}

main().catch(async (e) => {
  console.error(e);
  await closeJenzabarPool();
  process.exit(1);
});
