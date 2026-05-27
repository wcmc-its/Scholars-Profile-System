/**
 * db-bootstrap — provision the `scholars_audit` database + append-only INSERT
 * grant, as the one-shot `sps-db-bootstrap-${env}` Fargate task that runs in the
 * deploy pipeline BEFORE `sps-migrate` (#493).
 *
 * WHY THIS EXISTS
 *   The B03 audit log lives in a separate `scholars_audit` database so the app
 *   role can hold INSERT there and nothing else — the asymmetric grant that makes
 *   the log append-only and tamper-evident (docs/b03-audit-log.md, #102). That
 *   grant was a manual DBA step (`scripts/sql/audit-log.sql`), and a missing grant
 *   fails *silently and late*: Hide/Show 500s (its audit INSERT is in-transaction)
 *   and the request-change mailer degrades to a logged audit gap (#160 Phase 2).
 *   This task makes the provisioning a deploy step that **fails loud and early,
 *   fails-closed** — a non-zero exit halts the deploy before the service rolls.
 *
 * CREDENTIAL POSTURE (the whole point of the split)
 *   This task runs as the least-privilege `sps_bootstrap` user (BOOTSTRAP_DSN),
 *   NOT the Aurora master. `sps_bootstrap` holds only CREATE/ALTER on
 *   `scholars_audit.*` and INSERT there WITH GRANT OPTION — enough to create the
 *   audit objects and grant the app role INSERT, and nothing on `scholars`. The
 *   one-time master use that seeds `sps_bootstrap` is confined to a CDK custom
 *   resource inside DataStack (PR 2); master is never reachable from CI.
 *
 * WHAT IT DOES (idempotent — safe to run on every deploy)
 *   1. Apply the `scholars_audit` DDL sourced verbatim from
 *      `scripts/sql/audit-log.sql` (CREATE DATABASE / TABLE IF NOT EXISTS + the
 *      idempotent ENUM `MODIFY COLUMN`). Single source of truth — the runner
 *      strips comments (so the commented GRANT template never executes) and runs
 *      each remaining statement.
 *   2. Resolve the application grantee from APP_RW_DSN (the live app-rw username,
 *      so the grant can't drift from the actual app identity) and
 *      `GRANT INSERT ON scholars_audit.manual_edit_audit` to it.
 *   3. Verify with `SHOW GRANTS` that the app role's `scholars_audit` privileges
 *      are INSERT-only — the #102 acceptance criterion. Any UPDATE/DELETE/ALL is
 *      a hard failure.
 *
 * Usage (local parity): `npm run db:audit-setup`
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import { createConnection } from "mariadb";

/** The audit database + table the grant is scoped to. */
const AUDIT_DB = "scholars_audit";
const AUDIT_TABLE = "manual_edit_audit";

/** A minimal connection surface — lets the unit tests pass a fake. */
export interface SqlConn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/** Parse a `mysql://`/`mariadb://` DSN into connection parts. Mirrors
 *  `scripts/db-check.ts` so the bootstrap connects exactly as the app tooling
 *  does. */
export function parseDsn(dsn: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: boolean;
} {
  const u = new URL(dsn);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
    database: u.pathname.replace(/^\//, "") || undefined as unknown as string,
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    // Aurora does not require TLS by default and this runs inside the VPC on a
    // SG-restricted path; opt in with `?ssl=true` if the cluster enforces it.
    ssl: u.searchParams.get("ssl") === "true" || u.searchParams.has("sslmode"),
  };
}

/** The application grantee username, taken from the live app-rw DSN. Validated
 *  to a conservative identifier charset because a username cannot be a bound
 *  parameter in a `GRANT` (it is an identifier, not a value) — so it is the one
 *  interpolated token and must be injection-safe. A username outside this set is
 *  a hard failure rather than a risky interpolation. */
export function granteeFromAppRwDsn(appRwDsn: string): string {
  const user = decodeURIComponent(new URL(appRwDsn).username);
  if (!/^[A-Za-z0-9_]+$/.test(user)) {
    throw new Error(
      `app-rw username ${JSON.stringify(user)} is not a simple identifier; refusing to interpolate it into a GRANT`,
    );
  }
  return user;
}

/** Executable statements from `audit-log.sql`: strip block + line comments (so
 *  the commented GRANT template never runs), split on `;`, drop the empties.
 *  The file's only executable statements are the CREATE DATABASE / CREATE TABLE
 *  / ALTER TABLE DDL; this is asserted in the unit test against the real file. */
export function extractStatements(sqlText: string): string[] {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/--[^\n]*/g, "") // line comments (incl. the GRANT template)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Validate a grantee host pattern (the part after `@`). Aurora app users are
 *  `@'%'`; local dev is `@'localhost'`. Like the username it cannot be a bound
 *  parameter in a GRANT, so it is validated to a conservative charset
 *  (alphanumerics, `.`, `_`, `-`, `%`) before interpolation. */
export function validateHost(host: string): string {
  if (!/^[A-Za-z0-9_.%-]+$/.test(host)) {
    throw new Error(`grantee host ${JSON.stringify(host)} is not a valid host pattern`);
  }
  return host;
}

