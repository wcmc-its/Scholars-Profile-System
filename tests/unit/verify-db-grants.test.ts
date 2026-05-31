import { describe, expect, it, vi } from "vitest";

import {
  ROLES,
  assertGrantsEqual,
  canonicalizeGrant,
  diffGrants,
  requiredRoles,
  splitPrivileges,
  toGrantSet,
  verifyRole,
  type RoleName,
} from "@/scripts/verify-db-grants";
import { type SqlConn } from "@/scripts/db-bootstrap";

describe("splitPrivileges", () => {
  it("splits on top-level commas and trims", () => {
    expect(splitPrivileges("SELECT, INSERT,  UPDATE")).toEqual(["SELECT", "INSERT", "UPDATE"]);
  });

  it("does not tear apart a column-scoped privilege at its inner comma", () => {
    expect(splitPrivileges("SELECT (col_a, col_b), INSERT")).toEqual([
      "SELECT (col_a, col_b)",
      "INSERT",
    ]);
  });
});

describe("canonicalizeGrant", () => {
  it("uppercases, de-dupes and sorts the privilege set", () => {
    expect(canonicalizeGrant("GRANT insert, select, Insert ON `scholars`.* TO x")).toBe(
      "scholars.* INSERT,SELECT",
    );
  });

  it("strips identifier backticks from the object", () => {
    expect(canonicalizeGrant("GRANT SELECT ON `scholars`.* TO x")).toBe("scholars.* SELECT");
    expect(canonicalizeGrant("GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO x")).toBe(
      "scholars_audit.manual_edit_audit INSERT",
    );
  });

  it("is independent of the grantee and host pattern", () => {
    const a = canonicalizeGrant("GRANT SELECT ON `scholars`.* TO `app_ro`@`%`");
    const b = canonicalizeGrant("GRANT SELECT ON `scholars`.* TO `app_ro`@`10.20.%`");
    expect(a).toBe(b);
  });

  it("preserves WITH GRANT OPTION as a comparable suffix", () => {
    expect(canonicalizeGrant("GRANT INSERT ON `scholars_audit`.* TO x WITH GRANT OPTION")).toBe(
      "scholars_audit.* INSERT WITH GRANT OPTION",
    );
  });

  it("drops a pure USAGE grant (the no-privilege placeholder)", () => {
    expect(canonicalizeGrant("GRANT USAGE ON *.* TO `app_rw`@`%`")).toBeNull();
    // ...even when MariaDB appends an IDENTIFIED BY PASSWORD tail.
    expect(
      canonicalizeGrant("GRANT USAGE ON *.* TO `app_rw`@`%` IDENTIFIED BY PASSWORD '*ABC'"),
    ).toBeNull();
  });

  it("does NOT drop a real privilege that happens to sit on *.*", () => {
    // `SELECT ON *.*` is corpus-wide read -- excess, must survive normalization.
    expect(canonicalizeGrant("GRANT SELECT ON *.* TO x")).toBe("*.* SELECT");
  });

  it("throws on a grant-shaped line it cannot parse (fail closed, never ignore)", () => {
    expect(() => canonicalizeGrant("GRANT nonsense-with-no-on-or-to")).toThrow(
      /unparseable grant line/,
    );
  });
});

