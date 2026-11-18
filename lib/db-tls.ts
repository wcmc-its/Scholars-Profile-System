/**
 * Verified TLS to Aurora MySQL, behind the `DB_TLS` flag.
 *
 * The ONE place every SPS Aurora client gets its TLS settings from: the app and
 * ETL Prisma pools (via `lib/db-url.ts`), the migrate task's Prisma schema
 * engine (via `prisma.config.ts`), the deploy-time db-bootstrap / verify-grants
 * runners, and the one-off scripts that open their own mariadb connection.
 *
 * - `DB_TLS` unset or anything but "on": no TLS settings are added, so every
 *   client behaves exactly as before (plaintext inside the VPC).
 * - `DB_TLS=on`: TLS is required and the server certificate is verified against
 *   the Amazon RDS CA bundle shipped in the repo (`certs/rds-global-bundle.pem`,
 *   from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
 *   Node does not trust the RDS CA by default, so `ssl: true` alone would fail
 *   verification. Hostname verification runs against the host in the DSN.
 *
 * The flag is per env in the task definitions (cdk/lib/app-stack.ts,
 * cdk/lib/etl-stack.ts), not in the Secrets Manager DSNs, so a deploy turns TLS
 * on and a revert turns it off.
 *
 * Keep this module dependency-free (node builtins only): `prisma.config.ts`
 * imports it, and the runtime image runs the Prisma CLI without the app's
 * dependency tree.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Repo-relative path of the RDS CA bundle. Images copy it to `/app/certs/`. */
export const RDS_CA_BUNDLE_RELATIVE_PATH = "certs/rds-global-bundle.pem";

type Env = Record<string, string | undefined>;

/** True only when `DB_TLS` is exactly "on". */
export function dbTlsEnabled(env: Env = process.env): boolean {
  return env.DB_TLS === "on";
}

/** Absolute path of the CA bundle, resolved from the working directory (the
 *  repo root locally, `/app` in the app and ETL images). */
export function rdsCaBundlePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, RDS_CA_BUNDLE_RELATIVE_PATH);
}

const caCache = new Map<string, string>();

/** Read the CA bundle once per process. Throws if it is missing or not PEM, so
 *  a flag-on client fails loudly instead of falling back to plaintext. */
export function loadRdsCa(file: string = rdsCaBundlePath()): string {
  const cached = caCache.get(file);
  if (cached !== undefined) return cached;
  if (!existsSync(/*turbopackIgnore: true*/ file)) {
    throw new Error(`DB_TLS=on but the RDS CA bundle is missing at ${file}`);
  }
  const pem = readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`DB_TLS=on but ${file} is not a PEM certificate bundle`);
  }
  caCache.set(file, pem);
  return pem;
}

/** The mariadb `ssl` option for a verified connection. */
export interface DbSslOptions {
  ca: string;
  rejectUnauthorized: true;
}

/** `ssl` options for a mariadb connection or pool: undefined when the flag is
 *  off (no TLS, the pre-flag behaviour), verified-TLS settings when it is on. */
export function dbSslOptions(env: Env = process.env, caFile?: string): DbSslOptions | undefined {
  if (!dbTlsEnabled(env)) return undefined;
  return { ca: loadRdsCa(caFile), rejectUnauthorized: true };
}

/** Plain connection options parsed from a `mysql://` / `mariadb://` DSN. */
export interface DsnConnectionOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  /** Omitted when the DSN has no database segment (server-level connection). */
  database?: string;
  ssl?: DbSslOptions;
}

/**
 * Parse a DSN into mariadb `createConnection` options, adding the `DB_TLS` ssl
 * settings. For the scripts that open their own connection instead of using
 * `lib/db.ts`; spread extra driver options (bigIntAsNumber etc.) on top.
 */
export function connectionOptionsFromDsn(
  dsn: string,
  env: Env = process.env,
  caFile?: string,
): DsnConnectionOptions {
  const u = new URL(dsn);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const ssl = dbSslOptions(env, caFile);
  return {
    host: u.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: u.port ? parseInt(u.port, 10) : 3306,
    user: decodeURIComponent(u.username),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(database ? { database } : {}),
    ...(ssl ? { ssl } : {}),
  };
}

/**
 * The migrate task's DSN for the Prisma schema engine (`prisma migrate deploy`),
 * which is a native binary, not Node TLS. With the flag on, add the Prisma
 * MySQL TLS params: `sslcert` (the CA bundle, absolute so it does not depend on
 * Prisma's relative-path rules) and `sslaccept=strict` (verify the chain and
 * the hostname). Flag off, or no URL, returns the input unchanged.
 */
export function withSchemaEngineTls(
  rawUrl: string | undefined,
  env: Env = process.env,
  caFile: string = rdsCaBundlePath(),
): string | undefined {
  if (rawUrl === undefined || !dbTlsEnabled(env)) return rawUrl;
  loadRdsCa(caFile); // fail loudly here, not inside the schema engine
  const url = new URL(rawUrl);
  url.searchParams.set("sslcert", caFile);
  url.searchParams.set("sslaccept", "strict");
  return url.toString();
}
