/**
 * Functional roles: the pure vocabulary helpers (`lib/edit/functional-roles.ts`)
 * and the server module (`lib/edit/functional-roles.server.ts`): scope
 * options, the import's pure desired-row computation, the audited manual
 * writes and the reconcile. `@/lib/db` and `appendAuditRow` are mocked at the
 * module boundary; the reader and writer are distinct mocks so a write path
 * that touched the reader would be caught (the report-access rule, PR #2620).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readFindMany: vi.fn(),
  readScholarFindMany: vi.fn(),
  writeFindUnique: vi.fn(),
  writeFindMany: vi.fn(),
  writeScholarFindMany: vi.fn(),
  writeReportAccessFindMany: vi.fn(),
  txFindMany: vi.fn(),
  txScholarFindMany: vi.fn(),
  txCreate: vi.fn(),
  txUpdate: vi.fn(),
  txDelete: vi.fn(),
  transaction: vi.fn(),
  appendAuditRow: vi.fn(),
  listCommsStewardCwids: vi.fn(),
  listDevelopmentAllowlistCwids: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      functionalRoleGrant: { findMany: h.readFindMany },
      scholar: { findMany: h.readScholarFindMany },
    },
    write: {
      functionalRoleGrant: { findUnique: h.writeFindUnique, findMany: h.writeFindMany },
      scholar: { findMany: h.writeScholarFindMany },
      reportAccess: { findMany: h.writeReportAccessFindMany },
      $transaction: h.transaction,
    },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/auth/comms-steward", () => ({ listCommsStewardCwids: h.listCommsStewardCwids }));
vi.mock("@/lib/auth/development", () => ({
  listDevelopmentAllowlistCwids: h.listDevelopmentAllowlistCwids,
}));

import {
  normalizeScopes,
  sameScopes,
  scopeLabel,
  scopesFromJson,
} from "@/lib/edit/functional-roles";
import {
  canManageFunctionalRoles,
  desiredImportedRows,
  functionalRoleScopeOptions,
  grantFunctionalRole,
  importFunctionalRoles,
  listFunctionalRoles,
  reportAccessScopeKey,
  reportingScopeOptions,
  revokeFunctionalRole,
  setFunctionalRoleScopes,
  validScopes,
} from "@/lib/edit/functional-roles.server";

const T0 = new Date("2026-01-10T12:00:00Z");
const T1 = new Date("2026-03-02T12:00:00Z");

/** A stored row as Prisma hands it back. */
function stored(over: Record<string, unknown> = {}) {
  return {
    role: "reporting",
    cwid: "fake001",
    source: "manual",
    scopes: ["*"],
    granteeName: "Pat Example",
    grantedBy: "adm0001",
    grantedAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const TX_LIST = [stored({ cwid: "txrow01" })];
const WRITER_LIST = [stored({ cwid: "wrrow01" })];

beforeEach(() => {
  vi.clearAllMocks();
  h.readFindMany.mockResolvedValue([]);
  h.readScholarFindMany.mockResolvedValue([]);
  h.writeFindUnique.mockResolvedValue(null);
  h.writeFindMany.mockResolvedValue(WRITER_LIST);
  h.writeScholarFindMany.mockResolvedValue([]);
  h.writeReportAccessFindMany.mockResolvedValue([]);
  h.txFindMany.mockResolvedValue(TX_LIST);
  h.txScholarFindMany.mockResolvedValue([]);
  h.txCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    stored(data),
  );
  h.txUpdate.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { role_cwid_source: Record<string, unknown> };
      data: Record<string, unknown>;
    }) => stored({ ...where.role_cwid_source, ...data }),
  );
  h.txDelete.mockResolvedValue({});
  h.appendAuditRow.mockResolvedValue(undefined);
  h.listCommsStewardCwids.mockReturnValue([]);
  h.listDevelopmentAllowlistCwids.mockReturnValue([]);
  h.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      functionalRoleGrant: {
        findMany: h.txFindMany,
        create: h.txCreate,
        update: h.txUpdate,
        delete: h.txDelete,
      },
      scholar: { findMany: h.txScholarFindMany },
    }),
  );
});

