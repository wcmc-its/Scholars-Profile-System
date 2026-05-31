/**
 * verify-db-grants — ADR-009 Phase 0. The grant-equality verify.
 *
 * WHAT THIS IS (and what it deliberately is NOT)
 *   For each managed DB role this asserts that the role's LIVE grants EXACTLY
 *   equal a pinned per-role golden list, failing closed on any delta in EITHER
 *   direction -- excess OR missing. It is NOT a `can-CREATE` / `cannot-CREATE`
 *   capability probe. The failure mode being guarded is *excess* privilege --
 *   that is what drifted in the 2026-05-30 staging incident (`app_rw` sitting at
 *   the blunt `ALL PRIVILEGES ON scholars.*`), and a capability probe cannot see
 *   a role quietly *retaining* a grant a revoke missed. Only a set-equality diff
 *   against a golden list catches retained excess (ADR-009 "Verification model").
 *
 * GRANTEE-SIDE BY DESIGN (#607)
 *   It reads `SHOW GRANTS FOR CURRENT_USER()` while connected AS each role,
 *   never `SHOW GRANTS FOR '<other>'@'<host>'`. The latter needs SELECT on
 *   `mysql.user`, a privilege the least-privilege roles deliberately lack; a role
 *   can always read its own grants. Connecting as the role also folds a
 *   credential/connectivity check into the verify for free.
 *
 * FAIL-CLOSED
 *   Any delta throws; `main()` exits non-zero. Wired into the deploy pipeline
 *   this halts the deploy before the service rolls (ADR-009 Downstream req 2),
 *   exactly as #493's db-bootstrap does for the audit grant.
 *
 * GOLDEN-LIST PROVENANCE (and the one honest caveat)
 *   The golden lists below are pinned from the authoritative documented sets:
 *   `app_rw`/`app_ro` from ADR-009 Context + `access-control-rbac.md` Layer 3;
 *   `sps_bootstrap` from `cdk/lambda/db-bootstrap-seed/statements.ts`;
 *   `sps_migrate` from ADR-009 Decision 1 (the proven `app_rw` `scholars.*` set,
 *   inherited verbatim). Per ADR-009 the FIRST live Phase 0 run is what *confirms*
 *   these against reality: a delta on first run is real drift to reconcile (or a
 *   golden-list edit to make consciously), not a bug in this checker. The verify
 *   proves the grant SHAPE equals the golden list; it cannot prove the golden
 *   list is itself complete (ADR-009 "honest limit").
 *
 * Usage (against current state, per Phase 0):
 *   APP_RO_DSN=... APP_RW_DSN=... BOOTSTRAP_DSN=... npm run db:verify-grants
 *   Phase 1 adds the migrate role: set MIGRATE_DSN and
 *   VERIFY_ROLES=app-ro,app-rw,sps_migrate,sps_bootstrap.
 */
import { pathToFileURL } from "node:url";

import { createConnection } from "mariadb";

// Reuse the single DSN parser the app tooling already uses (relative import so
// it resolves under tsx at deploy time, not just under vitest's `@/` alias).
import { parseDsn, type SqlConn } from "./db-bootstrap";

/** A managed DB role this verify knows how to check. The labels match how
 *  ADR-009 / `access-control-rbac.md` name the roles, for traceability. */
export type RoleName = "app-ro" | "app-rw" | "sps_migrate" | "sps_bootstrap";

/** Per-role config: the env var holding that role's DSN, and the golden grant
 *  list (expressed as ordinary GRANT statements -- canonicalized identically to
 *  live `SHOW GRANTS` output, so there is one normalizer and no hand-sorted
 *  golden tokens to get wrong). The grantee in `TO ...` is irrelevant: it is
 *  normalized away, so host patterns like `10.20.%` vs `%` never matter. */
