/**
 * Pure SQL + credential helpers for the sps_bootstrap seeder (#493 PR 2).
 *
 * Kept free of AWS / DB I/O so the security-relevant logic — the idempotent
 * least-privilege grant set, the reuse-don't-clobber password decision, and the
 * URL/SQL-safe password generation — is unit-tested in isolation.
 */
import { randomInt } from "node:crypto";

/** The least-privilege bootstrap role. Created `@'%'` to match Aurora app users. */
export const BOOTSTRAP_USER = "sps_bootstrap";
/** The deploy-time migration role (ADR-009). Like the bootstrap role it is a
 *  one-shot, task-only login created `@'%'`; unlike it, it holds the DDL set on
 *  the application `scholars` schema (the credential `prisma migrate deploy`
 *  runs under once Phase 2 cuts over) and NOTHING on `scholars_audit`. */
export const MIGRATE_USER = "sps_migrate";
/** The audit database the bootstrap role is scoped to — and nothing else. */
export const AUDIT_DB = "scholars_audit";

/** Alphanumeric only: safe inside both a single-quoted SQL string literal
 *  (no `'`/`\`) and a `mysql://user:PASSWORD@host` URL (no reserved chars), so
 *  the password needs neither SQL-escaping nor URL-encoding anywhere. */
const PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a random password from {@link PASSWORD_ALPHABET}. 32 chars over a
 *  62-symbol alphabet ≈ 190 bits — far past any brute-force concern. */
