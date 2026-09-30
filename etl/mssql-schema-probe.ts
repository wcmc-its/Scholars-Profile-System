/**
 * Schema probe for a new MS SQL Server source (FRT mentees, COI on SQL Server).
 *
 * Reads SCHOLARS_<PREFIX>_{SERVER,PORT,DATABASE,USERNAME,PASSWORD}, then lists
 * every table/view whose name matches a keyword, with columns and row counts.
 * Prints NO row values — schema only, safe to paste.
 *
 * Run: npx tsx etl/mssql-schema-probe.ts DATA_REPOSITORY frt coi
 *
 * Read-only.
 */
import "dotenv/config";
import sql from "mssql";

const [prefix, ...keywords] = process.argv.slice(2);
if (!prefix) {
  console.error("usage: mssql-schema-probe.ts <PREFIX> [keyword...]");
  process.exit(2);
}
const env = (k: string) => process.env[`SCHOLARS_${prefix}_${k}`];

async function main() {
  for (const k of ["SERVER", "USERNAME", "PASSWORD"]) {
    if (!env(k)) throw new Error(`SCHOLARS_${prefix}_${k} is not set`);
  }
  const pool = await sql.connect({
    server: env("SERVER")!,
    port: parseInt(env("PORT") ?? "1433", 10),
    user: env("USERNAME")!,
    password: env("PASSWORD")!,
    ...(env("DATABASE") ? { database: env("DATABASE") } : {}),
    options: { encrypt: true, trustServerCertificate: true },
  });
  try {
    const conn = (await pool.request().query(`SELECT DB_NAME() AS db, SUSER_SNAME() AS login`))
      .recordset[0];
    console.log(`connected: login=${conn.login} defaultDb=${conn.db}`);

    const dbs = env("DATABASE")
      ? [env("DATABASE")!]
      : (
          await pool.request().query<{ name: string }>(
            `SELECT name FROM sys.databases WHERE state_desc='ONLINE'
               AND name NOT IN ('master','tempdb','model','msdb') ORDER BY name`,
          )
        ).recordset.map((r) => r.name);

    const like = keywords.length ? keywords.map((k) => k.toLowerCase()) : [""];
    for (const db of dbs) {
      let objs: { s: string; t: string; kind: string }[];
      try {
        objs = (
          await pool.request().query(
            `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_TYPE AS kind
             FROM [${db}].INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`,
          )
        ).recordset;
      } catch (e) {
        console.log(`\n[${db}] skipped: ${(e as Error).message.slice(0, 80)}`);
        continue;
      }
      const hits = objs.filter((o) => like.some((k) => o.t.toLowerCase().includes(k)));
      console.log(`\n[${db}] ${objs.length} objects, ${hits.length} match`);
      for (const o of hits) {
        const fq = `[${db}].[${o.s}].[${o.t}]`;
        const n = await pool
          .request()
          .query(`SELECT COUNT(*) AS n FROM ${fq}`)
          .then((r) => r.recordset[0].n)
          .catch((e: Error) => `count failed: ${e.message.slice(0, 60)}`);
        console.log(`\n  ${fq} (${o.kind}) rows=${n}`);
        const cols = (
          await pool
            .request()
            .input("s", o.s)
            .input("t", o.t)
            .query(
              `SELECT COLUMN_NAME AS c, DATA_TYPE AS d, IS_NULLABLE AS nul
               FROM [${db}].INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA=@s AND TABLE_NAME=@t ORDER BY ORDINAL_POSITION`,
            )
        ).recordset;
        for (const c of cols) console.log(`    ${String(c.c).padEnd(36)} ${c.d} ${c.nul}`);
      }
    }
  } finally {
    await pool.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
