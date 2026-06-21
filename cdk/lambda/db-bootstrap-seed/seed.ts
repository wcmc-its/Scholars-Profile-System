/**
 * Orchestration for the sps_bootstrap seeder, with every I/O dependency injected
 * so it is unit-testable without AWS or a live DB (mirrors the PR-1 runner's
 * `bootstrap(conn, …)` shape). `index.ts` wires the real Secrets Manager client
 * and mariadb connection; this decides what runs.
 */
import {
  APP_RO_USER,
  APP_RW_USER,
  BOOTSTRAP_USER,
  MIGRATE_USER,
  appRoAuditGrantStatements,
  appRoHostsQuery,
  appRwTightenStatements,
  buildDsn,
  buildMigrateDsn,
  decidePassword,
  dropStatements,
  migrateDropStatements,
  migrateSeedStatements,
  seedStatements,
} from "./statements.js";

export type RequestType = "Create" | "Update" | "Delete";

export interface SeedDeps {
  requestType: RequestType;
  /** Run one SQL statement as the master user. */
  query(sql: string): Promise<void>;
  /** Current bootstrap-secret value, or undefined if absent/empty. */
  getBootstrapSecret(): Promise<string | undefined>;
  /** Persist the bootstrap DSN (only called when a fresh password is generated). */
  putBootstrapSecret(dsn: string): Promise<void>;
  /** Aurora writer host + port for the DSN written to the secret. */
  dbHost: string;
  dbPort: number;
  /** Structured logger — MUST NOT be passed the password or DSN. */
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

export interface SeedResult {
  physicalResourceId: string;
  /** True when an existing password was reused (no secret write). */
  reused: boolean;
}

const PHYSICAL_ID = `db-bootstrap-seed-${BOOTSTRAP_USER}`;

/**
 * Seed (Create/Update) or drop (Delete) the bootstrap role. On Create/Update:
 * reuse the secret's existing password if present (so the DB user and the DSN
 * the bootstrap task reads never drift), else generate one and write the DSN;
 * always (re-)assert the user + grants idempotently. On Delete: drop the user.
 * Throws on any failure so the custom resource reports failure to CloudFormation
 * (the deploy fails — fails-closed).
 */
export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const log = deps.log ?? (() => {});

  if (deps.requestType === "Delete") {
    for (const sql of dropStatements()) await deps.query(sql);
    log("db_bootstrap_seed_dropped", { user: BOOTSTRAP_USER });
    return { physicalResourceId: PHYSICAL_ID, reused: false };
  }

  const existing = await deps.getBootstrapSecret();
  const { password, reused } = decidePassword(existing);

  for (const sql of seedStatements(password)) await deps.query(sql);

  if (!reused) {
    await deps.putBootstrapSecret(buildDsn(deps.dbHost, deps.dbPort, password));
  }

  // Never logs the password or DSN — only the outcome class.
  log("db_bootstrap_seed_ok", { user: BOOTSTRAP_USER, reused });
  return { physicalResourceId: PHYSICAL_ID, reused };
}