/** The append-only grant. INSERT only — never UPDATE/DELETE/ALL. `host` is the
 *  grantee host pattern (`%` on Aurora, `localhost` for local dev). */
export function buildGrantSql(grantee: string, host = "%"): string {
  return `GRANT INSERT ON \`${AUDIT_DB}\`.\`${AUDIT_TABLE}\` TO '${grantee}'@'${validateHost(host)}'`;
}

/** Assert the app role's privileges ON `scholars_audit` are INSERT-only (#102).
 *  Matches the backtick-quoted db name so `scholars` (a prefix) never matches
 *  `scholars_audit`. Returns nothing on success; throws on a forbidden grant or
 *  a missing INSERT. */
export function assertInsertOnlyAuditGrant(grantLines: string[]): void {
  const auditLines = grantLines.filter((l) => l.includes(`\`${AUDIT_DB}\``));
  const privsOf = (line: string): string =>
    (line.match(/GRANT\s+(.*?)\s+ON\s/i)?.[1] ?? "").toUpperCase();

  for (const line of auditLines) {
    const privs = privsOf(line);
    if (/\b(UPDATE|DELETE|ALL PRIVILEGES|DROP|ALTER)\b/.test(privs)) {
      throw new Error(
        `app role holds a forbidden privilege on ${AUDIT_DB} (audit log must be INSERT-only, #102): ${line}`,
      );
    }
  }
  const hasInsert = auditLines.some((l) => /\bINSERT\b/.test(privsOf(l)));
  if (!hasInsert) {
    throw new Error(
      `app role has no INSERT grant on ${AUDIT_DB}.${AUDIT_TABLE} after bootstrap — grant did not take`,
    );
  }
}

/** Run the full bootstrap against an open connection. Throws on any failure so
 *  the caller exits non-zero (fails-closed). `now`/logging are injected nowhere
 *  — this is deliberately side-effect-light for testing. */
export async function bootstrap(
  conn: SqlConn,
  opts: {
    sqlText: string;
    grantee: string;
    granteeHost?: string;
    log?: (msg: string) => void;
  },
): Promise<void> {
  const log = opts.log ?? (() => {});
  const host = validateHost(opts.granteeHost ?? "%");

  const statements = extractStatements(opts.sqlText);
  log(`Applying ${statements.length} audit-schema DDL statement(s)`);
  for (const stmt of statements) {
    await conn.query(stmt);
  }

  const grantSql = buildGrantSql(opts.grantee, host);
  log(`Granting INSERT on ${AUDIT_DB}.${AUDIT_TABLE} to '${opts.grantee}'@'${host}'`);
  await conn.query(grantSql);

  // Verify the #102 acceptance criterion: INSERT-only on the audit db.
  const rows = (await conn.query(
    `SHOW GRANTS FOR '${opts.grantee}'@'${host}'`,
  )) as Array<Record<string, string>>;
  const grantLines = rows.map((r) => Object.values(r)[0]);
  assertInsertOnlyAuditGrant(grantLines);
  log(`Verified ${AUDIT_DB} grant is INSERT-only for '${opts.grantee}'@'${host}'`);
}

/** Absolute path to the canonical audit DDL (resolved relative to this module,
 *  so it works regardless of the task's working directory). */
function auditSqlPath(): string {
  return fileURLToPath(new URL("./sql/audit-log.sql", import.meta.url));
}

async function main(): Promise<void> {
  const bootstrapDsn = process.env.BOOTSTRAP_DSN;
  const appRwDsn = process.env.APP_RW_DSN;
  if (!bootstrapDsn) throw new Error("BOOTSTRAP_DSN is not set");
  if (!appRwDsn) throw new Error("APP_RW_DSN is not set");

  const grantee = granteeFromAppRwDsn(appRwDsn);
  // Grantee host: `%` on Aurora (the app users are `@'%'`); set GRANTEE_HOST to
  // `localhost` for local dev, or to a tighter pattern if a deploy's app user
  // is host-scoped. Validated before interpolation.
  const granteeHost = process.env.GRANTEE_HOST ?? "%";
  const sqlText = readFileSync(auditSqlPath(), "utf8");

  const parts = parseDsn(bootstrapDsn);
  console.log(
    JSON.stringify({
      event: "db_bootstrap_start",
      host: parts.host,
      port: parts.port,
      bootstrap_user: parts.user,
      grantee,
      grantee_host: granteeHost,
    }),
  );

  const conn = (await createConnection({
    host: parts.host,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    ssl: parts.ssl || undefined,
    // No `database`: this connection creates databases and grants across them.
    bigIntAsNumber: true,
    multipleStatements: false,
  })) as unknown as SqlConn;

  try {
    await bootstrap(conn, { sqlText, grantee, granteeHost, log: (m) => console.log(m) });
    console.log(JSON.stringify({ event: "db_bootstrap_ok", grantee, grantee_host: granteeHost }));
  } finally {
    await conn.end();
  }
}

// Run only when invoked directly (not when imported by the unit test).
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        event: "db_bootstrap_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
}