export const ROLES: Record<RoleName, { dsnEnv: string; golden: string[] }> = {
  // app reads -- SELECT only.
  "app-ro": {
    dsnEnv: "APP_RO_DSN",
    golden: ["GRANT SELECT ON `scholars`.* TO `app_ro`@`%`"],
  },
  // runtime writer -- DML-only on `scholars`.* (ADR-009 Phase 3 tightened this:
  // the DDL now lives only in the deploy-time `sps_migrate` role, and the seeder
  // REVOKEs it from app_rw -- `db-bootstrap-seed/statements.ts`
  // appRwTightenStatements). This list and that REVOKE are a CONSCIOUS paired
  // edit (Decision 1 / req 6): the privileges dropped here must equal those the
  // seeder revokes. Plus the #102 audit INSERT (on `scholars_audit`).
  "app-rw": {
    dsnEnv: "APP_RW_DSN",
    golden: [
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `scholars`.* TO `app_rw`@`%`",
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `app_rw`@`%`",
    ],
  },
  // deploy-time migration runner (created in ADR-009 Phase 1). Golden = the
  // proven `app_rw` `scholars.*` set inherited verbatim (Decision 1: neither
  // extended nor pruned). No audit grant -- migrations touch `scholars` only.
  sps_migrate: {
    dsnEnv: "MIGRATE_DSN",
    golden: [
      "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, EXECUTE, TRIGGER ON `scholars`.* TO `sps_migrate`@`%`",
    ],
  },
  // #493 bootstrap role -- scoped to `scholars_audit` only, nothing on
  // `scholars`. One token, not two: `WITH GRANT OPTION` is a per-(user x
  // db-scope) privilege in MySQL/Aurora, NOT per-privilege. The seeder's two
  // statements (`db-bootstrap-seed/statements.ts` seedStatements(): `GRANT
  // CREATE,ALTER ...` then `GRANT INSERT ... WITH GRANT OPTION`) therefore
  // collapse into a single `SHOW GRANTS` line that carries the option across all
  // three privileges -- the realized form this golden must match (ADR-009: the
  // first live run confirms the pinned list). The role's actual privileges are
  // unchanged; only the encoding is corrected. Do NOT re-split into two lines:
  // no db-scope state can give INSERT the grant option while withholding it from
  // CREATE/ALTER, so a two-line golden is permanently unsatisfiable.
  sps_bootstrap: {
    dsnEnv: "BOOTSTRAP_DSN",
    golden: [
      "GRANT CREATE, ALTER, INSERT ON `scholars_audit`.* TO `sps_bootstrap`@`%` WITH GRANT OPTION",
    ],
  },
};

/** Split a privilege list on top-level commas only, so a column-scoped
 *  privilege such as `SELECT (col_a, col_b)` is not torn apart at the inner
 *  comma. Returns trimmed, non-empty tokens. */
export function splitPrivileges(privs: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of privs) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((p) => p.trim().replace(/\s+/g, " ")).filter((p) => p.length > 0);
}

/**
 * Canonicalize one `SHOW GRANTS` / GRANT line into a single comparable token,
 * or `null` for a line that carries no privilege to compare (a pure `USAGE`
 * grant). Normalization makes the comparison robust to everything that varies
 * cosmetically between two equivalent grants:
 *   - privilege case + ordering  -> uppercased, de-duped, sorted
 *   - identifier backticks        -> stripped (`` `scholars`.* `` -> `scholars.*`)
 *   - the grantee / host in `TO`  -> dropped entirely (host patterns irrelevant)
 *   - `WITH GRANT OPTION`         -> preserved as a suffix (it IS a real,
 *                                    comparable privilege -- escalation capability)
 *
 * `USAGE` is the no-privilege placeholder every account carries (`GRANT USAGE
 * ON *.*`); it never belongs in a golden list, so a pure-USAGE grant is dropped.
 * Dropping it cannot hide a *missing* real privilege -- a revoked privilege
 * surfaces as the golden token being absent from the live set, not as USAGE.
 *
 * A line that begins like a grant but cannot be parsed THROWS rather than being
 * silently ignored -- an unparseable grant must fail closed, never vanish.
 */