export interface MigrateSeedDeps {
  requestType: RequestType;
  /** Run one SQL statement as the master user. */
  query(sql: string): Promise<void>;
  /** Current migrate-secret value, or undefined if absent/empty. */
  getMigrateSecret(): Promise<string | undefined>;
  /** Persist the migrate DSN (only called when a fresh password is generated). */
  putMigrateSecret(dsn: string): Promise<void>;
  /** Aurora writer host + port for the DSN written to the secret. */
  dbHost: string;
  dbPort: number;
  /** Structured logger — MUST NOT be passed the password or DSN. */
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

/**
 * Seed (Create/Update) or drop (Delete) the deploy-time migration role
 * `sps_migrate` (ADR-009 Phase 1). Same reuse-or-generate password discipline as
 * the bootstrap role so the DB user and the DSN the migrate task reads never
 * drift; idempotent (re-)assert of the user + grant every run. Throws on any
 * failure so the custom resource reports failure to CloudFormation (fails-closed).
 *
 * **Additive — Phase 1 only.** This creates the role and populates its secret;
 * it does NOT touch `app_rw` and the migrate task still runs under `app_rw`
 * until Phase 2 cuts it over. So minting this role has no effect on the running
 * system.
 */
export async function runMigrateSeed(deps: MigrateSeedDeps): Promise<{ reused: boolean }> {
  const log = deps.log ?? (() => {});

  if (deps.requestType === "Delete") {
    for (const sql of migrateDropStatements()) await deps.query(sql);
    log("db_migrate_seed_dropped", { user: MIGRATE_USER });
    return { reused: false };
  }

  const existing = await deps.getMigrateSecret();
  const { password, reused } = decidePassword(existing, "migrate");

  for (const sql of migrateSeedStatements(password)) await deps.query(sql);

  if (!reused) {
    await deps.putMigrateSecret(buildMigrateDsn(deps.dbHost, deps.dbPort, password));
  }

  // Never logs the password or DSN — only the outcome class.
  log("db_migrate_seed_ok", { user: MIGRATE_USER, reused });
  return { reused };
}

export interface AppRwTightenDeps {
  requestType: RequestType;
  /** Run one SQL statement as the master user. */
  query(sql: string): Promise<void>;
  /** Per-env host scope of the `app_rw` grant (`%` prod / `10.20.%` staging). */
  appRwGranteeHost: string;
  /** Structured logger. */
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

/**
 * Tighten `app_rw` to DML-only on `scholars`.* (ADR-009 Phase 3): revoke the DDL
 * privileges, leaving `SELECT,INSERT,UPDATE,DELETE` (+ the audit `INSERT`, which
 * is on `scholars_audit` and not named here). Idempotent (`REVOKE IF EXISTS`) so
 * the custom-resource re-run every deploy is a no-op once the DDL is gone, and
 * zero-gap (only DDL is named, so the running app's DML is never interrupted).
 *
 * **Sequencing (ADR-009):** safe ONLY because Phase 2 is deploy-confirmed — the
 * migrate task now runs under `sps_migrate`, which owns the DDL `app_rw` is
 * losing. Running this before that cutover would leave `prisma migrate deploy`
 * (still on `app_rw`) without DDL.
 *
 * **Delete is a NO-OP:** a stack teardown must not re-widen `app_rw` back to DDL.
 * `app_rw` is provisioned out-of-band, not owned by this seeder; the tightening
 * is intended to be permanent. Throws on a real SQL error (fails-closed).
 */
export async function runAppRwTighten(deps: AppRwTightenDeps): Promise<void> {
  const log = deps.log ?? (() => {});

  if (deps.requestType === "Delete") {
    log("db_app_rw_tighten_skipped_on_delete", { user: APP_RW_USER });
    return;
  }

  for (const sql of appRwTightenStatements(deps.appRwGranteeHost)) await deps.query(sql);

  log("db_app_rw_tighten_ok", { user: APP_RW_USER, granteeHost: deps.appRwGranteeHost });
}

export interface AppRoAuditGrantDeps {
  requestType: RequestType;
  /** Run one SQL statement as the master user. */
  query(sql: string): Promise<void>;
  /** Run a SELECT as the master user and return its rows (for `app_ro` host discovery). */
  queryRows(sql: string): Promise<Array<{ host?: unknown }>>;
  /** Structured logger. */
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

/**
 * Grant the read-only role `app_ro` SELECT on `scholars_audit.manual_edit_audit` (#917). The
 * `/edit/.../history` pages read the audit log through `app_ro`, which otherwise has NO privilege
 * on the audit schema (least-privilege: the writer `app_rw` holds only INSERT there, the reader
 * none). No managed role can issue this — `sps_bootstrap` holds only `INSERT … WITH GRANT OPTION`
 * on the audit DB, not SELECT — so it runs here, on the master connection.
 *
 * **Targets the REAL user.** `app_ro` is provisioned out-of-band and may be `@'%'` (prod) or
 * host-scoped `@'10.20.%'` (staging); this discovers its actual host(s) from `mysql.user` and grants
 * to each, so it never auto-creates a phantom `app_ro@<wrong-host>` that would leave history broken.
 *
 * **Idempotent** (re-GRANT is a no-op). **SELECT-only** on the append-only log. **Additive:** if
 * `app_ro` does not exist yet it logs a warning and skips (a missing reader is not worth failing a
 * deploy — unlike the security-tightening `runAppRwTighten`, this only ADDS a read privilege).
 *
 * **Table-not-yet-created tolerance.** Unlike the seeder's other grants (all database-level, which
 * MySQL/Aurora legally grant on a not-yet-existing schema), this is the seeder's only TABLE-level
 * grant — and MySQL returns ER_NO_SUCH_TABLE (1146) for a table-level GRANT lacking CREATE when the
 * table is absent. The `manual_edit_audit` table is created by the SEPARATE `sps-db-bootstrap` ECS
 * task (a different deploy stage), so on a brand-new env / DR rebuild the DataStack seeder can fire
 * before the table exists. We swallow 1146 and warn-skip (the grant self-heals on the next deploy,
 * after the table is created) rather than wedge `cdk deploy`; every OTHER SQL error still propagates
 * (fails-closed). On existing staging/prod the table has long existed, so this never triggers there.
 *
 * **Delete is a NO-OP** (the grant is meant to persist; `app_ro` is not owned by this seeder).
 */
export async function runAppRoAuditGrant(deps: AppRoAuditGrantDeps): Promise<void> {
  const log = deps.log ?? (() => {});

  if (deps.requestType === "Delete") {
    log("db_app_ro_audit_grant_skipped_on_delete", { user: APP_RO_USER });
    return;
  }

  const rows = await deps.queryRows(appRoHostsQuery());
  const hosts = rows
    .map((r) => (typeof r.host === "string" ? r.host : undefined))
    .filter((h): h is string => h !== undefined && h.length > 0);

  if (hosts.length === 0) {
    log("db_app_ro_audit_grant_skipped_no_user", { user: APP_RO_USER });
    return;
  }

  for (const host of hosts) {
    try {
      for (const sql of appRoAuditGrantStatements(host)) await deps.query(sql);
    } catch (err) {
      // The table is env-wide absent (not host-specific) — skip the whole grant; it self-heals on
      // the next deploy once `sps-db-bootstrap` has created `manual_edit_audit`.
      if (isMissingTableError(err)) {
        log("db_app_ro_audit_grant_skipped_no_table", { user: APP_RO_USER });
        return;
      }
      throw err; // a real failure (Access denied, etc.) stays fails-closed.
    }
  }
  log("db_app_ro_audit_grant_ok", { user: APP_RO_USER, hosts });
}

/** Whether a thrown DB error is "table doesn't exist" (MySQL/MariaDB errno 1146 / ER_NO_SUCH_TABLE). */
function isMissingTableError(err: unknown): boolean {
  const e = err as { errno?: unknown; code?: unknown } | null;
  return e != null && (e.errno === 1146 || e.code === "ER_NO_SUCH_TABLE");
}