describe("scope helpers", () => {
  it("normalizeScopes dedupes, sorts, and collapses to the wildcard", () => {
    expect(normalizeScopes(["b", "a", "b", " "])).toEqual(["a", "b"]);
    expect(normalizeScopes(["article-count", "*"])).toEqual(["*"]);
  });

  it("sameScopes compares as sets", () => {
    expect(sameScopes(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameScopes(["a"], ["a", "b"])).toBe(false);
  });

  it("scopesFromJson tolerates junk", () => {
    expect(scopesFromJson(null)).toEqual([]);
    expect(scopesFromJson(["x", 3, "y"])).toEqual(["x", "y"]);
  });

  it("reporting options: All reports, each person-granted report, and its sub-scopes", () => {
    const keys = reportingScopeOptions().map((o) => o.key);
    expect(keys[0]).toBe("*");
    expect(keys).toEqual(
      expect.arrayContaining([
        "mentored-publications",
        "mentored-publications:md",
        "article-count",
        "high-impact-publications",
        "display-titles",
      ]),
    );
    const md = reportingScopeOptions().find((o) => o.key === "mentored-publications:md");
    expect(md?.label).toBe("Mentored publications · MD");
  });

  it("comms and development are institution-wide only", () => {
    const opts = functionalRoleScopeOptions();
    expect(opts.external_communications.map((o) => o.key)).toEqual(["*"]);
    expect(opts.development.map((o) => o.key)).toEqual(["*"]);
    expect(scopeLabel(opts, "development", "*")).toBe("All of WCM");
    expect(scopeLabel(opts, "reporting", "*")).toBe("All reports");
    expect(scopeLabel(opts, "reporting", "gone-report")).toBe("gone-report");
  });

  it("validScopes rejects empty, unknown, and cross-role keys", () => {
    expect(validScopes("reporting", ["article-count"])).toBe(true);
    expect(validScopes("reporting", [])).toBe(false);
    expect(validScopes("reporting", ["nope"])).toBe(false);
    expect(validScopes("development", ["article-count"])).toBe(false);
  });

  it("only a superuser manages", () => {
    expect(canManageFunctionalRoles({ isSuperuser: true })).toBe(true);
    expect(canManageFunctionalRoles({ isSuperuser: false })).toBe(false);
  });
});

describe("desiredImportedRows (pure)", () => {
  it("folds report_access rows into one Reporting row per person", () => {
    const rows = desiredImportedRows({
      reportAccess: [
        {
          reportKey: "mentored-publications",
          scopeKey: "md",
          cwid: "fake001",
          grantedBy: "adm0002",
          grantedAt: T1,
          granteeName: null,
        },
        {
          reportKey: "article-count",
          scopeKey: "*",
          cwid: "fake001",
          grantedBy: "adm0001",
          grantedAt: T0,
          granteeName: "Pat Example",
        },
      ],
      commsStewardCwids: [],
      developmentCwids: [],
    });
    expect(rows).toEqual([
      {
        role: "reporting",
        cwid: "fake001",
        source: "report_access",
        scopes: ["article-count", "mentored-publications:md"],
        granteeName: "Pat Example",
        grantedBy: "adm0001",
        grantedAt: T0,
      },
    ]);
  });

  it("a whole-report grant swallows that report's sub-scopes", () => {
    const [row] = desiredImportedRows({
      reportAccess: [
        {
          reportKey: "mentored-publications",
          scopeKey: "*",
          cwid: "fake001",
          grantedBy: "a",
          grantedAt: T0,
          granteeName: null,
        },
        {
          reportKey: "mentored-publications",
          scopeKey: "ecr",
          cwid: "fake001",
          grantedBy: "a",
          grantedAt: T1,
          granteeName: null,
        },
      ],
      commsStewardCwids: [],
      developmentCwids: [],
    });
    expect(row!.scopes).toEqual(["mentored-publications"]);
    expect(reportAccessScopeKey("x", "*")).toBe("x");
    expect(reportAccessScopeKey("x", "md")).toBe("x:md");
  });

  it("allowlists become institution-wide rows, lowercased and de-duplicated", () => {
    const rows = desiredImportedRows({
      reportAccess: [],
      commsStewardCwids: ["FAKE002", "fake002"],
      developmentCwids: ["fake003"],
    });
    expect(rows.map((r) => [r.role, r.cwid, r.source, r.scopes, r.grantedBy])).toEqual([
      ["external_communications", "fake002", "allowlist", ["*"], "ALLOWLIST"],
      ["development", "fake003", "allowlist", ["*"], "ALLOWLIST"],
    ]);
  });
});

describe("listFunctionalRoles", () => {
  it("resolves holder + granter names from Scholar, falls back to granteeName then cwid, skips unknown roles", async () => {
    h.readFindMany.mockResolvedValue([
      stored({ cwid: "fake001", granteeName: null, grantedBy: "adm0001" }),
      stored({ cwid: "fake002", granteeName: "Sam Sample", role: "development" }),
      stored({ cwid: "fake003", granteeName: null, role: "future_role" }),
    ]);
    h.readScholarFindMany.mockResolvedValue([
      { cwid: "fake001", preferredName: "Alex Example", primaryTitle: "Analyst" },
      { cwid: "adm0001", preferredName: "Admin Person", primaryTitle: null },
    ]);
    const rows = await listFunctionalRoles();
    expect(rows.map((r) => [r.cwid, r.name, r.title, r.grantedByName])).toEqual([
      ["fake001", "Alex Example", "Analyst", "Admin Person"],
      ["fake002", "Sam Sample", null, "Admin Person"],
    ]);
    expect(rows[0]!.grantedAt).toBe(T0.toISOString());
  });
});

const ACTOR = { actorCwid: "adm0001", impersonatedCwid: null, requestId: "req-1" };

describe("grantFunctionalRole", () => {
  it("creates a manual row with normalized scopes and a functional_role_grant audit row, returns the tx list", async () => {
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["article-count", "*"],
      granteeName: "Pat Example",
    });
    expect(h.writeFindUnique).toHaveBeenCalledWith({
      where: { role_cwid_source: { role: "reporting", cwid: "fake001", source: "manual" } },
      select: { cwid: true },
    });
    expect(h.txCreate).toHaveBeenCalledWith({
      data: {
        role: "reporting",
        cwid: "fake001",
        source: "manual",
        scopes: ["*"],
        granteeName: "Pat Example",
        grantedBy: "adm0001",
      },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "functional_role_grant",
        targetEntityType: "functional_role",
        targetEntityId: "reporting:fake001:manual",
        beforeValues: null,
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.rows.map((r) => r.cwid)).toEqual(["txrow01"]);
    expect(h.readFindMany).not.toHaveBeenCalled();
  });

  it("is idempotent: an existing manual row is not re-created or re-audited", async () => {
    h.writeFindUnique.mockResolvedValue({ cwid: "fake001" });
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    expect(result.changed).toBe(false);
    expect(result.rows.map((r) => r.cwid)).toEqual(["wrrow01"]);
    expect(h.txCreate).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("a P2002 race is the idempotent path, not a throw", async () => {
    h.transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    expect(result.changed).toBe(false);
  });
});

describe("setFunctionalRoleScopes", () => {
  it("found:false when there is no MANUAL row (imported rows are never addressed)", async () => {
    const result = await setFunctionalRoleScopes({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    expect(result.found).toBe(false);
    expect(h.txUpdate).not.toHaveBeenCalled();
  });

  it("same scopes → no write, no audit", async () => {
    h.writeFindUnique.mockResolvedValue(stored({ scopes: ["article-count"] }));
    const result = await setFunctionalRoleScopes({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["article-count"],
    });
    expect(result).toMatchObject({ found: true, changed: false });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("changed scopes → update + functional_role_scope_set with before/after", async () => {
    h.writeFindUnique.mockResolvedValue(stored({ scopes: ["*"] }));
    const result = await setFunctionalRoleScopes({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["mentored-publications:md", "article-count"],
    });
    expect(result).toMatchObject({ found: true, changed: true });
    expect(h.txUpdate).toHaveBeenCalledWith({
      where: { role_cwid_source: { role: "reporting", cwid: "fake001", source: "manual" } },
      data: { scopes: ["article-count", "mentored-publications:md"] },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "functional_role_scope_set",
        fieldsChanged: ["scopes"],
        beforeValues: { scopes: ["*"] },
        afterValues: { scopes: ["article-count", "mentored-publications:md"] },
      }),
    );
  });
});

describe("revokeFunctionalRole", () => {
  it("no manual row → idempotent no-op", async () => {
    const result = await revokeFunctionalRole({ ...ACTOR, role: "development", cwid: "fake001" });
    expect(result.changed).toBe(false);
    expect(h.txDelete).not.toHaveBeenCalled();
  });

  it("deletes the manual row with a functional_role_revoke audit row carrying the deleted row", async () => {
    h.writeFindUnique.mockResolvedValue(stored({ role: "development" }));
    const result = await revokeFunctionalRole({ ...ACTOR, role: "development", cwid: "fake001" });
    expect(result.changed).toBe(true);
    expect(h.txDelete).toHaveBeenCalledWith({
      where: { role_cwid_source: { role: "development", cwid: "fake001", source: "manual" } },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "functional_role_revoke",
        targetEntityId: "development:fake001:manual",
        beforeValues: expect.objectContaining({
          role: "development",
          source: "manual",
          scopes: ["*"],
        }),
        afterValues: null,
      }),
    );
  });
});

describe("importFunctionalRoles (reconcile)", () => {
  it("adds missing, re-scopes changed, removes stale imported rows, never reads or writes manual rows", async () => {
    h.writeReportAccessFindMany.mockResolvedValue([
      {
        reportKey: "article-count",
        scopeKey: "*",
        cwid: "fake001",
        grantedBy: "adm0002",
        grantedAt: T0,
        granteeName: "Pat Example",
      },
      {
        reportKey: "display-titles",
        scopeKey: "*",
        cwid: "fake004",
        grantedBy: "adm0002",
        grantedAt: T1,
        granteeName: null,
      },
    ]);
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake005"]);
    // Current imported rows: fake004 with stale scopes, fake009 no longer in any source.
    h.txFindMany
      .mockResolvedValueOnce([
        stored({ cwid: "fake004", source: "report_access", scopes: ["article-count"] }),
        stored({ cwid: "fake009", source: "report_access", scopes: ["*"] }),
      ])
      .mockResolvedValueOnce(TX_LIST);

    const result = await importFunctionalRoles(ACTOR);

    expect(h.txFindMany.mock.calls[0]![0]).toEqual({ where: { source: { not: "manual" } } });
    expect(result).toMatchObject({ added: 2, updated: 1, removed: 1 });
    expect(
      h.txCreate.mock.calls.map((c) => [c[0].data.role, c[0].data.cwid, c[0].data.source]),
    ).toEqual([
      ["reporting", "fake001", "report_access"],
      ["development", "fake005", "allowlist"],
    ]);
    // report_access provenance is kept; allowlist rows take the DB default time.
    expect(h.txCreate.mock.calls[0]![0].data).toMatchObject({
      grantedBy: "adm0002",
      grantedAt: T0,
    });
    expect(h.txCreate.mock.calls[1]![0].data.grantedAt).toBeUndefined();
    expect(h.txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role_cwid_source: { role: "reporting", cwid: "fake004", source: "report_access" },
        },
        data: expect.objectContaining({ scopes: ["display-titles"] }),
      }),
    );
    expect(h.txDelete).toHaveBeenCalledWith({
      where: { role_cwid_source: { role: "reporting", cwid: "fake009", source: "report_access" } },
    });
    const actions = h.appendAuditRow.mock.calls.map((c) => c[1].action);
    expect(actions.sort()).toEqual([
      "functional_role_grant",
      "functional_role_grant",
      "functional_role_revoke",
      "functional_role_scope_set",
    ]);
    for (const call of h.appendAuditRow.mock.calls) {
      const values = call[1].afterValues ?? call[1].beforeValues;
      expect(values).toMatchObject({ via: "import" });
      expect(call[1].actorCwid).toBe("adm0001");
    }
    expect(result.rows.map((r) => r.cwid)).toEqual(["txrow01"]);
  });

  it("a second run with unchanged sources changes nothing", async () => {
    h.writeReportAccessFindMany.mockResolvedValue([
      {
        reportKey: "article-count",
        scopeKey: "*",
        cwid: "fake001",
        grantedBy: "adm0002",
        grantedAt: T0,
        granteeName: null,
      },
    ]);
    h.txFindMany
      .mockResolvedValueOnce([
        stored({ cwid: "fake001", source: "report_access", scopes: ["article-count"] }),
      ])
      .mockResolvedValueOnce(TX_LIST);
    const result = await importFunctionalRoles(ACTOR);
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});
