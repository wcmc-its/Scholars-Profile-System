import { describe, expect, it, vi } from "vitest";

import {
  runAppRoAuditGrant,
  runAppRwTighten,
  runMigrateSeed,
  runSeed,
  type AppRoAuditGrantDeps,
  type AppRwTightenDeps,
  type MigrateSeedDeps,
  type SeedDeps,
} from "../seed.js";

function deps(overrides: Partial<SeedDeps> = {}): SeedDeps & {
  queries: string[];
  logs: Array<{ event: string; extra?: Record<string, unknown> }>;
  put: ReturnType<typeof vi.fn>;
} {
  const queries: string[] = [];
  const logs: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const put = vi.fn(async () => {});
  return {
    requestType: "Create",
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
    }),
    getBootstrapSecret: vi.fn(async () => undefined),
    putBootstrapSecret: put,
    dbHost: "db.internal",
    dbPort: 3306,
    log: (event, extra) => logs.push({ event, extra }),
    queries,
    logs,
    put,
    ...overrides,
  };
}

describe("runSeed", () => {
  it("Create with an empty secret: creates the user, grants, and writes a fresh DSN", async () => {
    const d = deps();
    const res = await runSeed(d);

    expect(res.reused).toBe(false);
    expect(res.physicalResourceId).toBe("db-bootstrap-seed-sps_bootstrap");
    // 4 idempotent statements (CREATE USER, ALTER, 2 GRANTs).
    expect(d.queries).toHaveLength(4);
    expect(d.queries[0]).toMatch(/^CREATE USER IF NOT EXISTS 'sps_bootstrap'@'%'/);
    // A fresh DSN was persisted, carrying the generated password + host/port.
    expect(d.put).toHaveBeenCalledTimes(1);
    const dsn = d.put.mock.calls[0][0] as string;
    expect(dsn).toMatch(/^mysql:\/\/sps_bootstrap:[A-Za-z0-9]{32}@db\.internal:3306\/$/);
  });

  it("Update with an existing DSN: reuses the password and does NOT rewrite the secret", async () => {
    const d = deps({
      requestType: "Update",
      getBootstrapSecret: vi.fn(async () => "mysql://sps_bootstrap:ExistingPW@db.internal:3306/"),
    });
    const res = await runSeed(d);

    expect(res.reused).toBe(true);
    expect(d.put).not.toHaveBeenCalled();
    // The re-asserted user statements carry the reused password.
    expect(d.queries[1]).toBe("ALTER USER 'sps_bootstrap'@'%' IDENTIFIED BY 'ExistingPW'");
  });

  it("Delete: drops the user and touches no secret", async () => {
    const d = deps({ requestType: "Delete" });
    const res = await runSeed(d);

    expect(res.reused).toBe(false);
    expect(d.queries).toEqual(["DROP USER IF EXISTS 'sps_bootstrap'@'%'"]);
    expect(d.getBootstrapSecret).not.toHaveBeenCalled();
    expect(d.put).not.toHaveBeenCalled();
  });

  it("fails-closed: a SQL error propagates", async () => {
    const d = deps({
      query: vi.fn(async () => {
        throw new Error("Access denied for CREATE USER");
      }),
    });
    await expect(runSeed(d)).rejects.toThrow(/Access denied/);
  });

  it("never logs the password or the DSN", async () => {
    const d = deps();
    await runSeed(d);
    const serialized = JSON.stringify(d.logs);
    const dsn = d.put.mock.calls[0][0] as string;
    const password = dsn.slice("mysql://sps_bootstrap:".length, dsn.indexOf("@"));
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain("mysql://");
    // Only the outcome class + non-secret fields are logged.
    expect(d.logs[0]).toMatchObject({ event: "db_bootstrap_seed_ok", extra: { reused: false } });
  });
});

function migrateDeps(overrides: Partial<MigrateSeedDeps> = {}): MigrateSeedDeps & {
  queries: string[];
  logs: Array<{ event: string; extra?: Record<string, unknown> }>;
  put: ReturnType<typeof vi.fn>;
} {
  const queries: string[] = [];
  const logs: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const put = vi.fn(async () => {});
  return {
    requestType: "Create",
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
    }),
    getMigrateSecret: vi.fn(async () => undefined),
    putMigrateSecret: put,
    dbHost: "db.internal",
    dbPort: 3306,
    log: (event, extra) => logs.push({ event, extra }),
    queries,
    logs,
    put,
    ...overrides,
  };
}

