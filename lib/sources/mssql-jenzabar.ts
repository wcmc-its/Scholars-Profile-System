/**
 * MS SQL Server connection helper for Jenzabar (student information system).
 *
 * Env vars (SCHOLARS_JENZABAR_* namespace):
 *   SCHOLARS_JENZABAR_SERVER     (required) — hostname
 *   SCHOLARS_JENZABAR_PORT       (optional, default 1433)
 *   SCHOLARS_JENZABAR_DATABASE   (optional) — omit to use the login's default DB
 *   SCHOLARS_JENZABAR_USERNAME   (required)
 *   SCHOLARS_JENZABAR_PASSWORD   (required)
 *
 * Target view (per user 2026-05-12): WCN_IDM_GS_ADVISOR_ADVISEE_View
 * filtered to ADVISOR_TYPE = 'MAJSP'.
 */
import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

export async function getJenzabarPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  const server = process.env.SCHOLARS_JENZABAR_SERVER;
  const user = process.env.SCHOLARS_JENZABAR_USERNAME;
  const password = process.env.SCHOLARS_JENZABAR_PASSWORD;
  const database = process.env.SCHOLARS_JENZABAR_DATABASE; // optional
  const port = parseInt(process.env.SCHOLARS_JENZABAR_PORT ?? "1433", 10);
  if (!server) throw new Error("SCHOLARS_JENZABAR_SERVER is not set");
  if (!user) throw new Error("SCHOLARS_JENZABAR_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_JENZABAR_PASSWORD is not set");

  const config: sql.config = {
    server,
    port,
    user,
    password,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  };
  if (database) config.database = database;

  pool = await sql.connect(config);
  return pool;
}

export async function closeJenzabarPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