export function canonicalizeGrant(line: string): string | null {
  const m = line.match(/^\s*GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\b(.*)$/is);
  if (!m) {
    throw new Error(`unparseable grant line (refusing to ignore it): ${JSON.stringify(line)}`);
  }
  const privSet = Array.from(new Set(splitPrivileges(m[1]).map((p) => p.toUpperCase()))).sort();
  const object = m[2].replace(/`/g, "");
  const withGrantOption = /\bWITH\s+GRANT\s+OPTION\b/i.test(m[3]);

  if (privSet.length === 1 && privSet[0] === "USAGE") return null;

  return `${object} ${privSet.join(",")}${withGrantOption ? " WITH GRANT OPTION" : ""}`;
}

/** Canonicalize a list of grant lines into a set of comparable tokens (USAGE
 *  no-ops dropped). */
export function toGrantSet(lines: string[]): Set<string> {
  const set = new Set<string>();
  for (const line of lines) {
    const token = canonicalizeGrant(line);
    if (token !== null) set.add(token);
  }
  return set;
}

/** The set-equality diff: tokens the live role holds beyond the golden list
 *  (`excess`) and golden tokens the live role is missing (`missing`). Both empty
 *  == an exact match. Sorted for stable, readable error messages. */
export function diffGrants(
  golden: string[],
  liveLines: string[],
): { excess: string[]; missing: string[] } {
  const goldenSet = toGrantSet(golden);
  const liveSet = toGrantSet(liveLines);
  const excess = [...liveSet].filter((t) => !goldenSet.has(t)).sort();
  const missing = [...goldenSet].filter((t) => !liveSet.has(t)).sort();
  return { excess, missing };
}

/** Assert a role's live grants EQUAL its golden list exactly. Throws -- naming
 *  both the excess and the missing tokens -- on any delta in either direction.
 *  This is the load-bearing fail-closed gate. */
export function assertGrantsEqual(role: string, golden: string[], liveLines: string[]): void {
  const { excess, missing } = diffGrants(golden, liveLines);
  if (excess.length === 0 && missing.length === 0) return;
  const parts = [`grant drift for role '${role}' (live grants != golden list)`];
  if (excess.length > 0) parts.push(`EXCESS: [${excess.join(" | ")}]`);
  if (missing.length > 0) parts.push(`MISSING: [${missing.join(" | ")}]`);
  throw new Error(parts.join("; "));
}

/** Verify a single role over an open connection authenticated AS that role:
 *  read its own grants (`CURRENT_USER()`, the #607 grantee-side technique) and
 *  assert set-equality with the golden list. Throws on any delta. */
export async function verifyRole(
  conn: SqlConn,
  role: RoleName,
  golden: string[] = ROLES[role].golden,
): Promise<void> {
  const rows = (await conn.query("SHOW GRANTS FOR CURRENT_USER()")) as Array<
    Record<string, string>
  >;
  const grantLines = rows.map((r) => Object.values(r)[0]);
  assertGrantsEqual(role, golden, grantLines);
}

/** The roles this run must verify. Defaults to the three roles that exist at
 *  ADR-009 Phase 0 (current state); set `VERIFY_ROLES` to override -- Phase 1
 *  adds `sps_migrate`. Every required role MUST have its DSN env var set, so a
 *  forgotten DSN fails the run rather than silently skipping a security check
 *  (no silent caps). */
export function requiredRoles(env: Record<string, string | undefined> = process.env): RoleName[] {
  const raw = env.VERIFY_ROLES?.trim();
  const names = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["app-ro", "app-rw", "sps_bootstrap"];
  const unknown = names.filter((n) => !(n in ROLES));
  if (unknown.length > 0) {
    throw new Error(`VERIFY_ROLES names unknown role(s): ${unknown.join(", ")}`);
  }
  return names as RoleName[];
}

async function connectAs(dsn: string): Promise<SqlConn> {
  const parts = parseDsn(dsn);
  return (await createConnection({
    host: parts.host,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    ssl: parts.ssl || undefined,
    bigIntAsNumber: true,
    multipleStatements: false,
  })) as unknown as SqlConn;
}

async function main(): Promise<void> {
  const roles = requiredRoles();
  console.log(JSON.stringify({ event: "verify_db_grants_start", roles }));

  const failures: string[] = [];
  for (const role of roles) {
    const dsnEnv = ROLES[role].dsnEnv;
    const dsn = process.env[dsnEnv];
    if (!dsn) {
      // A required role with no DSN is a hard failure -- never a silent skip.
      failures.push(`${role}: ${dsnEnv} is not set`);
      console.error(
        JSON.stringify({ event: "verify_db_grants_role_skipped_unconfigured", role, dsnEnv }),
      );
      continue;
    }
    let conn: SqlConn | undefined;
    try {
      conn = await connectAs(dsn);
      await verifyRole(conn, role);
      console.log(JSON.stringify({ event: "verify_db_grants_role_ok", role }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${role}: ${message}`);
      console.error(
        JSON.stringify({ event: "verify_db_grants_role_failed", role, error: message }),
      );
    } finally {
      await conn?.end().catch(() => {});
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `grant verification failed for ${failures.length} role(s): ${failures.join(" || ")}`,
    );
  }
  console.log(JSON.stringify({ event: "verify_db_grants_ok", roles }));
}

// Run only when invoked directly (not when imported by the unit test).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        event: "verify_db_grants_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
}
