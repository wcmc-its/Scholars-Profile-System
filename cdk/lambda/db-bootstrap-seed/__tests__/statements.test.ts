import { describe, expect, it } from "vitest";

import {
  appRoAuditGrantStatements,
  appRoHostsQuery,
  appRwTightenStatements,
  buildDsn,
  buildMigrateDsn,
  decidePassword,
  dropStatements,
  generatePassword,
  migrateDropStatements,
  migrateSeedStatements,
  passwordFromDsn,
  seedStatements,
} from "../statements.js";

describe("generatePassword", () => {
  it("defaults to 32 alphanumeric chars", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("honors a custom length and is URL/SQL-safe (no quotes, @, /, %)", () => {
    const pw = generatePassword(48);
    expect(pw).toHaveLength(48);
    expect(pw).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("does not repeat across calls", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("seedStatements", () => {
  const stmts = seedStatements("PW123");

  it("creates + repairs the user and grants only audit-scoped privileges", () => {
    expect(stmts).toEqual([
      "CREATE USER IF NOT EXISTS 'sps_bootstrap'@'%' IDENTIFIED BY 'PW123'",
      "ALTER USER 'sps_bootstrap'@'%' IDENTIFIED BY 'PW123'",
      "GRANT CREATE, ALTER ON `scholars_audit`.* TO 'sps_bootstrap'@'%'",
      "GRANT INSERT ON `scholars_audit`.* TO 'sps_bootstrap'@'%' WITH GRANT OPTION",
    ]);
  });

  it("never grants anything on the application `scholars` schema", () => {
    for (const s of stmts) {
      // No grant references `scholars`.* (only `scholars_audit`).
      expect(s).not.toMatch(/ON `scholars`\./);
    }
  });

  it("never grants SELECT/UPDATE/DELETE/DROP (least privilege)", () => {
    const grants = stmts.filter((s) => s.startsWith("GRANT"));
    for (const g of grants) {
      const privs = g.slice(0, g.indexOf(" ON "));
      expect(privs).not.toMatch(/\b(SELECT|UPDATE|DELETE|DROP|ALL PRIVILEGES)\b/);
    }
  });
});

describe("dropStatements", () => {
  it("drops the bootstrap user idempotently", () => {
    expect(dropStatements()).toEqual(["DROP USER IF EXISTS 'sps_bootstrap'@'%'"]);
  });
});

describe("migrateSeedStatements (ADR-009 Phase 1)", () => {
  const stmts = migrateSeedStatements("PW123");

  it("creates + repairs sps_migrate and grants the proven scholars.* DDL set", () => {
    expect(stmts).toEqual([
      "CREATE USER IF NOT EXISTS 'sps_migrate'@'%' IDENTIFIED BY 'PW123'",
      "ALTER USER 'sps_migrate'@'%' IDENTIFIED BY 'PW123'",
      "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, EXECUTE, TRIGGER ON `scholars`.* TO 'sps_migrate'@'%'",
    ]);
  });

  it("grants ONLY on the application `scholars` schema — nothing on scholars_audit", () => {
    for (const s of stmts) {
      expect(s).not.toMatch(/scholars_audit/);
    }
    const grant = stmts.find((s) => s.startsWith("GRANT"));
    expect(grant).toMatch(/ON `scholars`\.\* TO/);
  });

  it("matches the privilege set the verify pins for sps_migrate (ADR-009 req 6)", () => {
    // The seeder GRANT and scripts/verify-db-grants.ts ROLES.sps_migrate.golden
    // must stay equal; both are the inherited app_rw scholars.* set, verbatim.
    const grant = stmts.find((s) => s.startsWith("GRANT")) as string;
    const privs = grant.slice("GRANT ".length, grant.indexOf(" ON "));
    expect(privs).toBe(
      "SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, EXECUTE, TRIGGER",
    );
  });
});

describe("migrateDropStatements", () => {
  it("drops the migrate user idempotently", () => {
    expect(migrateDropStatements()).toEqual(["DROP USER IF EXISTS 'sps_migrate'@'%'"]);
  });
});

describe("appRwTightenStatements (ADR-009 Phase 3)", () => {
  it("revokes exactly the scholars.* DDL from app_rw, host-scoped, via IF EXISTS", () => {
    expect(appRwTightenStatements("10.20.%")).toEqual([
      "REVOKE IF EXISTS CREATE, DROP, ALTER, INDEX, REFERENCES, EXECUTE, TRIGGER ON `scholars`.* FROM 'app_rw'@'10.20.%'",
    ]);
  });

  it("interpolates the per-env grantee host (prod `%`)", () => {
    expect(appRwTightenStatements("%")[0]).toContain("FROM 'app_rw'@'%'");
  });

  it("never revokes the DML app_rw must keep (SELECT/INSERT/UPDATE/DELETE)", () => {
    const revoke = appRwTightenStatements("%")[0];
    const privs = revoke.slice("REVOKE IF EXISTS ".length, revoke.indexOf(" ON "));
    expect(privs).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b/);
  });

  it("uses REVOKE IF EXISTS so a re-run (DDL already gone) is a no-op, not an error", () => {
    expect(appRwTightenStatements("%")[0]).toMatch(/^REVOKE IF EXISTS /);
  });

  it("touches only `scholars`.* — never the audit schema", () => {
    const revoke = appRwTightenStatements("%")[0];
    expect(revoke).not.toMatch(/scholars_audit/);
    expect(revoke).toMatch(/ON `scholars`\.\* FROM/);
  });
});

describe("appRoAuditGrantStatements (#917)", () => {
  it("grants SELECT on the audit TABLE to app_ro at the given host", () => {
    expect(appRoAuditGrantStatements("10.20.%")).toEqual([
      "GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'10.20.%'",
    ]);
  });

  it("interpolates the discovered host (prod `%`)", () => {
    expect(appRoAuditGrantStatements("%")[0]).toContain("TO 'app_ro'@'%'");
  });

  it("is SELECT-only — never a write privilege on the append-only log", () => {
    const grant = appRoAuditGrantStatements("%")[0];
    const privs = grant.slice("GRANT ".length, grant.indexOf(" ON "));
    expect(privs).toBe("SELECT");
    expect(privs).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|ALL PRIVILEGES)\b/);
  });

  it("scopes to the single audit table, not the whole `scholars_audit` schema", () => {
    const grant = appRoAuditGrantStatements("%")[0];
    expect(grant).toMatch(/ON `scholars_audit`\.`manual_edit_audit` TO/);
    expect(grant).not.toMatch(/`scholars_audit`\.\* /);
  });

  it("matches the SELECT the verify pins for app-ro (conscious paired edit)", () => {
    // The seeder grant and scripts/verify-db-grants.ts ROLES['app-ro'].golden must stay equal.
    expect(appRoAuditGrantStatements("%")[0]).toBe(
      "GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'%'",
    );
  });
});

describe("appRoHostsQuery (#917 — host discovery)", () => {
  it("reads the host pattern(s) app_ro exists at from mysql.user", () => {
    expect(appRoHostsQuery()).toBe("SELECT host FROM mysql.user WHERE user = 'app_ro'");
  });
});

describe("buildMigrateDsn", () => {
  it("carries the `scholars` database segment (prisma DATABASE_URL needs it)", () => {
    const dsn = buildMigrateDsn("db.internal", 3306, "PW123");
    expect(dsn).toBe("mysql://sps_migrate:PW123@db.internal:3306/scholars");
    expect(passwordFromDsn(dsn)).toBe("PW123");
  });
});

describe("buildDsn / passwordFromDsn round-trip", () => {
  it("builds a database-less DSN the bootstrap task can parse", () => {
    const dsn = buildDsn("db.internal", 3306, "PW123");
    expect(dsn).toBe("mysql://sps_bootstrap:PW123@db.internal:3306/");
    expect(passwordFromDsn(dsn)).toBe("PW123");
  });

  it("returns undefined for a non-URL or password-less value", () => {
    expect(passwordFromDsn("not a dsn")).toBeUndefined();
    expect(passwordFromDsn("mysql://user@host:3306/")).toBeUndefined();
  });
});

describe("decidePassword", () => {
  it("generates a fresh password when the secret is empty/absent", () => {
    expect(decidePassword(undefined).reused).toBe(false);
    expect(decidePassword("").reused).toBe(false);
    expect(decidePassword("   ").reused).toBe(false);
    expect(decidePassword(undefined).password).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("reuses the existing password from a valid DSN (no churn)", () => {
    const { password, reused } = decidePassword(
      "mysql://sps_bootstrap:ExistingPW@db.internal:3306/",
    );
    expect(reused).toBe(true);
    expect(password).toBe("ExistingPW");
  });

  it("refuses to clobber an unexpected non-DSN value (fails-closed)", () => {
    expect(() => decidePassword("some-manually-set-thing")).toThrow(/refusing to overwrite/);
  });
});
