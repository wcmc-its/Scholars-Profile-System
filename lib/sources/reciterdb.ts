/**
 * ReciterDB connection helper. MySQL/MariaDB-compatible.
 *
 * Env (SCHOLARS_RECITERDB_* namespace to avoid colliding with generic DB_*):
 *   SCHOLARS_RECITERDB_HOST       (required)
 *   SCHOLARS_RECITERDB_PORT       (optional, default 3306)
 *   SCHOLARS_RECITERDB_USERNAME   (required)
 *   SCHOLARS_RECITERDB_PASSWORD   (required)
 *   SCHOLARS_RECITERDB_DATABASE   (required)
 *   SCHOLARS_RECITERDB_SSL_CA     (optional, CA bundle path; enables verified TLS)
 */
import { readFileSync } from "node:fs";
import { createPool, type Pool, type PoolConnection } from "mariadb";

// On globalThis so dev HMR reuses one pool instead of orphaning a new one per reload.
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

  const missing = Object.values(names).filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`Missing ReciterDB env vars: ${missing.join(", ")}`);
  }

  // Empty counts as unset (a bare `SCHOLARS_RECITERDB_PORT=` line in .env).
  // Digits only, so "3306abc" is rejected instead of parsed as 3306.
  const rawPort = process.env.SCHOLARS_RECITERDB_PORT || "3306";
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error("SCHOLARS_RECITERDB_PORT must be a valid port number");
  }

  // TLS is opt-in. Unset = plaintext, as before.
  const caPath = process.env.SCHOLARS_RECITERDB_SSL_CA;
  let ssl: { ca: string; rejectUnauthorized: true } | undefined;
  if (caPath) {
    try {
      ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
    } catch (err) {
      throw new Error(`SCHOLARS_RECITERDB_SSL_CA could not be read: ${(err as Error).message}`);
    }
  }

  return {
    host: process.env[names.host]!,
    user: process.env[names.user]!,
    password: process.env[names.password]!,
    database: process.env[names.database]!,
    port,
    ssl,
  };
}

export function getReciterPool(): Pool {
  // Lazy, so `next build` works without DB env vars.
  return (globalForReciter.__reciterPool ??= createPool({
    ...readConfig(),
    connectionLimit: 4, // per process
    // Precision is lost above 2^53; fine for PMIDs and counts, not 64-bit IDs.
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
    // Not awaited: a throw from finally would mask fn's result or error.
    conn.release().catch(() => {});
  }
}

export async function closeReciterPool(): Promise<void> {
  const pool = globalForReciter.__reciterPool;
  // Clear first so a failed end() never leaves a half-closed pool in use.
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
  );
}
