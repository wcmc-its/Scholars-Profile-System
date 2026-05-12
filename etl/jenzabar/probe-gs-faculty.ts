/**
 * Jenzabar connectivity + schema probe for `WCN_vw_GS_Faculty_LR`.
 *
 * Discovery for the Graduate School faculty appointments import (issue #193).
 * Produces the data the writeup (`docs/etl/jenzabar-gs-faculty-probe.md`) needs
 * to pin the three open decisions.
 *
 * Notes from the first run (2026-05-12):
 *   - `Degree_Code` is column-level SELECT-denied for `IDM_JZBR`, so `SELECT *`
 *     and any `SELECT COUNT(*)` that doesn't avoid `*` fail. The probe builds
 *     explicit column lists that exclude denied columns. If you see other
 *     "SELECT permission was denied on the column X" errors, add X to
 *     `DENIED_COLUMNS` below.
 *   - The view is "wide": one row per faculty with up to 3 PhD appointment
 *     columns + 2 MS appointment columns. Multiplicity is structural, not
 *     row-based.
 *
 * Run: `npm run etl:jenzabar:probe-gs-faculty`
 *
 * Read-only.
 */
import "dotenv/config";
import { closeJenzabarPool, getJenzabarPool } from "@/lib/sources/mssql-jenzabar";

const VIEW_NAME = "WCN_vw_GS_Faculty_LR";

/** Columns the IDM_JZBR principal cannot SELECT. Excluded from every query. */
const DENIED_COLUMNS = new Set<string>(["Degree_Code"]);

