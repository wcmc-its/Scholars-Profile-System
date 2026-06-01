import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertInsertOnlyAuditGrant,
  bootstrap,
  buildGrantSql,
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

  it("applies DDL + grant on the bootstrap conn, then verifies on the grantee conn", async () => {
    const conn = fakeConn();
    const verifyConn = fakeConn([
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `sps_app`@`%`",
    ]);
    await bootstrap(conn, { sqlText: AUDIT_SQL, grantee: "sps_app", verifyConn });

    const ddl = extractStatements(AUDIT_SQL);
    // The privileged connection runs exactly the DDL + the GRANT, and NO
    // `SHOW GRANTS`: the least-priv bootstrap user cannot read app-rw's grants,
    // so verification moved to the grantee's own connection.
    expect(conn.calls).toEqual([...ddl, buildGrantSql("sps_app")]);
    expect(conn.calls.some((c) => /^SHOW GRANTS/i.test(c))).toBe(false);
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
});
