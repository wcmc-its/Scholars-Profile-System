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
import { readFileSync } from "node:fs";
import { createPool, type Pool, type PoolConnection } from "mariadb";

// Cached on globalThis so dev hot reload (HMR) doesn't create a new pool on
// every module re-evaluation and orphan the old one's connections. In
// production there is no HMR, so this behaves like a plain module variable.
const globalForReciter = globalThis as unknown as {
  __reciterPool?: Pool;
};


function readConfig() {
  const names = {
    host: "SCHOLARS_RECITERDB_HOST",
    user: "SCHOLARS_RECITERDB_USERNAME",
    password: "SCHOLARS_RECITERDB_PASSWORD",
    database: "SCHOLARS_RECITERDB_DATABASE",
  } as const;

  // Report all missing vars at once. Only names are listed, never values.
  const missing = Object.values(names).filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`Missing ReciterDB env vars: ${missing.join(", ")}`);
  }

  // parseInt returns NaN on garbage input, so validate instead of passing it
  // to the driver and getting a confusing connection error later.
  const port = Number.parseInt(process.env.SCHOLARS_RECITERDB_PORT ?? "3306", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SCHOLARS_RECITERDB_PORT must be a valid port number");
  }

  return {
    // Non-null assertions are safe: the missing check above guarantees these.
    host: process.env[names.host]!,
    user: process.env[names.user]!,
    password: process.env[names.password]!,
    database: process.env[names.database]!,
    port
  };
}

export function getReciterPool(): Pool {
  // Lazy: config is read on first use, not at import time, so `next build`
  // doesn't fail when DB env vars are absent during the build.
  return (globalForReciter.__reciterPool ??= createPool({
    ...readConfig(),
    // Per Node process. Total DB load is 4 x (Next.js instances + ETL), so
    // check that against the DB's max_connections / per-user limit.
    connectionLimit: 4,

    // BIGINT columns come back as numbers. Fine for PMIDs and counts, but
    // precision is lost above 2^53, so don't read 64-bit IDs through this pool.
    bigIntAsNumber: true,

    // Fail fast when ReciterDB is unreachable (WCM-side; the SPS VPC->WCM
    // path can be down) instead of stalling callers ~10s on driver defaults.
    connectTimeout: 2000,
    acquireTimeout: 3000,
   
  }));
}

export async function withReciterConnection<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getReciterPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    // release() returns a Promise; awaiting it avoids an unhandled rejection.
    await conn.release();
  }
}

export async function closeReciterPool(): Promise<void> {
  const pool = globalForReciter.__reciterPool;

  // Clear the reference before closing. If end() throws, we don't keep
  // handing out a half-closed pool; the next call builds a fresh one, and
  // the error still propagates to the caller.
  globalForReciter.__reciterPool = undefined;
  await pool?.end();
}

/**
 * Boot-time hint for the silent-degrade case: ReciterDB unset while a feature
 * still routes to its live path (bridge flag off). Those features then show
 * "temporarily unavailable" on every request; say so once instead. Staging and
 * prod run both bridges on, so this is null there.
 */
export function reciterDbConfigWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (env.SCHOLARS_RECITERDB_HOST) return null;
  const live = ["MENTORING_COPUB_BRIDGE", "PUBLICATION_CITING_BRIDGE"].filter((f) => env[f] !== "on");
  if (live.length === 0) return null;
  return (
    `[reciterdb] SCHOLARS_RECITERDB_HOST is unset and ${live.join(", ")} not "on": ` +
    "mentoring and cited-by data will show as unavailable. Set the flag(s) to \"on\" " +
    "to read the local bridge tables (see .env.example)."
  )
}