describe("runMigrateSeed (ADR-009 Phase 1)", () => {
  it("Create with an empty secret: creates sps_migrate, grants, writes a fresh /scholars DSN", async () => {
    const d = migrateDeps();
    const res = await runMigrateSeed(d);

    expect(res.reused).toBe(false);
    // 3 idempotent statements (CREATE USER, ALTER, 1 GRANT).
    expect(d.queries).toHaveLength(3);
    expect(d.queries[0]).toMatch(/^CREATE USER IF NOT EXISTS 'sps_migrate'@'%'/);
    expect(d.queries[2]).toMatch(/^GRANT .* ON `scholars`\.\* TO 'sps_migrate'@'%'$/);
    // A fresh DSN was persisted, carrying the generated password + the database.
    expect(d.put).toHaveBeenCalledTimes(1);
    const dsn = d.put.mock.calls[0][0] as string;
    expect(dsn).toMatch(/^mysql:\/\/sps_migrate:[A-Za-z0-9]{32}@db\.internal:3306\/scholars$/);
  });

  it("Update with an existing DSN: reuses the password and does NOT rewrite the secret", async () => {
    const d = migrateDeps({
      requestType: "Update",
      getMigrateSecret: vi.fn(async () => "mysql://sps_migrate:ExistingPW@db.internal:3306/scholars"),
    });
    const res = await runMigrateSeed(d);

    expect(res.reused).toBe(true);
    expect(d.put).not.toHaveBeenCalled();
    expect(d.queries[1]).toBe("ALTER USER 'sps_migrate'@'%' IDENTIFIED BY 'ExistingPW'");
  });

  it("Delete: drops the migrate user and touches no secret", async () => {
    const d = migrateDeps({ requestType: "Delete" });
    const res = await runMigrateSeed(d);

    expect(res.reused).toBe(false);
    expect(d.queries).toEqual(["DROP USER IF EXISTS 'sps_migrate'@'%'"]);
    expect(d.getMigrateSecret).not.toHaveBeenCalled();
    expect(d.put).not.toHaveBeenCalled();
  });

  it("fails-closed: a SQL error propagates", async () => {
    const d = migrateDeps({
      query: vi.fn(async () => {
        throw new Error("Access denied for CREATE USER");
      }),
    });
    await expect(runMigrateSeed(d)).rejects.toThrow(/Access denied/);
  });

  it("never logs the password or the DSN", async () => {
    const d = migrateDeps();
    await runMigrateSeed(d);
    const serialized = JSON.stringify(d.logs);
    const dsn = d.put.mock.calls[0][0] as string;
    const password = dsn.slice("mysql://sps_migrate:".length, dsn.indexOf("@"));
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain("mysql://");
    expect(d.logs[0]).toMatchObject({ event: "db_migrate_seed_ok", extra: { reused: false } });
  });
});

function tightenDeps(overrides: Partial<AppRwTightenDeps> = {}): AppRwTightenDeps & {
  queries: string[];
  logs: Array<{ event: string; extra?: Record<string, unknown> }>;
} {
  const queries: string[] = [];
  const logs: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  return {
    requestType: "Create",
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
    }),
    appRwGranteeHost: "10.20.%",
    log: (event, extra) => logs.push({ event, extra }),
    queries,
    logs,
    ...overrides,
  };
}

describe("runAppRwTighten (ADR-009 Phase 3)", () => {
  it("Create: revokes app_rw's scholars.* DDL, host-scoped, and logs the outcome", async () => {
    const d = tightenDeps();
    await runAppRwTighten(d);
    expect(d.queries).toEqual([
      "REVOKE IF EXISTS CREATE, DROP, ALTER, INDEX, REFERENCES, EXECUTE, TRIGGER ON `scholars`.* FROM 'app_rw'@'10.20.%'",
    ]);
    expect(d.logs[0]).toMatchObject({
      event: "db_app_rw_tighten_ok",
      extra: { granteeHost: "10.20.%" },
    });
  });

  it("Update: re-asserts the same idempotent REVOKE (prod host `%`)", async () => {
    const d = tightenDeps({ requestType: "Update", appRwGranteeHost: "%" });
    await runAppRwTighten(d);
    expect(d.queries).toEqual([
      "REVOKE IF EXISTS CREATE, DROP, ALTER, INDEX, REFERENCES, EXECUTE, TRIGGER ON `scholars`.* FROM 'app_rw'@'%'",
    ]);
  });

  it("Delete: NO-OP — never re-widens app_rw back to DDL", async () => {
    const d = tightenDeps({ requestType: "Delete" });
    await runAppRwTighten(d);
    expect(d.queries).toEqual([]);
    expect(d.logs[0]).toMatchObject({ event: "db_app_rw_tighten_skipped_on_delete" });
  });

  it("fails-closed: a SQL error propagates", async () => {
    const d = tightenDeps({
      query: vi.fn(async () => {
        throw new Error("Access denied for REVOKE");
      }),
    });
    await expect(runAppRwTighten(d)).rejects.toThrow(/Access denied/);
  });
});

