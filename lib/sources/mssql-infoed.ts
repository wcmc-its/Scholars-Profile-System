/**
 * MS SQL Server connection helper for InfoEd.
 *
 * Env vars (SCHOLARS_INFOED_* namespace):
 *   SCHOLARS_INFOED_DB_URL    (required) — JDBC URL like
 *      jdbc:sqlserver://host:port;DatabaseName=WC_InfoEdProd_Integration;...
 *   SCHOLARS_INFOED_USERNAME  (required)
 *   SCHOLARS_INFOED_PASSWORD  (required)
 *
 * Target view (per user 2026-04-30): WC_InfoEdProd_Integration.dbo.VIVO
 */
import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

function parseJdbcUrl(url: string): { host: string; port: number; database: string } {
  // jdbc:sqlserver://host:port;Property=value;...
  const m = url.match(/^jdbc:sqlserver:\/\/([^:;]+)(?::(\d+))?(.*)$/i);
  if (!m) throw new Error(`Invalid JDBC URL: expected jdbc:sqlserver://host[:port];... got ${url.slice(0, 30)}...`);
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : 1433;
  const props: Record<string, string> = {};
  for (const kv of (m[3] ?? "").split(";")) {
    if (!kv) continue;
    const [k, v] = kv.split("=");
    if (k && v !== undefined) props[k.toLowerCase()] = v;
  }
  const database = props.databasename ?? props.database ?? "";
  if (!database) throw new Error("JDBC URL missing DatabaseName property");
  return { host, port, database };
}

export async function getInfoedPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  const url = process.env.SCHOLARS_INFOED_DB_URL;
  const user = process.env.SCHOLARS_INFOED_USERNAME;
  const password = process.env.SCHOLARS_INFOED_PASSWORD;
  if (!url) throw new Error("SCHOLARS_INFOED_DB_URL is not set");
  if (!user) throw new Error("SCHOLARS_INFOED_USERNAME is not set");
  if (!password) throw new Error("SCHOLARS_INFOED_PASSWORD is not set");

  const { host, port, database } = parseJdbcUrl(url);

  pool = await sql.connect({
    server: host,
    port,
    user,
    password,
    database,
    requestTimeout: 2_400_000, // 40 min — the consolidated query joins 30+ tables across DBs and can run long when InfoEd is slow
    connectionTimeout: 30_000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  });
  return pool;
}

export async function closeInfoedPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
