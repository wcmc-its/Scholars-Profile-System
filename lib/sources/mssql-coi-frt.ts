/**
 * MS SQL Server connection helper for the WCM SQL Server database that
 * serves the COI disclosures view (v_coi_vivo_activity_group, replacing the
 * old MySQL COI host) and the Faculty Review Tool mentee tables.
 *
 * Env vars (SCHOLARS_COI_FRT_* namespace; ETL secret scholars/<env>/etl/coi):
 *   SCHOLARS_COI_FRT_SERVER     (required) — hostname
 *   SCHOLARS_COI_FRT_PORT       (optional, default 1433)
 *   SCHOLARS_COI_FRT_DATABASE   (optional) — omit to use the login's default DB
 *   SCHOLARS_COI_FRT_USERNAME   (required)
 *   SCHOLARS_COI_FRT_PASSWORD   (required)
 */
import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

export async function getCoiFrtPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  const server = process.env.SCHOLARS_COI_FRT_SERVER;
  const user = process.env.SCHOLARS_COI_FRT_USERNAME;
  const password = process.env.SCHOLARS_COI_FRT_PASSWORD;
  const database = process.env.SCHOLARS_COI_FRT_DATABASE; // optional
  const port = parseInt(process.env.SCHOLARS_COI_FRT_PORT || "1433", 10);
  if (!server) throw new Error("SCHOLARS_COI_FRT_SERVER is not set");
  if (!user) throw new Error("SCHOLARS_COI_FRT_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_COI_FRT_PASSWORD is not set");

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

export async function closeCoiFrtPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