function auditGrantDeps(
  overrides: Partial<AppRoAuditGrantDeps> = {},
  hostRows: Array<{ host?: unknown }> = [{ host: "10.20.%" }],
): AppRoAuditGrantDeps & {
  queries: string[];
  logs: Array<{ event: string; extra?: Record<string, unknown> }>;
} {
  const queries: string[] = [];
  const logs: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  return {
    requestType: "Create",
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
    }),
    queryRows: vi.fn(async () => hostRows),
    log: (event, extra) => logs.push({ event, extra }),
    queries,
    logs,
    ...overrides,
  };
}

describe("runAppRoAuditGrant (#917)", () => {
  it("Create: discovers app_ro's host and grants SELECT on the audit table there", async () => {
    const d = auditGrantDeps();
    await runAppRoAuditGrant(d);
    expect(d.queryRows).toHaveBeenCalledWith("SELECT host FROM mysql.user WHERE user = 'app_ro'");
    expect(d.queries).toEqual([
      "GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'10.20.%'",
    ]);
    expect(d.logs[0]).toMatchObject({
      event: "db_app_ro_audit_grant_ok",
      extra: { hosts: ["10.20.%"] },
    });
  });

  it("grants at EVERY host app_ro exists at (e.g. both `%` and a scoped host)", async () => {
    const d = auditGrantDeps({}, [{ host: "%" }, { host: "10.20.%" }]);
    await runAppRoAuditGrant(d);
    expect(d.queries).toEqual([
      "GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'%'",
      "GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'10.20.%'",
    ]);
  });

  it("skips with a warning (no grant) when app_ro does not exist yet — additive, never fails the deploy", async () => {
    const d = auditGrantDeps({}, []);
    await runAppRoAuditGrant(d);
    expect(d.queries).toEqual([]);
    expect(d.logs[0]).toMatchObject({ event: "db_app_ro_audit_grant_skipped_no_user" });
  });

  it("ignores malformed host rows (non-string / empty) defensively", async () => {
    const d = auditGrantDeps({}, [{ host: 5 }, { host: "" }, { host: "%" }]);
    await runAppRoAuditGrant(d);
    expect(d.queries).toEqual([
      "GRANT SELECT ON `scholars_audit`.`manual_edit_audit` TO 'app_ro'@'%'",
    ]);
  });

  it("Delete: NO-OP — never reads mysql.user, never grants, never revokes a persisted grant", async () => {
    const d = auditGrantDeps({ requestType: "Delete" });
    await runAppRoAuditGrant(d);
    expect(d.queryRows).not.toHaveBeenCalled();
    expect(d.queries).toEqual([]);
    expect(d.logs[0]).toMatchObject({ event: "db_app_ro_audit_grant_skipped_on_delete" });
  });

  it("fails-closed: a SQL error on the grant propagates", async () => {
    const d = auditGrantDeps({
      query: vi.fn(async () => {
        throw new Error("Access denied for GRANT");
      }),
    });
    await expect(runAppRoAuditGrant(d)).rejects.toThrow(/Access denied/);
  });

  it("tolerates ER_NO_SUCH_TABLE (1146): warn-skips so a fresh/DR deploy can't wedge", async () => {
    // app_ro exists but `manual_edit_audit` isn't created yet (sps-db-bootstrap runs in a separate
    // deploy stage) — the table-level GRANT 1146s; swallow it (self-heals next deploy).
    const d = auditGrantDeps({
      query: vi.fn(async () => {
        throw Object.assign(new Error("Table 'scholars_audit.manual_edit_audit' doesn't exist"), {
          errno: 1146,
          code: "ER_NO_SUCH_TABLE",
        });
      }),
    });
    await expect(runAppRoAuditGrant(d)).resolves.toBeUndefined();
    expect(d.logs.at(-1)).toMatchObject({ event: "db_app_ro_audit_grant_skipped_no_table" });
  });
});
