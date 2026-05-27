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

/** The DSN the bootstrap ECS task consumes as BOOTSTRAP_DSN. Alphanumeric
 *  password ⇒ no URL-encoding needed. No database segment: the task connects at
 *  server level to CREATE the audit database. */
export function buildDsn(host: string, port: number, password: string): string {
  return `mysql://${BOOTSTRAP_USER}:${password}@${host}:${port}/`;
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
export function decidePassword(existing: string | undefined): {
  password: string;
  reused: boolean;
} {
  if (existing === undefined || existing.trim().length === 0) {
    return { password: generatePassword(), reused: false };
  }
  const pw = passwordFromDsn(existing);
  if (pw === undefined) {
    throw new Error(
      "bootstrap secret holds a value that is not a mysql:// DSN with a password; refusing to overwrite it",
    );
  }
  return { password: pw, reused: true };
}
