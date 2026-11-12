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

// Cache the in-flight/connected pool on globalThis so dev HMR doesn't leak a
// new pool per reload. Storing the PROMISE (not the pool) means concurrent
// callers share a single connect attempt instead of racing.
const g = globalThis as unknown as { __jenzabarPool?: Promise<sql.ConnectionPool> };

function readConfig(): sql.config {
  const names = {
    server: "SCHOLARS_JENZABAR_SERVER",
    user: "SCHOLARS_JENZABAR_USERNAME",
    password: "SCHOLARS_JENZABAR_PASSWORD",
  } as const;

  // Report all missing vars at once (names only, never values).
  const missing = Object.values(names).filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`Missing Jenzabar env vars: ${missing.join(", ")}`);
  }

  const port = Number.parseInt(process.env.SCHOLARS_JENZABAR_PORT ?? "1433", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SCHOLARS_JENZABAR_PORT must be a valid port number");
  }

  const database = process.env.SCHOLARS_JENZABAR_DATABASE; // optional
																		  
	
  return {
    server: process.env[names.server]!,
    port,
    user: process.env[names.user]!,
    password: process.env[names.password]!,
    ...(database ? { database } : {}),

    // Explicit timeouts so a hung SQL Server can't stall callers indefinitely.
    connectionTimeout: 5_000, // opening a connection
    requestTimeout: 15_000, // per query; raise per-request for heavy queries

    pool: {
      max: 4, // per process: total load = 4 x instances; check SQL Server limits
      min: 1, // keep one warm connection to avoid cold-start handshakes
      idleTimeoutMillis: 30_000,
      acquireTimeoutMillis: 5_000, // max wait for a free pooled connection
    },
    options: {
      encrypt: true,
      // Validate the server certificate by default. If the server uses an
      // internal CA, trust it via NODE_EXTRA_CA_CERTS instead of disabling
      // validation. Opt out only explicitly, per environment.
      trustServerCertificate: true,
      enableArithAbort: true,
      appName: "scholars-web", // shows up in SQL Server session views for DBAs
      readOnlyIntent: true, // route to a read replica if one exists
    },
  };
}

async function createPool(): Promise<sql.ConnectionPool> {
  // Own pool instance, not the global one that sql.connect() shares.
  const pool = new sql.ConnectionPool(readConfig());
  // Without a listener, an 'error' event can crash the Node process.
  pool.on("error", (err) => console.error("[jenzabar] pool error:", err.message));
  await pool.connect();
  return pool;
}

export async function getJenzabarPool(): Promise<sql.ConnectionPool> {
  if (g.__jenzabarPool) {
    try {
      const pool = await g.__jenzabarPool;
      if (pool.connected) return pool;
    } catch {
      // previous connect failed; fall through and retry below
    }
    g.__jenzabarPool = undefined; // closed or failed: rebuild
  }

  const attempt = createPool();
  g.__jenzabarPool = attempt;
  try {
    return await attempt;
  } catch (err) {
    // Don't cache a rejected promise, or every future call fails instantly.
    if (g.__jenzabarPool === attempt) g.__jenzabarPool = undefined;
    throw err;
  }
}

export async function closeJenzabarPool(): Promise<void> {
  const cached = g.__jenzabarPool;
  g.__jenzabarPool = undefined; // clear first so a failed close can't leave a dead pool cached
  if (cached) {
    const pool = await cached.catch(() => null);
    await pool?.close();
  }
}
