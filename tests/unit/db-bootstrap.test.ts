import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertInsertOnlyAuditGrant,
  bootstrap,
  buildGrantSql,
  ETL_GRANTEE,
  extractStatements,
  granteeFromAppRwDsn,
  parseDsn,
  validateHost,
  type SqlConn,
} from "@/scripts/db-bootstrap";

// Resolve from the repo root (vitest's cwd) — under the vite transform
// import.meta.url is not a file:// URL, so fileURLToPath would reject.
const AUDIT_SQL = readFileSync(
  path.join(process.cwd(), "scripts/sql/audit-log.sql"),
  "utf8",
);

const AUDIT_TS = readFileSync(
  path.join(process.cwd(), "lib/edit/audit.ts"),
  "utf8",
);

// Pulls the quoted literals out of a `export type <Name> = | "a" | "b" ...;`
// union declaration. Anchored to the `| "literal"` union-member shape (not
// any quoted string in the block) so JSDoc prose containing quoted words
// (and, critically, semicolons — the JSDoc comments in this file are full of
// them) can't be mistaken for a member or for the terminator. Block comments
// are stripped first so the *first* `;` found really is the union's own
// terminator, not one inside a `/** ... */` comment.
function tsUnionMembers(typeName: string): string[] {
  const stripped = AUDIT_TS.replace(/\/\*\*[\s\S]*?\*\//g, "");
  const marker = `export type ${typeName} =`;
  const start = stripped.indexOf(marker);
  if (start === -1) {
    throw new Error(`type ${typeName} not found in lib/edit/audit.ts`);
  }
  const end = stripped.indexOf(";", start);
  if (end === -1) {
    throw new Error(`no terminating ; found for type ${typeName}`);
  }
  const block = stripped.slice(start + marker.length, end);
  const members: string[] = [];
  const re = /\|\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    members.push(m[1]);
  }
  if (members.length === 0) {
    throw new Error(`no union members parsed for type ${typeName}`);
  }
  return members;
}

