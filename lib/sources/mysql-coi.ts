/**
 * MySQL connection helper for COI (the COI_URL hostname is on a MySQL RDS
 * instance, not MS SQL — discovered when the mssql connector got connection
 * timeouts on port 1433).
 *
 * Env (SCHOLARS_COI_* namespace):
 *   SCHOLARS_COI_URL       (required) — hostname (or `host:port` format)
 *   SCHOLARS_COI_PORT      (optional, default 3306)
 *   SCHOLARS_COI_USERNAME  (required)
 *   SCHOLARS_COI_PASSWORD  (required)
 *   SCHOLARS_COI_DATABASE  (required)
 */
import { createPool, type Pool, type PoolConnection } from "mariadb";

let pool: Pool | null = null;

export function getCoiPool(): Pool {
  if (pool !== null) return pool;
  const raw = process.env.SCHOLARS_COI_URL;
  const user = process.env.SCHOLARS_COI_USERNAME;
  const password = process.env.SCHOLARS_COI_PASSWORD;
  const database = process.env.SCHOLARS_COI_DATABASE;
  if (!raw) throw new Error("SCHOLARS_COI_URL is not set");
  if (!user) throw new Error("SCHOLARS_COI_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_COI_PASSWORD is not set");
  if (!database) throw new Error("SCHOLARS_COI_DATABASE is not set");

  // Strip any leading scheme. If host:port format, split.
  const cleaned = raw.replace(/^[a-z]+:\/\//i, "");
  const [host, hostPort] = cleaned.split(":");
  const port = hostPort
    ? parseInt(hostPort, 10)
    : parseInt(process.env.SCHOLARS_COI_PORT ?? "3306", 10);

  const created = createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit: 4,
    bigIntAsNumber: true,
  });
  pool = created;
  return created;
}

export async function withCoiConnection<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getCoiPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function closeCoiPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
