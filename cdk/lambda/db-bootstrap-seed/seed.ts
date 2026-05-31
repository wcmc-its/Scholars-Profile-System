/**
 * Orchestration for the sps_bootstrap seeder, with every I/O dependency injected
 * so it is unit-testable without AWS or a live DB (mirrors the PR-1 runner's
 * `bootstrap(conn, …)` shape). `index.ts` wires the real Secrets Manager client
 * and mariadb connection; this decides what runs.
 */
import {
  APP_RW_USER,
  BOOTSTRAP_USER,
  MIGRATE_USER,
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