export function generatePassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** The idempotent statements that create/repair the bootstrap role. `CREATE
 *  USER IF NOT EXISTS` + `ALTER USER` makes the password authoritative whether
 *  or not the user already exists; the two grants are DB-level on the audit
 *  schema only (CREATE/ALTER to build the objects; INSERT WITH GRANT OPTION so
 *  the role can hand the app role INSERT). No privilege on `scholars`, no
 *  SELECT/UPDATE/DELETE anywhere. Granting on a not-yet-existing database is
 *  legal (DB-level grants don't require the schema to exist) — the bootstrap
 *  task creates `scholars_audit` later. */
export function seedStatements(password: string): string[] {
  const u = `'${BOOTSTRAP_USER}'@'%'`;
  return [
    `CREATE USER IF NOT EXISTS ${u} IDENTIFIED BY '${password}'`,
    `ALTER USER ${u} IDENTIFIED BY '${password}'`,
    `GRANT CREATE, ALTER ON \`${AUDIT_DB}\`.* TO ${u}`,
    `GRANT INSERT ON \`${AUDIT_DB}\`.* TO ${u} WITH GRANT OPTION`,
  ];
}

/** Drop the role (custom-resource Delete) so a rolled-back/destroyed stack
 *  leaves no orphan login. */
export function dropStatements(): string[] {
  return [`DROP USER IF EXISTS '${BOOTSTRAP_USER}'@'%'`];
}

/** The proven `app_rw` `scholars.*` DDL set, inherited verbatim (ADR-009
 *  Decision 1 — neither extended nor pruned). Exactly the set every migration to
 *  date has run under; the verify's `sps_migrate` golden list in
 *  `scripts/verify-db-grants.ts` must stay equal to it (a change to either is a
 *  conscious, paired edit — ADR-009 Downstream req 6). */
const MIGRATE_SCHOLARS_PRIVILEGES =
  "SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, EXECUTE, TRIGGER";

/** Idempotent statements that create/repair the migration role. `CREATE USER IF
 *  NOT EXISTS` + `ALTER USER` make the password authoritative whether or not the
 *  user already exists; the single GRANT is the DDL set on `scholars`.* only —
 *  no privilege on `scholars_audit` (migrations touch the application schema,
 *  never the append-only audit log). */
export function migrateSeedStatements(password: string): string[] {
  const u = `'${MIGRATE_USER}'@'%'`;
  return [
    `CREATE USER IF NOT EXISTS ${u} IDENTIFIED BY '${password}'`,
    `ALTER USER ${u} IDENTIFIED BY '${password}'`,
    `GRANT ${MIGRATE_SCHOLARS_PRIVILEGES} ON \`scholars\`.* TO ${u}`,
  ];
}

/** Drop the migration role (custom-resource Delete). */
export function migrateDropStatements(): string[] {
  return [`DROP USER IF EXISTS '${MIGRATE_USER}'@'%'`];
}

/** The 24/7 runtime writer. Unlike the seeder's own `@'%'` roles, `app_rw` is
 *  host-scoped per env (`%` prod / `10.20.%` staging = `envConfig.appRwGranteeHost`)
 *  and is provisioned OUT-OF-BAND (manual DBA step) — this seeder never CREATEs it. */
export const APP_RW_USER = "app_rw";

/** The `scholars`.* DDL privileges ADR-009 Phase 3 strips from `app_rw`: the
 *  complement of the DML it keeps (`SELECT,INSERT,UPDATE,DELETE`). DDL authority
 *  now lives only in the deploy-time `sps_migrate` role. This list and the
 *  `app-rw` golden in `scripts/verify-db-grants.ts` are a conscious paired edit
 *  (ADR-009 req 6): what is revoked here must be exactly what the golden drops. */
const APP_RW_REVOKED_SCHOLARS_DDL =
  "CREATE, DROP, ALTER, INDEX, REFERENCES, EXECUTE, TRIGGER";

/** Idempotent statement that tightens `app_rw` to DML-only on `scholars`.*
 *  (ADR-009 Phase 3). `REVOKE IF EXISTS` (MySQL 8.0.16+ / Aurora MySQL 3) turns
 *  a re-run into a warning rather than an error once the DDL is already gone, so
 *  the custom-resource re-assert every deploy is a safe no-op. **Zero-gap:** only
 *  the DDL privileges are named, so the DML the running app depends on is never
 *  dropped — there is no window where `app_rw` cannot write. The audit `INSERT`
 *  on `scholars_audit.manual_edit_audit` is a different object and untouched.
 *  `app_rw` must already exist (provisioned out-of-band); if absent the REVOKE
 *  fails loud (fail-closed) rather than silently auto-creating it. */
export function appRwTightenStatements(granteeHost: string): string[] {
  return [
    `REVOKE IF EXISTS ${APP_RW_REVOKED_SCHOLARS_DDL} ON \`scholars\`.* FROM '${APP_RW_USER}'@'${granteeHost}'`,
  ];
}

/** The DSN the bootstrap ECS task consumes as BOOTSTRAP_DSN. Alphanumeric
 *  password ⇒ no URL-encoding needed. No database segment: the task connects at
 *  server level to CREATE the audit database. */
export function buildDsn(host: string, port: number, password: string): string {
  return `mysql://${BOOTSTRAP_USER}:${password}@${host}:${port}/`;
}

/** The application schema the migration role connects to (`prisma migrate
 *  deploy` reads DATABASE_URL, which must name the database). */
export const MIGRATE_DB = "scholars";

/** The DSN the migrate task will consume as MIGRATE_DSN once Phase 2 points it
 *  here. Unlike the bootstrap DSN this DOES carry the `${MIGRATE_DB}` segment,
 *  because Prisma's DATABASE_URL must name the database it migrates. */
export function buildMigrateDsn(host: string, port: number, password: string): string {
  return `mysql://${MIGRATE_USER}:${password}@${host}:${port}/${MIGRATE_DB}`;
}

/** Extract the password from an existing bootstrap DSN, or undefined if the
 *  string is not a URL with a password. */
export function passwordFromDsn(dsn: string): string | undefined {
  try {
    const pw = new URL(dsn).password;
    return pw ? decodeURIComponent(pw) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide the bootstrap password from whatever the secret currently holds:
 *   - empty/absent → generate a fresh one (`reused: false`, caller writes the DSN).
 *   - an existing DSN with a password → reuse it (`reused: true`), so the user's
 *     password stays in lock-step with the secret the bootstrap task already
 *     reads, and re-deploys cause no churn. Covers a secret pre-seeded
 *     out-of-band (PR 1) as well as a prior seeder run.
 *   - present but NOT a DSN-with-password → throw, never silently clobber an
 *     unexpected value (fails the deploy loud).
 */
export function decidePassword(
  existing: string | undefined,
  label = "bootstrap",
): {
  password: string;
  reused: boolean;
} {
  if (existing === undefined || existing.trim().length === 0) {
    return { password: generatePassword(), reused: false };
  }
  const pw = passwordFromDsn(existing);
  if (pw === undefined) {
    throw new Error(
      `${label} secret holds a value that is not a mysql:// DSN with a password; refusing to overwrite it`,
    );
  }
  return { password: pw, reused: true };
}