function bracket(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

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
  console.log(`  server:     ${conn.server_name}`);
  console.log(`  login:      ${conn.login_name}`);
  console.log(`  default DB: ${conn.current_database}`);

  console.log("\n========== Locating view ==========");
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
    } catch {
      // permission-denied dbs are skipped silently here
    }
  }
  if (!foundDb || !foundSchema) {
    console.log(`  View ${VIEW_NAME} not found in any accessible database.`);
    await closeJenzabarPool();
    return;
  }
  const fq = `[${foundDb}].[${foundSchema}].[${VIEW_NAME}]`;

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
    const flag = DENIED_COLUMNS.has(c.COLUMN_NAME) ? " [SELECT DENIED]" : "";
    console.log(`  ${c.COLUMN_NAME.padEnd(40)} ${c.DATA_TYPE.padEnd(15)} ${c.IS_NULLABLE}${flag}`);
  }

  const allowedCols = cols
    .filter((c) => !DENIED_COLUMNS.has(c.COLUMN_NAME))
    .map((c) => c.COLUMN_NAME);
  const allowedSelect = allowedCols.map(bracket).join(", ");

  console.log("\n========== Row count ==========");
  const total = (
    await pool.request().query<{ n: number }>(`SELECT COUNT_BIG(JID) AS n FROM ${fq}`)
  ).recordset[0].n;
  console.log(`  total rows: ${total}`);

  console.log("\n========== FACULTY MASTER ACTIVE distribution ==========");
  const masterActive = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT [FACULTY MASTER ACTIVE] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [FACULTY MASTER ACTIVE] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of masterActive) {
    console.log(`  ${String(r.v ?? "(null)").padEnd(20)} ${r.n}`);
  }

  console.log("\n========== WCGS FACULTY STATUS distribution ==========");
  const wcgsStatus = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT [WCGS FACULTY STATUS] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [WCGS FACULTY STATUS] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of wcgsStatus) {
    console.log(`  ${String(r.v ?? "(null)").padEnd(20)} ${r.n}`);
  }

  console.log("\n========== NAME STATUS distribution ==========");
  const nameStatus = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT [NAME STATUS] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [NAME STATUS] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of nameStatus) {
    console.log(`  ${String(r.v ?? "(null)").padEnd(20)} ${r.n}`);
  }

  console.log("\n========== Is_Grad_Faculty_Member distribution ==========");
  const isGrad = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT [Is_Grad_Faculty_Member] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [Is_Grad_Faculty_Member] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of isGrad) {
    console.log(`  ${String(r.v ?? "(null)").padEnd(20)} ${r.n}`);
  }

  console.log("\n========== INSTRUCTOR TYPE distribution (top 20) ==========");
  const instrType = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT TOP 20 [INSTRUCTOR TYPE] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [INSTRUCTOR TYPE] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of instrType) {
    console.log(`  ${String(r.v ?? "(null)").padEnd(20)} ${r.n}`);
  }

  console.log("\n========== INSTITUTION distribution (top 20) ==========");
  const inst = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT TOP 20 [INSTITUTION] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [INSTITUTION] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of inst) {
    console.log(`  ${(r.v ?? "(null)").padEnd(50).slice(0, 50)} ${r.n}`);
  }

  console.log("\n========== DEPARTMENT distribution (top 30) ==========");
  const dept = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT TOP 30 [DEPARTMENT] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [DEPARTMENT] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of dept) {
    console.log(`  ${(r.v ?? "(null)").padEnd(50).slice(0, 50)} ${r.n}`);
  }

  console.log("\n========== WCGS DIVISION distribution (top 20) ==========");
  const div = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT TOP 20 [WCGS DIVISION] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [WCGS DIVISION] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of div) {
    console.log(`  ${(r.v ?? "(null)").padEnd(50).slice(0, 50)} ${r.n}`);
  }

  console.log("\n========== PRIMARY PHD AFFILIATION distribution (top 30) ==========");
  const phdPrim = (
    await pool.request().query<{ v: string | null; n: number }>(
      `SELECT TOP 30 [PRIMARY PHD AFFILIATION] AS v, COUNT_BIG(JID) AS n FROM ${fq}
       GROUP BY [PRIMARY PHD AFFILIATION] ORDER BY n DESC`,
    )
  ).recordset;
  for (const r of phdPrim) {
    console.log(`  ${(r.v ?? "(null)").padEnd(50).slice(0, 50)} ${r.n}`);
  }

  console.log("\n========== Identifier shape ==========");
  const idShape = (
    await pool.request().query<{
      total: number;
      with_cwid: number;
      with_jid: number;
      distinct_cwid: number;
      distinct_jid: number;
    }>(
      `SELECT
         COUNT_BIG(JID) AS total,
         SUM(CASE WHEN CWID IS NOT NULL AND CWID <> '' THEN 1 ELSE 0 END) AS with_cwid,
         SUM(CASE WHEN JID IS NOT NULL THEN 1 ELSE 0 END) AS with_jid,
         COUNT(DISTINCT CASE WHEN CWID IS NOT NULL AND CWID <> '' THEN CWID END) AS distinct_cwid,
         COUNT(DISTINCT JID) AS distinct_jid
       FROM ${fq}`,
    )
  ).recordset[0];
  console.log(`  total rows:       ${idShape.total}`);
  console.log(`  rows with CWID:   ${idShape.with_cwid}`);
  console.log(`  distinct CWIDs:   ${idShape.distinct_cwid}`);
  console.log(`  rows with JID:    ${idShape.with_jid}`);
  console.log(`  distinct JIDs:    ${idShape.distinct_jid}`);

  console.log("\n========== Multiplicity (rows per CWID) ==========");
  const mult = (
    await pool.request().query<{ rows_per_cwid: number; n: number }>(
      `SELECT rows_per_cwid, COUNT_BIG(rows_per_cwid) AS n
       FROM (SELECT CWID, COUNT_BIG(JID) AS rows_per_cwid FROM ${fq}
             WHERE CWID IS NOT NULL AND CWID <> ''
             GROUP BY CWID) t
       GROUP BY rows_per_cwid
       ORDER BY rows_per_cwid`,
    )
  ).recordset;
  console.log(`  rows-per-CWID  count`);
  for (const r of mult) {
    console.log(`  ${String(r.rows_per_cwid).padEnd(14)} ${r.n}`);
  }

  console.log("\n========== Per-row appointment density (PhD slots filled) ==========");
  const phdDensity = (
    await pool.request().query<{ slots: number; n: number }>(
      `SELECT slots, COUNT_BIG(slots) AS n FROM (
         SELECT JID,
           (CASE WHEN [PRIMARY PHD AFFILIATION] IS NOT NULL AND [PRIMARY PHD AFFILIATION] <> '' THEN 1 ELSE 0 END
          + CASE WHEN [SECONDARY PHD AFFILIATION] IS NOT NULL AND [SECONDARY PHD AFFILIATION] <> '' THEN 1 ELSE 0 END
          + CASE WHEN [TERTIARY PHD AFFILIATION] IS NOT NULL AND [TERTIARY PHD AFFILIATION] <> '' THEN 1 ELSE 0 END) AS slots
         FROM ${fq}
       ) t GROUP BY slots ORDER BY slots`,
    )
  ).recordset;
  console.log(`  phd-slots-filled  count`);
  for (const r of phdDensity) {
    console.log(`  ${String(r.slots).padEnd(17)} ${r.n}`);
  }

  console.log("\n========== Per-row appointment density (MS slots filled) ==========");
  const msDensity = (
    await pool.request().query<{ slots: number; n: number }>(
      `SELECT slots, COUNT_BIG(slots) AS n FROM (
         SELECT JID,
           (CASE WHEN [MS AFFILIATION 1] IS NOT NULL AND [MS AFFILIATION 1] <> '' THEN 1 ELSE 0 END
          + CASE WHEN [MS AFFILIATION 2] IS NOT NULL AND [MS AFFILIATION 2] <> '' THEN 1 ELSE 0 END) AS slots
         FROM ${fq}
       ) t GROUP BY slots ORDER BY slots`,
    )
  ).recordset;
  console.log(`  ms-slots-filled  count`);
  for (const r of msDensity) {
    console.log(`  ${String(r.slots).padEnd(16)} ${r.n}`);
  }

  console.log("\n========== TERMINATION_DATE shape ==========");
  const term = (
    await pool.request().query<{ total: number; with_term: number; sample: string | null }>(
      `SELECT
         COUNT_BIG(JID) AS total,
         SUM(CASE WHEN TERMINATION_DATE IS NOT NULL AND TERMINATION_DATE <> '' THEN 1 ELSE 0 END) AS with_term,
         MAX(TERMINATION_DATE) AS sample
       FROM ${fq}`,
    )
  ).recordset[0];
  console.log(`  total rows:           ${term.total}`);
  console.log(`  with termination dt:  ${term.with_term}`);
  console.log(`  max value (sample):   ${term.sample ?? "(null)"}`);

  console.log("\n========== Sample rows (first 5, active master) ==========");
  const sample = (
    await pool.request().query<Record<string, unknown>>(
      `SELECT TOP 5 ${allowedSelect} FROM ${fq} WHERE [FACULTY MASTER ACTIVE] = 'Y'`,
    )
  ).recordset;
  for (const r of sample) {
    console.log("  ---");
    for (const [k, v] of Object.entries(r)) {
      console.log(`    ${k.padEnd(34)} ${v === null ? "(null)" : String(v).slice(0, 120)}`);
    }
  }

  console.log("\n========== Sample rows (first 5, INACTIVE master) ==========");
  const sampleInactive = (
    await pool.request().query<Record<string, unknown>>(
      `SELECT TOP 5 ${allowedSelect} FROM ${fq} WHERE [FACULTY MASTER ACTIVE] <> 'Y'`,
    )
  ).recordset;
  for (const r of sampleInactive) {
    console.log("  ---");
    for (const [k, v] of Object.entries(r)) {
      console.log(`    ${k.padEnd(34)} ${v === null ? "(null)" : String(v).slice(0, 120)}`);
    }
  }

  await closeJenzabarPool();
}

main().catch(async (e) => {
  console.error(e);
  await closeJenzabarPool();
  process.exit(1);
});