// Pulls the value list out of a `` `column` ENUM('a','b',...) `` column
// definition within one SQL statement (as already split by
// `extractStatements`).
function sqlEnumValues(statement: string, column: string): string[] {
  const re = new RegExp("`" + column + "`\\s*ENUM\\(([^)]*)\\)");
  const match = statement.match(re);
  if (!match) {
    throw new Error(`no ENUM(...) found for column \`${column}\` in statement: ${statement.slice(0, 80)}...`);
  }
  return match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

function assertSubset(members: string[], enumValues: string[], label: string) {
  const missing = members.filter((v) => !enumValues.includes(v));
  expect(missing, `${label} — TS members with no matching SQL ENUM entry`).toEqual([]);
}

describe("parseDsn", () => {
  it("parses host/port/user/password", () => {
    const p = parseDsn("mysql://sps_bootstrap:s3cr3t@db.internal:3307/");
    expect(p).toMatchObject({
      host: "db.internal",
      port: 3307,
      user: "sps_bootstrap",
      password: "s3cr3t",
      ssl: false,
    });
  });

  it("defaults the port to 3306 and url-decodes the password", () => {
    const p = parseDsn("mysql://u:p%40ss@h/");
    expect(p.port).toBe(3306);
    expect(p.password).toBe("p@ss");
  });

  it("enables ssl on ?ssl=true or an sslmode param", () => {
    expect(parseDsn("mysql://u:p@h/?ssl=true").ssl).toBe(true);
    expect(parseDsn("mysql://u:p@h/?sslmode=require").ssl).toBe(true);
    expect(parseDsn("mysql://u:p@h/").ssl).toBe(false);
  });
});

describe("granteeFromAppRwDsn", () => {
  it("extracts the username from the app-rw DSN", () => {
    expect(granteeFromAppRwDsn("mysql://sps_app:pw@h:3306/scholars")).toBe("sps_app");
  });

  it("refuses a username that is not a simple identifier (GRANT-injection guard)", () => {
    expect(() => granteeFromAppRwDsn("mysql://e%27vil:pw@h/scholars")).toThrow(/not a simple identifier/);
  });
});

describe("extractStatements", () => {
  it("yields exactly the audit DDL and never the commented GRANT template", () => {
    const stmts = extractStatements(AUDIT_SQL);
    // CREATE DATABASE, CREATE TABLE, three ALTER TABLEs — and nothing else.
    // ALTER #1 is the `action` enum widening (now also carrying #540 Phase 1's
    // three unit-curation actions and #637's two impersonation actions); #2 is
    // the #540 Phase 1 widening of `target_entity_type` to cover department /
    // division / center; #3 is #637's `impersonated_cwid` ADD COLUMN.
    expect(stmts).toHaveLength(5);
    expect(stmts[0]).toMatch(/^CREATE DATABASE IF NOT EXISTS `scholars_audit`/);
    expect(stmts[1]).toMatch(/^CREATE TABLE IF NOT EXISTS `scholars_audit`\.`manual_edit_audit`/);
    expect(stmts[2]).toMatch(/^ALTER TABLE `scholars_audit`\.`manual_edit_audit`\s+MODIFY COLUMN `action`/);
    expect(stmts[3]).toMatch(/^ALTER TABLE `scholars_audit`\.`manual_edit_audit`\s+MODIFY COLUMN `target_entity_type`/);
    expect(stmts[4]).toMatch(
      /^ALTER TABLE `scholars_audit`\.`manual_edit_audit`\s+ADD COLUMN `impersonated_cwid`/,
    );
    // No `IF NOT EXISTS` — Aurora (MySQL 8.0) rejects it on ADD COLUMN; the
    // runner handles re-run idempotency via the 1060 catch (test below).
    expect(stmts[4]).not.toMatch(/ADD COLUMN IF NOT EXISTS/i);
    // The GRANT template at the foot is fully commented — no executable GRANT
    // statement must survive (the `'grant'` entity-type ENUM value is fine).
    expect(stmts.some((s) => /\bGRANT\s+\w+\s+ON\b/i.test(s))).toBe(false);
  });

  it("strips both line and block comments", () => {
    const sql = "/* block */ SELECT 1; -- trailing\nSELECT 2; -- done";
    expect(extractStatements(sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("AuditAction / AuditEntityType TS unions vs SQL ENUM contract (#2114)", () => {
  // Index positions match the shape asserted in the `extractStatements` test
  // above: [0] CREATE DATABASE, [1] CREATE TABLE, [2] ALTER MODIFY `action`,
  // [3] ALTER MODIFY `target_entity_type`, [4] ALTER ADD COLUMN.
  const stmts = extractStatements(AUDIT_SQL);
  const createTable = stmts[1];
  const alterAction = stmts[2];
  const alterEntityType = stmts[3];

  const tsActions = tsUnionMembers("AuditAction");
  const tsEntityTypes = tsUnionMembers("AuditEntityType");

  const createActionEnum = sqlEnumValues(createTable, "action");
  const alterActionEnum = sqlEnumValues(alterAction, "action");
  const createEntityTypeEnum = sqlEnumValues(createTable, "target_entity_type");
  const alterEntityTypeEnum = sqlEnumValues(alterEntityType, "target_entity_type");

  // Subset, NOT set-equality: the SQL convention is append-only (a widening
  // migration is allowed to ship before the TS code that uses the new
  // value — "Appended LAST to preserve existing ENUM ordinals"). The actual
  // 1265-truncation bug is the other direction: a TS member with no matching
  // SQL ENUM entry.
  it("every AuditAction member has a matching CREATE TABLE `action` ENUM entry", () => {
    assertSubset(tsActions, createActionEnum, "AuditAction vs CREATE TABLE action ENUM");
  });

  it("every AuditAction member has a matching MODIFY COLUMN `action` ENUM entry", () => {
    assertSubset(tsActions, alterActionEnum, "AuditAction vs MODIFY COLUMN action ENUM");
  });

  it("every AuditEntityType member has a matching CREATE TABLE `target_entity_type` ENUM entry", () => {
    assertSubset(tsEntityTypes, createEntityTypeEnum, "AuditEntityType vs CREATE TABLE target_entity_type ENUM");
  });

  it("every AuditEntityType member has a matching MODIFY COLUMN `target_entity_type` ENUM entry", () => {
    assertSubset(tsEntityTypes, alterEntityTypeEnum, "AuditEntityType vs MODIFY COLUMN target_entity_type ENUM");
  });

  // Order-sensitive: both sides are SQL, and MODIFY COLUMN restates the full
  // literal, so the CREATE TABLE and ALTER value lists should match exactly.
  it("the CREATE TABLE and MODIFY COLUMN `action` ENUM value lists are in the same order", () => {
    expect(alterActionEnum).toEqual(createActionEnum);
  });

  it("the CREATE TABLE and MODIFY COLUMN `target_entity_type` ENUM value lists are in the same order", () => {
    expect(alterEntityTypeEnum).toEqual(createEntityTypeEnum);
  });
});

describe("buildGrantSql", () => {
  it("is an INSERT-only, identifier-quoted grant scoped to the audit table", () => {
    expect(buildGrantSql("sps_app")).toBe(
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO 'sps_app'@'%'",
    );
  });

  it("honors a custom grantee host (local dev = localhost)", () => {
    expect(buildGrantSql("scholars", "localhost")).toBe(
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO 'scholars'@'localhost'",
    );
  });
});

describe("validateHost", () => {
  it.each(["%", "localhost", "10.0.%", "db.internal-1"])("accepts %j", (h) => {
    expect(validateHost(h)).toBe(h);
  });

  it("rejects an injection attempt in the host pattern", () => {
    expect(() => validateHost("%'; DROP USER 'x")).toThrow(/not a valid host pattern/);
  });
});

describe("assertInsertOnlyAuditGrant (#102 criterion)", () => {
  it("accepts an INSERT-only audit grant", () => {
    expect(() =>
      assertInsertOnlyAuditGrant([
        "GRANT USAGE ON *.* TO `sps_app`@`%`",
        "GRANT ALL PRIVILEGES ON `scholars`.* TO `sps_app`@`%`",
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]),
    ).not.toThrow();
  });

  it("does NOT confuse the `scholars` ALL grant with `scholars_audit`", () => {
    // `scholars` is a prefix of `scholars_audit`; matching must be exact.
    expect(() =>
      assertInsertOnlyAuditGrant([
        "GRANT ALL PRIVILEGES ON `scholars`.* TO `sps_app`@`%`",
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]),
    ).not.toThrow();
  });

  it("rejects UPDATE/DELETE/ALL on the audit database", () => {
    expect(() =>
      assertInsertOnlyAuditGrant([
        "GRANT INSERT, UPDATE ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]),
    ).toThrow(/forbidden privilege on scholars_audit/);
    expect(() =>
      assertInsertOnlyAuditGrant([
        "GRANT ALL PRIVILEGES ON `scholars_audit`.* TO `sps_app`@`%`",
      ]),
    ).toThrow(/forbidden privilege/);
  });

  it("rejects when no INSERT grant on the audit table is present", () => {
    expect(() =>
      assertInsertOnlyAuditGrant(["GRANT ALL PRIVILEGES ON `scholars`.* TO `sps_app`@`%`"]),
    ).toThrow(/no INSERT grant/);
  });
});

describe("bootstrap", () => {
  function fakeConn(grantLines: string[] = []): SqlConn & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (/^SHOW GRANTS/i.test(sql)) {
          return grantLines.map((g) => ({ "Grants for sps_app@%": g }));
        }
        return undefined;
      }),
      end: vi.fn(async () => {}),
    };
  }

  it("applies DDL + grant on the bootstrap conn, then verifies app-rw (own conn) and etl (bootstrap conn)", async () => {
    const conn = fakeConn([
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `etl`@`%`",
    ]);
    const verifyConn = fakeConn([
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
    ]);
    await bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn });

    const ddl = extractStatements(AUDIT_SQL);
    // The privileged connection runs the DDL, the app-rw GRANT, the etl GRANT,
    // and (etl only) a `SHOW GRANTS FOR 'etl'@'%'` self-check -- app-rw's own
    // grants still never get read here (the least-priv bootstrap user can't
    // read another account's grants without SELECT on mysql.user), but etl
    // has no bootstrap-task DSN to open a self-verify connection with, so its
    // check runs on the bootstrap connection instead. On real Aurora that
    // read is itself denied (see the "SHOW GRANTS visibility denial" describe
    // block below) -- this fake just represents the (rarer, but possible)
    // case where it succeeds.
    expect(conn.calls).toEqual([
      ...ddl,
      buildGrantSql("sps_app"),
      buildGrantSql(ETL_GRANTEE),
      `SHOW GRANTS FOR '${ETL_GRANTEE}'@'%'`,
    ]);
    // Verification runs as the grantee itself (CURRENT_USER), never as a named
    // account (which would need SELECT on mysql.user).
    expect(verifyConn.calls).toEqual(["SHOW GRANTS FOR CURRENT_USER()"]);
  });

  it("fails-closed: a DDL error propagates (non-zero exit upstream)", async () => {
    const verifyConn = fakeConn();
    const conn: SqlConn = {
      query: vi.fn(async (sql: string) => {
        if (/CREATE TABLE/i.test(sql)) throw new Error("CREATE command denied");
        return undefined;
      }),
      end: vi.fn(async () => {}),
    };
    await expect(
      bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
    ).rejects.toThrow(/CREATE command denied/);
  });

  it("idempotent ADD COLUMN: a 1060 duplicate-column error is a no-op (re-run safe)", async () => {
    // Aurora (MySQL 8.0) has no `ADD COLUMN IF NOT EXISTS`, so a second deploy
    // re-runs the plain ADD COLUMN and errors 1060. The runner must swallow that
    // one case and still complete the grant + verify (#637).
    const verifyConn = fakeConn([
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
    ]);
    const conn: SqlConn = {
      query: vi.fn(async (sql: string) => {
        if (/ADD COLUMN/i.test(sql)) {
          const e = new Error("Duplicate column name 'impersonated_cwid'") as Error & {
            errno: number;
          };
          e.errno = 1060;
          throw e;
        }
        if (/^SHOW GRANTS/i.test(sql)) {
          // The etl self-check, run on this same privileged connection (see
          // the happy-path test above for why).
          return [
            {
              "Grants for etl@%":
                "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `etl`@`%`",
            },
          ];
        }
        return undefined;
      }),
      end: vi.fn(async () => {}),
    };
    await expect(
      bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
    ).resolves.toBeUndefined();
  });

  it("fails-closed: a 1060 on a non-ADD-COLUMN statement still propagates", async () => {
    const verifyConn = fakeConn();
    const conn: SqlConn = {
      query: vi.fn(async (sql: string) => {
        if (/CREATE TABLE/i.test(sql)) {
          const e = new Error("dup") as Error & { errno: number };
          e.errno = 1060;
          throw e;
        }
        return undefined;
      }),
      end: vi.fn(async () => {}),
    };
    await expect(
      bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
    ).rejects.toThrow(/dup/);
  });

  it("fails-closed: a non-INSERT-only verification result throws", async () => {
    const conn = fakeConn();
    const verifyConn = fakeConn([
      "GRANT INSERT, DELETE ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
    ]);
    await expect(
      bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
    ).rejects.toThrow(/forbidden privilege on scholars_audit/);
  });

  describe("etl role grant (#2556 — MySQL 1142 on the autolock audit write)", () => {
    it("issues the etl GRANT and verifies it INSERT-only via SHOW GRANTS on the bootstrap conn", async () => {
      const conn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `etl`@`%`",
      ]);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      await expect(
        bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
      ).resolves.toBeUndefined();

      expect(conn.calls).toContain(buildGrantSql(ETL_GRANTEE));
      expect(conn.calls).toContain(`SHOW GRANTS FOR '${ETL_GRANTEE}'@'%'`);
    });

    it("fails-closed: an UPDATE/DELETE reported for etl on scholars_audit throws", async () => {
      const conn = fakeConn([
        "GRANT INSERT, DELETE ON `scholars_audit`.`manual_edit_audit` TO `etl`@`%`",
      ]);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      await expect(
        bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
      ).rejects.toThrow(/etl role holds a forbidden privilege on scholars_audit/);
    });

    it("fails-closed: a missing INSERT grant for etl throws", async () => {
      // No `scholars_audit` line in the fake's SHOW GRANTS response at all --
      // the grant never took.
      const conn = fakeConn([]);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      await expect(
        bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
      ).rejects.toThrow(/etl role has no INSERT grant/);
    });

    it("does not fail on excess etl grants outside scholars_audit (out of scope)", async () => {
      const conn = fakeConn([
        "GRANT SELECT, INSERT, UPDATE, DELETE ON `scholars`.* TO `etl`@`%`",
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `etl`@`%`",
      ]);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      await expect(
        bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
      ).resolves.toBeUndefined();
    });
  });

  describe("etl grant verify — SHOW GRANTS visibility denial (#2567 follow-up)", () => {
    // Empirical: sps-db-bootstrap-staging task fb765f93 (2026-08-31) --
    //   (conn:33623, no: 1142, SQLState: 42000) SELECT command denied to user
    //   'sps_bootstrap'@'10.46.160.141' for table 'user'
    //   sql: SHOW GRANTS FOR 'etl'@'10.46.160.%'
    // Aurora requires SELECT on `mysql.user` to view another account's
    // grants at all; `sps_bootstrap`'s GRANT OPTION on `scholars_audit` does
    // not substitute. This denial is permanent (sps_bootstrap will never hold
    // that SELECT), so it must be tolerated, not treated as a transient fault.
    function connThrowingOnEtlShowGrants(err: unknown): SqlConn & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        query: vi.fn(async (sql: string) => {
          calls.push(sql);
          if (/^SHOW GRANTS FOR '/i.test(sql)) throw err;
          return undefined;
        }),
        end: vi.fn(async () => {}),
      };
    }

    it("warns and continues on the empirical Aurora denial (errno 1142) -- bootstrap still succeeds", async () => {
      const denial = new Error(
        "(conn:33623, no: 1142, SQLState: 42000) SELECT command denied to user " +
          "'sps_bootstrap'@'10.46.160.141' for table 'user'",
      ) as Error & { errno: number };
      denial.errno = 1142;
      const conn = connThrowingOnEtlShowGrants(denial);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      const logs: string[] = [];

      await expect(
        bootstrap(conn, {
          sqlText: AUDIT_SQL,
          grantee: "sps_app",
          verifyConn,
          log: (m) => logs.push(m),
        }),
      ).resolves.toBeUndefined();

      // The app-role verify still ran, on its own connection, unaffected by
      // etl's denial (it happens earlier in `bootstrap()`).
      expect(verifyConn.calls).toEqual(["SHOW GRANTS FOR CURRENT_USER()"]);
      // The etl GRANT was still issued -- only the verify READ is skipped.
      expect(conn.calls).toContain(buildGrantSql(ETL_GRANTEE));
      expect(conn.calls).toContain(`SHOW GRANTS FOR '${ETL_GRANTEE}'@'%'`);
      expect(logs.some((m) => /verify skipped/.test(m))).toBe(true);
    });

    it("fails-closed on a different error at the same call site (errno present, not 1142)", async () => {
      const other = new Error("connection reset by peer") as Error & { errno: number };
      other.errno = 2013;
      const conn = connThrowingOnEtlShowGrants(other);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      await expect(
        bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
      ).rejects.toThrow(/connection reset by peer/);
    });

    it("fails-closed on a different error with no errno at all (message fallback doesn't match)", async () => {
      const other = new Error("ECONNRESET");
      const conn = connThrowingOnEtlShowGrants(other);
      const verifyConn = fakeConn([
        "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
      ]);
      await expect(
        bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn }),
      ).rejects.toThrow(/ECONNRESET/);
    });
  });
});
