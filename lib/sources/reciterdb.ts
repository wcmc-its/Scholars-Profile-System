/**
 * ReciterDB connection helper. MySQL/MariaDB-compatible.
 *
 * Env (SCHOLARS_RECITERDB_* namespace to avoid colliding with generic DB_*):
 *   SCHOLARS_RECITERDB_HOST       (required)
 *   SCHOLARS_RECITERDB_PORT       (optional, default 3306)
 *   SCHOLARS_RECITERDB_USERNAME   (required)
 *   SCHOLARS_RECITERDB_PASSWORD   (required)
 *   SCHOLARS_RECITERDB_DATABASE   (required)
 */
import { createPool, type Pool, type PoolConnection } from "mariadb";

let pool: Pool | null = null;

export function getReciterPool(): Pool {
  if (pool !== null) return pool;
  const host = process.env.SCHOLARS_RECITERDB_HOST;
  const user = process.env.SCHOLARS_RECITERDB_USERNAME;
  const password = process.env.SCHOLARS_RECITERDB_PASSWORD;
  const database = process.env.SCHOLARS_RECITERDB_DATABASE;
  const port = parseInt(process.env.SCHOLARS_RECITERDB_PORT ?? "3306", 10);
  if (!host) throw new Error("SCHOLARS_RECITERDB_HOST is not set");
  if (!user) throw new Error("SCHOLARS_RECITERDB_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_RECITERDB_PASSWORD is not set");
  if (!database) throw new Error("SCHOLARS_RECITERDB_DATABASE is not set");

  const created = createPool({
    host,
    user,
    password,
    database,
    port,
    connectionLimit: 4,
    bigIntAsNumber: true,
  });
  pool = created;
  return created;
}

export async function withReciterConnection<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getReciterPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function closeReciterPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
