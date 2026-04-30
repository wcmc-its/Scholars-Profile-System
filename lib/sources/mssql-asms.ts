/**
 * MS SQL Server connection helper for ASMS.
 *
 * Env vars (SCHOLARS_ASMS_* namespace):
 *   SCHOLARS_ASMS_HOST       (required)
 *   SCHOLARS_ASMS_PORT       (optional, default 1433)
 *   SCHOLARS_ASMS_USERNAME   (required)
 *   SCHOLARS_ASMS_PASSWORD   (required)
 *   SCHOLARS_ASMS_DATABASE   (optional, default "asms")
 *
 * The institutional client uses `asms.dbo.<table>` three-part naming, so the
 * default database can stay `asms`. Override via SCHOLARS_ASMS_DATABASE if
 * needed.
 */
import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

export async function getAsmsPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  const host = process.env.SCHOLARS_ASMS_HOST;
  const user = process.env.SCHOLARS_ASMS_USERNAME;
  const password = process.env.SCHOLARS_ASMS_PASSWORD;
  const database = process.env.SCHOLARS_ASMS_DATABASE ?? "asms";
  const port = parseInt(process.env.SCHOLARS_ASMS_PORT ?? "1433", 10);
  if (!host) throw new Error("SCHOLARS_ASMS_HOST is not set");
  if (!user) throw new Error("SCHOLARS_ASMS_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_ASMS_PASSWORD is not set");

  pool = await sql.connect({
    server: host,
    port,
    user,
    password,
    database,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: true,
      trustServerCertificate: true, // institutional CA, not in macOS default trust
      enableArithAbort: true,
    },
  });
  return pool;
}

export async function closeAsmsPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