describe("diffGrants / assertGrantsEqual", () => {
  const appRwGolden = ROLES["app-rw"].golden;

  it("treats a reordered, differently-hosted, USAGE-noisy live set as equal", () => {
    const live = [
      "GRANT USAGE ON *.* TO `app_rw`@`10.20.%`",
      // privileges reordered vs the golden list, different host pattern
      "GRANT INSERT, SELECT, DELETE, UPDATE ON `scholars`.* TO `app_rw`@`10.20.%`",
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `app_rw`@`10.20.%`",
    ];
    expect(diffGrants(appRwGolden, live)).toEqual({ excess: [], missing: [] });
    expect(() => assertGrantsEqual("app-rw", appRwGolden, live)).not.toThrow();
  });

  it("catches the staging drift: ALL PRIVILEGES is excess + the explicit set is missing", () => {
    const drifted = [
      "GRANT USAGE ON *.* TO `app_rw`@`%`",
      "GRANT ALL PRIVILEGES ON `scholars`.* TO `app_rw`@`%`",
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `app_rw`@`%`",
    ];
    const { excess, missing } = diffGrants(appRwGolden, drifted);
    expect(excess).toContain("scholars.* ALL PRIVILEGES");
    expect(missing).toContain("scholars.* DELETE,INSERT,SELECT,UPDATE");
    expect(() => assertGrantsEqual("app-rw", appRwGolden, drifted)).toThrow(
      /grant drift for role 'app-rw'.*EXCESS.*MISSING/s,
    );
  });

  it("ADR-009 Phase 3: a lingering `scholars`.* DDL grant on app_rw is caught as excess", () => {
    // Post-Phase-3 app_rw is DML-only. If any DDL lingers (a re-widened or
    // not-yet-tightened env), the wide token != the tight golden token: the wide
    // grant is excess and the golden is missing — the verify fails the deploy.
    const live = [
      "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON `scholars`.* TO `app_rw`@`%`",
      "GRANT INSERT ON `scholars_audit`.`manual_edit_audit` TO `app_rw`@`%`",
    ];
    const { excess, missing } = diffGrants(appRwGolden, live);
    expect(excess).toEqual(["scholars.* CREATE,DELETE,INSERT,SELECT,UPDATE"]);
    expect(missing).toEqual(["scholars.* DELETE,INSERT,SELECT,UPDATE"]);
    expect(() => assertGrantsEqual("app-rw", appRwGolden, live)).toThrow(/EXCESS.*MISSING/s);
  });

  it("catches a missing grant (the audit INSERT dropped)", () => {
    const live = [
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `scholars`.* TO `app_rw`@`%`",
    ];
    const { excess, missing } = diffGrants(appRwGolden, live);
    expect(excess).toEqual([]);
    expect(missing).toEqual(["scholars_audit.manual_edit_audit INSERT"]);
    expect(() => assertGrantsEqual("app-rw", appRwGolden, live)).toThrow(/MISSING/);
  });

  it("catches an excess privilege (an extra DELETE on the audit table)", () => {
    const live = [
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `scholars`.* TO `app_rw`@`%`",
      "GRANT INSERT, DELETE ON `scholars_audit`.`manual_edit_audit` TO `app_rw`@`%`",
    ];
    const { excess, missing } = diffGrants(appRwGolden, live);
    expect(excess).toEqual(["scholars_audit.manual_edit_audit DELETE,INSERT"]);
    expect(missing).toEqual(["scholars_audit.manual_edit_audit INSERT"]);
    expect(() => assertGrantsEqual("app-rw", appRwGolden, live)).toThrow(/EXCESS/);
  });

  it("does not confuse `scholars` with the `scholars_audit` prefix", () => {
    // app-ro golden is SELECT on `scholars`.*; a SELECT on `scholars_audit`.*
    // must register as excess, not silently match the `scholars` golden token.
    const live = [
      "GRANT SELECT ON `scholars`.* TO `app_ro`@`%`",
      "GRANT SELECT ON `scholars_audit`.* TO `app_ro`@`%`",
    ];
    expect(diffGrants(ROLES["app-ro"].golden, live)).toEqual({
      excess: ["scholars_audit.* SELECT"],
      missing: [],
    });
  });

  it("treats WITH GRANT OPTION as load-bearing for sps_bootstrap", () => {
    // The golden carries WITH GRANT OPTION on its single db-scope line; a live
    // grant that lost the option must register as drift in both directions.
    const live = [
      "GRANT CREATE, ALTER, INSERT ON `scholars_audit`.* TO `sps_bootstrap`@`%`",
    ];
    const { excess, missing } = diffGrants(ROLES.sps_bootstrap.golden, live);
    expect(excess).toEqual(["scholars_audit.* ALTER,CREATE,INSERT"]);
    expect(missing).toEqual(["scholars_audit.* ALTER,CREATE,INSERT WITH GRANT OPTION"]);
  });
});

describe("golden lists are internally consistent", () => {
  it("every role's golden list verifies against itself (canonicalizes cleanly)", () => {
    for (const role of Object.keys(ROLES) as RoleName[]) {
      const golden = ROLES[role].golden;
      expect(() => assertGrantsEqual(role, golden, golden)).not.toThrow();
      // and produces at least one comparable token (no all-USAGE golden list).
      expect(toGrantSet(golden).size).toBeGreaterThan(0);
    }
  });

  it("ADR-009 Phase 3: app_rw's `scholars.*` set is the DML subset of sps_migrate's DDL set", () => {
    // Pre-Phase-3 they were identical (sps_migrate inherited app_rw's set
    // verbatim). Phase 3 split them: app_rw is DML-only; the DDL moved to (and
    // stays only on) sps_migrate. The privileges app_rw shed must equal exactly
    // what the seeder revokes (db-bootstrap-seed appRwTightenStatements, req 6).
    const scholarsPrivs = (role: RoleName) => {
      const token = [...toGrantSet(ROLES[role].golden)].find((t) =>
        t.startsWith("scholars.* "),
      );
      return new Set((token ?? "").slice("scholars.* ".length).split(","));
    };
    const appRw = scholarsPrivs("app-rw");
    const migrate = scholarsPrivs("sps_migrate");
    expect([...appRw].sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect([...appRw].every((p) => migrate.has(p))).toBe(true);
    expect(migrate.size).toBeGreaterThan(appRw.size);
    const shed = [...migrate].filter((p) => !appRw.has(p)).sort();
    expect(shed).toEqual([
      "ALTER",
      "CREATE",
      "DROP",
      "EXECUTE",
      "INDEX",
      "REFERENCES",
      "TRIGGER",
    ]);
  });
});

describe("verifyRole (grantee-side SHOW GRANTS FOR CURRENT_USER)", () => {
  function fakeConn(grantLines: string[]): SqlConn & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        return grantLines.map((g) => ({ "Grants for x@%": g }));
      }),
      end: vi.fn(async () => {}),
    };
  }

  it("reads CURRENT_USER grants and passes on an exact match", async () => {
    const conn = fakeConn([
      "GRANT USAGE ON *.* TO `app_ro`@`%`",
      "GRANT SELECT ON `scholars`.* TO `app_ro`@`%`",
    ]);
    await expect(verifyRole(conn, "app-ro")).resolves.toBeUndefined();
    expect(conn.calls).toEqual(["SHOW GRANTS FOR CURRENT_USER()"]);
  });

  it("fails closed when the live grants drift from the golden list", async () => {
    const conn = fakeConn([
      "GRANT USAGE ON *.* TO `app_ro`@`%`",
      "GRANT SELECT, INSERT ON `scholars`.* TO `app_ro`@`%`",
    ]);
    await expect(verifyRole(conn, "app-ro")).rejects.toThrow(/grant drift for role 'app-ro'/);
  });
});

describe("requiredRoles", () => {
  it("defaults to the three Phase 0 roles (sps_migrate not yet provisioned)", () => {
    expect(requiredRoles({})).toEqual(["app-ro", "app-rw", "sps_bootstrap"]);
  });

  it("honors a VERIFY_ROLES override (Phase 1 adds sps_migrate)", () => {
    expect(requiredRoles({ VERIFY_ROLES: "app-ro, app-rw, sps_migrate, sps_bootstrap" })).toEqual([
      "app-ro",
      "app-rw",
      "sps_migrate",
      "sps_bootstrap",
    ]);
  });

  it("rejects an unknown role name", () => {
    expect(() => requiredRoles({ VERIFY_ROLES: "app-ro,master" })).toThrow(/unknown role/);
  });
});
