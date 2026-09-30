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
  txCreateMany: vi.fn(),
  txDeleteMany: vi.fn(),
  transaction: vi.fn(),
  appendAuditRow: vi.fn(),
  listCommsStewardCwids: vi.fn(),
  listDevelopmentAllowlistCwids: vi.fn(),
  fetchDirectory: vi.fn(),
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
vi.mock("@/lib/sources/ldap", () => ({ fetchDirectoryPeopleByCwid: h.fetchDirectory }));
vi.mock("@/lib/auth/comms-steward", () => ({ listCommsStewardCwids: h.listCommsStewardCwids }));
vi.mock("@/lib/auth/development", () => ({
  listDevelopmentAllowlistCwids: h.listDevelopmentAllowlistCwids,
}));

import {
  defaultScopes,
  FUNCTIONAL_ROLES,
  isFunctionalRole,
  normalizeScopes,
  parityGaps,
  reportScopesFromRegistry,
  sameScopes,
  scopeLabel,
  scopesFromJson,
  type GateHolder,
} from "@/lib/edit/functional-roles";
import {
  canManageFunctionalRoles,
  desiredImportedRows,
  functionalRoleScopeOptions,
  grantFunctionalRole,
  IMPORT_CHUNK_SIZE,
  IMPORT_TX_OPTIONS,
  importFunctionalRoles,
  listFunctionalRoles,
  listGateHolders,
  reportAccessScopeKey,
  reportingScopeOptions,
  revokeFunctionalRole,
  setFunctionalRoleScopes,
  validScopes,
  withDirectoryGranteeNames,
  withDirectoryNames,
} from "@/lib/edit/functional-roles.server";
import { resetDirectoryNameCache } from "@/lib/edit/directory-names";

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

/** A directory person as `fetchDirectoryPeopleByCwid` projects one. */
function edPerson(cwid: string, firstName: string, lastName: string) {
  return {
    cwid,
    name: `${lastName}, ${firstName}`,
    title: null,
    dept: null,
    firstName,
    lastName,
    email: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectoryNameCache();
  // ED knows nobody unless a test says otherwise.
  h.fetchDirectory.mockResolvedValue([]);
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
        createMany: h.txCreateMany,
        deleteMany: h.txDeleteMany,
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
      ]),
    );
    // Report 10 (Display titles) is the Titles queue now: not a Reporting scope.
    expect(keys.some((k) => k === "display-titles" || k.startsWith("display-titles:"))).toBe(false);
    const md = reportingScopeOptions().find((o) => o.key === "mentored-publications:md");
    expect(md?.label).toBe("Mentored publications · MD");
  });

  it("the roles are External Affairs and Reporting; EA's scopes are its two functions", () => {
    expect(FUNCTIONAL_ROLES).toEqual(["external_affairs", "reporting"]);
    expect(isFunctionalRole("external_communications")).toBe(false);
    expect(isFunctionalRole("development")).toBe(false);
    const opts = functionalRoleScopeOptions();
    expect(opts.external_affairs).toEqual([
      { key: "communications", label: "Communications" },
      { key: "development", label: "Development" },
    ]);
    expect(scopeLabel(opts, "external_affairs", "development")).toBe("Development");
    expect(scopeLabel(opts, "reporting", "*")).toBe("All reports");
    expect(scopeLabel(opts, "reporting", "gone-report")).toBe("gone-report");
    // The Assign dialog starts Reporting at "All reports" and EA at nothing.
    expect(defaultScopes(opts.reporting)).toEqual(["*"]);
    expect(defaultScopes(opts.external_affairs)).toEqual([]);
  });

  it("validScopes rejects empty, unknown, and cross-role keys", () => {
    expect(validScopes("reporting", ["article-count"])).toBe(true);
    expect(validScopes("reporting", [])).toBe(false);
    expect(validScopes("reporting", ["nope"])).toBe(false);
    expect(validScopes("external_affairs", ["article-count"])).toBe(false);
    expect(validScopes("external_affairs", ["communications", "development"])).toBe(true);
    expect(validScopes("external_affairs", ["development"])).toBe(true);
    // No wildcard for EA: each function is chosen explicitly.
    expect(validScopes("external_affairs", ["*"])).toBe(false);
    expect(validScopes("reporting", ["communications"])).toBe(false);
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

  it("allowlists become ONE External Affairs row per person, the lists as its functions", () => {
    const rows = desiredImportedRows({
      reportAccess: [],
      commsStewardCwids: ["FAKE002", "fake002", "fake004"],
      developmentCwids: ["fake003", " FAKE004 "],
    });
    expect(rows.map((r) => [r.role, r.cwid, r.source, r.scopes, r.grantedBy])).toEqual([
      ["external_affairs", "fake002", "allowlist", ["communications"], "ALLOWLIST"],
      // On both lists: one grant carrying both functions, not two rows.
      ["external_affairs", "fake004", "allowlist", ["communications", "development"], "ALLOWLIST"],
      ["external_affairs", "fake003", "allowlist", ["development"], "ALLOWLIST"],
    ]);
    // Every imported EA row passes the route's own scope validation.
    for (const r of rows) expect(validScopes(r.role, r.scopes)).toBe(true);
  });
});

describe("listFunctionalRoles", () => {
  it("resolves holder + granter names from Scholar, falls back to granteeName then cwid, skips unknown roles", async () => {
    h.readFindMany.mockResolvedValue([
      stored({ cwid: "fake001", granteeName: null, grantedBy: "adm0001" }),
      stored({ cwid: "fake002", granteeName: "Sam Sample", role: "external_affairs" }),
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
      select: { scopes: true },
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
    expect(result.conflict).toBe(false);
    expect(result.rows.map((r) => r.cwid)).toEqual(["txrow01"]);
    expect(h.readFindMany).not.toHaveBeenCalled();
  });

  it("is idempotent: an existing manual row with the same scopes is not re-created or re-audited", async () => {
    h.writeFindUnique.mockResolvedValue({ scopes: ["*"] });
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    expect(result.changed).toBe(false);
    expect(result.conflict).toBe(false);
    expect(result.rows.map((r) => r.cwid)).toEqual(["wrrow01"]);
    expect(h.txCreate).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("an existing manual row with DIFFERENT scopes is a conflict, not a silent no-op", async () => {
    h.writeFindUnique.mockResolvedValue({ scopes: ["article-count"] });
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["high-impact-publications"],
    });
    expect(result).toMatchObject({ changed: false, conflict: true });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("a P2002 race is the idempotent path, not a throw", async () => {
    h.transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    h.writeFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ scopes: ["*"] });
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    expect(result).toMatchObject({ changed: false, conflict: false });
  });

  it("a P2002 race won by a grant with other scopes is a conflict", async () => {
    h.transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    h.writeFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ scopes: ["article-count"] });
    const result = await grantFunctionalRole({
      ...ACTOR,
      role: "reporting",
      cwid: "fake001",
      scopes: ["*"],
    });
    expect(result).toMatchObject({ changed: false, conflict: true });
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
    const result = await revokeFunctionalRole({
      ...ACTOR,
      role: "external_affairs",
      cwid: "fake001",
    });
    expect(result.changed).toBe(false);
    expect(h.txDelete).not.toHaveBeenCalled();
  });

  it("deletes the manual row with a functional_role_revoke audit row carrying the deleted row", async () => {
    h.writeFindUnique.mockResolvedValue(
      stored({ role: "external_affairs", scopes: ["communications", "development"] }),
    );
    const result = await revokeFunctionalRole({
      ...ACTOR,
      role: "external_affairs",
      cwid: "fake001",
    });
    expect(result.changed).toBe(true);
    expect(h.txDelete).toHaveBeenCalledWith({
      where: { role_cwid_source: { role: "external_affairs", cwid: "fake001", source: "manual" } },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "functional_role_revoke",
        targetEntityId: "external_affairs:fake001:manual",
        beforeValues: expect.objectContaining({
          role: "external_affairs",
          source: "manual",
          scopes: ["communications", "development"],
        }),
        afterValues: null,
      }),
    );
  });
});

describe("importFunctionalRoles (reconcile)", () => {
  type Key = { role: string; cwid: string; source: string };
  const k = (r: Key) => `${r.role}:${r.cwid}:${r.source}`;

  /**
   * A tiny in-memory `functional_role_grant` behind the writer and the
   * transaction mocks, so the chunked reconcile runs against real state.
   * Returns the table (keyed like the PK) so a test can inspect the result.
   */
  function table(rows: ReturnType<typeof stored>[]) {
    const t = new Map(rows.map((r) => [k(r), { ...r }]));
    const matches = (where: { OR?: Key[]; source?: { not: string } }) => (r: Key) =>
      where.OR ? where.OR.some((w) => k(w) === k(r)) : r.source !== where.source?.not;
    h.writeFindMany.mockImplementation(
      async (q: { where?: { source: { not: string } }; select?: unknown }) =>
        q.where ? [...t.values()].filter(matches(q.where)) : [...t.values()],
    );
    h.txFindMany.mockImplementation(async (q: { where: { OR: Key[] } }) =>
      [...t.values()].filter(matches(q.where)),
    );
    h.txCreateMany.mockImplementation(async ({ data }: { data: ReturnType<typeof stored>[] }) => {
      for (const d of data) t.set(k(d), { ...stored(), ...d });
      return { count: data.length };
    });
    h.txUpdate.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { role_cwid_source: Key };
        data: Record<string, unknown>;
      }) => {
        const id = k(where.role_cwid_source);
        const next = { ...t.get(id)!, ...data };
        t.set(id, next);
        return next;
      },
    );
    h.txDeleteMany.mockImplementation(async ({ where }: { where: { OR: Key[] } }) => {
      let count = 0;
      for (const w of where.OR) if (t.delete(k(w))) count++;
      return { count };
    });
    return t;
  }

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
        reportKey: "high-impact-publications",
        scopeKey: "*",
        cwid: "fake004",
        grantedBy: "adm0002",
        grantedAt: T1,
        granteeName: null,
      },
      // A leftover grant on retired report 10: skipped, so fake010 gets no row.
      {
        reportKey: "display-titles",
        scopeKey: "*",
        cwid: "fake010",
        grantedBy: "adm0002",
        grantedAt: T1,
        granteeName: null,
      },
    ]);
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake005"]);
    // fake004 has stale scopes, fake009 is in no source; the manual row must survive.
    const manual = stored({ cwid: "fake004", source: "manual", scopes: ["article-count"] });
    const t = table([
      stored({
        cwid: "fake004",
        source: "report_access",
        scopes: ["article-count"],
        grantedBy: "adm0002",
        grantedAt: T1,
      }),
      stored({ cwid: "fake009", source: "report_access", scopes: ["*"] }),
      manual,
    ]);

    const result = await importFunctionalRoles(ACTOR);

    expect(result).toMatchObject({ added: 2, updated: 1, removed: 1 });
    // The key read excludes manual rows; no chunk ever addresses one.
    expect(h.writeFindMany.mock.calls[0]![0]).toMatchObject({
      where: { source: { not: "manual" } },
    });
    for (const call of h.txFindMany.mock.calls) {
      expect(call[0].where.OR.every((w: Key) => w.source !== "manual")).toBe(true);
    }
    expect(t.get("reporting:fake004:manual")).toEqual(manual);
    expect([...t.keys()].sort()).toEqual([
      "external_affairs:fake005:allowlist",
      "reporting:fake001:report_access",
      "reporting:fake004:manual",
      "reporting:fake004:report_access",
    ]);
    // report_access provenance is kept; an allowlist row gets the run's time.
    expect(t.get("reporting:fake001:report_access")).toMatchObject({
      grantedBy: "adm0002",
      grantedAt: T0,
    });
    expect(t.get("external_affairs:fake005:allowlist")!.grantedAt).toBeInstanceOf(Date);
    expect(t.get("reporting:fake004:report_access")!.scopes).toEqual(["high-impact-publications"]);
    // Writes are bulk: one createMany and one deleteMany, all under explicit tx options.
    expect(h.txCreateMany).toHaveBeenCalledTimes(1);
    expect(h.txDeleteMany).toHaveBeenCalledTimes(1);
    expect(h.txCreate).not.toHaveBeenCalled();
    expect(h.txDelete).not.toHaveBeenCalled();
    for (const call of h.transaction.mock.calls) {
      expect(call[1]).toEqual(IMPORT_TX_OPTIONS);
    }
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
    // The allowlist grant's audit snapshot carries the same time the row got.
    const devAudit = h.appendAuditRow.mock.calls.find(
      (c) => c[1].targetEntityId === "external_affairs:fake005:allowlist",
    )!;
    expect(devAudit[1].afterValues.granted_at).toBe(
      t.get("external_affairs:fake005:allowlist")!.grantedAt.toISOString(),
    );
    // The list comes back from the writer, never the reader.
    expect(result.rows.map((r) => r.cwid).sort()).toEqual([
      "fake001",
      "fake004",
      "fake004",
      "fake005",
    ]);
    expect(h.readFindMany).not.toHaveBeenCalled();
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
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake005"]);
    table([]);
    const first = await importFunctionalRoles(ACTOR);
    expect(first).toMatchObject({ added: 2, updated: 0, removed: 0 });
    h.appendAuditRow.mockClear();
    const second = await importFunctionalRoles(ACTOR);
    expect(second).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("refreshes provenance when the earliest report_access grant is revoked with scopes unchanged", async () => {
    // Stored row came from adm0002's T0 grant; that grant is gone and the
    // remaining one (same report, so same scopes) is adm0003's at T1.
    h.writeReportAccessFindMany.mockResolvedValue([
      {
        reportKey: "article-count",
        scopeKey: "*",
        cwid: "fake001",
        grantedBy: "adm0003",
        grantedAt: T1,
        granteeName: null,
      },
    ]);
    const t = table([
      stored({
        cwid: "fake001",
        source: "report_access",
        scopes: ["article-count"],
        grantedBy: "adm0002",
        grantedAt: T0,
      }),
    ]);

    const result = await importFunctionalRoles(ACTOR);

    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(t.get("reporting:fake001:report_access")).toMatchObject({
      scopes: ["article-count"],
      grantedBy: "adm0003",
      grantedAt: T1,
      // A nameless source never clears a stored name.
      granteeName: "Pat Example",
    });
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
    expect(h.appendAuditRow.mock.calls[0]![1]).toMatchObject({
      action: "functional_role_update",
      targetEntityId: "reporting:fake001:report_access",
      fieldsChanged: ["granted_by", "granted_at"],
      beforeValues: { granted_by: "adm0002", granted_at: T0.toISOString(), via: "import" },
      afterValues: { granted_by: "adm0003", granted_at: T1.toISOString(), via: "import" },
    });
  });

  it("splits a large import into chunked transactions, each with its own audit rows", async () => {
    const n = IMPORT_CHUNK_SIZE * 2 + 5;
    h.writeReportAccessFindMany.mockResolvedValue(
      Array.from({ length: n }, (_, i) => ({
        reportKey: "article-count",
        scopeKey: "*",
        cwid: `fake${String(i).padStart(4, "0")}`,
        grantedBy: "adm0002",
        grantedAt: T0,
        granteeName: null,
      })),
    );
    const t = table([]);
    const result = await importFunctionalRoles(ACTOR);
    expect(result).toMatchObject({ added: n, updated: 0, removed: 0 });
    expect(t.size).toBe(n);
    expect(h.transaction).toHaveBeenCalledTimes(3);
    expect(h.txCreateMany.mock.calls.map((c) => c[0].data.length)).toEqual([
      IMPORT_CHUNK_SIZE,
      IMPORT_CHUNK_SIZE,
      5,
    ]);
    expect(h.appendAuditRow).toHaveBeenCalledTimes(n);
  });

  it("a bulk write that affects fewer rows than planned fails the chunk (no unaudited drift)", async () => {
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake005"]);
    table([]);
    h.txCreateMany.mockResolvedValueOnce({ count: 0 });
    await expect(importFunctionalRoles(ACTOR)).rejects.toThrow(/created 0 rows, expected 1/);
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});

describe("reportScopesFromRegistry (the gate mapping)", () => {
  it("wildcard or the bare report key admits the whole report", () => {
    expect([...reportScopesFromRegistry(["*"], "article-count")]).toEqual(["*"]);
    expect([...reportScopesFromRegistry(["article-count"], "article-count")]).toEqual(["*"]);
  });

  it("a sub-scope admits only that bucket, and only on its own report", () => {
    const scopes = ["mentored-publications:md", "mentored-publications:ecr", "article-count"];
    expect([...reportScopesFromRegistry(scopes, "mentored-publications")].sort()).toEqual([
      "ecr",
      "md",
    ]);
    expect([...reportScopesFromRegistry(scopes, "high-impact-publications")]).toEqual([]);
  });

  it("a report key that prefixes another does not leak", () => {
    expect([...reportScopesFromRegistry(["article-count-x"], "article-count")]).toEqual([]);
  });
});

describe("parityGaps", () => {
  const holders: GateHolder[] = [
    {
      role: "reporting",
      cwid: "fake001",
      name: null,
      reportKey: "mentored-publications",
      scope: "md",
      via: "report_access",
    },
    {
      role: "reporting",
      cwid: "fake002",
      name: null,
      reportKey: "article-count",
      scope: "*",
      via: "report_access",
    },
    {
      role: "external_affairs",
      cwid: "fake003",
      name: null,
      scope: "communications",
      via: "comms_steward_allowlist",
    },
    {
      role: "external_affairs",
      cwid: "fake003",
      name: null,
      scope: "development",
      via: "development_allowlist",
    },
  ];

  it("an empty registry leaves every enumerable holder as a gap", () => {
    expect(parityGaps(holders, [])).toEqual(holders);
  });

  it("covered by any source's row that carries the function or admits the scope", () => {
    const gaps = parityGaps(holders, [
      { role: "reporting", cwid: "FAKE001", scopes: ["mentored-publications"] },
      // A sub-scope row does NOT cover a whole-report holder.
      { role: "reporting", cwid: "fake002", scopes: ["article-count:x"] },
      // EA with Communications only: the Development holder stays a gap.
      { role: "external_affairs", cwid: "fake003", scopes: ["communications"] },
    ]);
    expect(gaps.map((g) => `${g.cwid}:${g.scope}`)).toEqual(["fake002:*", "fake003:development"]);
  });

  it("a Reporting row never covers an External Affairs holder", () => {
    const gaps = parityGaps(holders.slice(2, 3), [
      { role: "reporting", cwid: "fake003", scopes: ["*"] },
    ]);
    expect(gaps).toHaveLength(1);
  });
});

describe("listGateHolders", () => {
  it("lists report_access rows and both allowlists, each as the function it confers", async () => {
    h.listCommsStewardCwids.mockReturnValue(["fake010"]);
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake010", "fake011"]);
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { reportKey: "article-count", scopeKey: "*", cwid: "FAKE001", granteeName: "Pat Example" },
        // A leftover grant on retired report 10 gates nothing: not listed.
        { reportKey: "display-titles", scopeKey: "*", cwid: "FAKE002", granteeName: null },
      ]);
    const holders = await listGateHolders({ reportAccess: { findMany } } as never);
    expect(holders).toEqual([
      {
        role: "reporting",
        cwid: "fake001",
        name: "Pat Example",
        reportKey: "article-count",
        scope: "*",
        via: "report_access",
      },
      {
        role: "external_affairs",
        cwid: "fake010",
        name: null,
        scope: "communications",
        via: "comms_steward_allowlist",
      },
      {
        role: "external_affairs",
        cwid: "fake010",
        name: null,
        scope: "development",
        via: "development_allowlist",
      },
      {
        role: "external_affairs",
        cwid: "fake011",
        name: null,
        scope: "development",
        via: "development_allowlist",
      },
    ]);
  });
});

describe("withDirectoryNames (ED fill for staff with no Scholar row)", () => {
  function row(over: Record<string, unknown>) {
    return {
      role: "reporting" as const,
      cwid: "fake001",
      source: "report_access",
      scopes: ["*"],
      name: "fake001",
      title: null,
      granteeName: null,
      grantedBy: "adm0001",
      grantedByName: "Admin Person",
      grantedAt: T0.toISOString(),
      ...over,
    };
  }

  it("fills bare-CWID rows, unnamed granters and unnamed parity holders in ONE lookup, and re-sorts", async () => {
    h.fetchDirectory.mockResolvedValue([
      edPerson("fake001", "Zed", "Staffer"),
      edPerson("fake002", "Ann", "Aide"),
      edPerson("adm0009", "Gia", "Granter"),
      edPerson("fake003", "Should", "NotApply"),
    ]);
    const { rows, holders } = await withDirectoryNames(
      [
        row({ cwid: "fake001", name: "fake001" }),
        row({ cwid: "fake002", name: "fake002", grantedBy: "adm0009", grantedByName: null }),
        row({ cwid: "fake003", name: "Named Person" }),
      ],
      [
        {
          role: "reporting",
          cwid: "fake002",
          name: null,
          reportKey: "article-count",
          scope: "*",
          via: "report_access",
        },
        {
          role: "external_affairs",
          cwid: "fake003",
          name: "Stored Name",
          scope: "development",
          via: "development_allowlist",
        },
      ],
    );
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1);
    expect([...h.fetchDirectory.mock.calls[0]![0]].sort()).toEqual([
      "adm0009",
      "fake001",
      "fake002",
    ]);
    expect(rows.map((r) => [r.cwid, r.name, r.grantedByName])).toEqual([
      ["fake002", "Ann Aide", "Gia Granter"],
      ["fake003", "Named Person", "Admin Person"],
      ["fake001", "Zed Staffer", "Admin Person"],
    ]);
    expect(holders!.map((x) => [x.cwid, x.name])).toEqual([
      ["fake002", "Ann Aide"],
      ["fake003", "Stored Name"],
    ]);
  });

  it("never looks up the allowlist granter sentinel", async () => {
    await withDirectoryNames([row({ name: "Named", grantedBy: "ALLOWLIST", grantedByName: null })]);
    expect(h.fetchDirectory).not.toHaveBeenCalled();
  });

  it("fails soft: an ED error leaves every name as it was", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.fetchDirectory.mockRejectedValue(new Error("ldap down"));
    const input = [row({ cwid: "fake001", name: "fake001" })];
    const { rows, holders } = await withDirectoryNames(input);
    expect(rows.map((r) => r.name)).toEqual(["fake001"]);
    expect(holders).toBeUndefined();
  });
});

describe("import stores the ED name as granteeName", () => {
  it("withDirectoryGranteeNames fills only rows with no source name", async () => {
    h.fetchDirectory.mockResolvedValue([
      edPerson("fake004", "Dee", "Directory"),
      edPerson("fake001", "Other", "Name"),
    ]);
    const out = await withDirectoryGranteeNames([
      {
        role: "reporting",
        cwid: "fake001",
        source: "report_access",
        scopes: ["*"],
        granteeName: "Pat Example",
        grantedBy: "adm0002",
        grantedAt: T0,
      },
      {
        role: "external_affairs",
        cwid: "fake004",
        source: "allowlist",
        scopes: ["development"],
        granteeName: null,
        grantedBy: "ALLOWLIST",
        grantedAt: null,
      },
    ]);
    expect(h.fetchDirectory).toHaveBeenCalledWith(["fake004"]);
    expect(out.map((r) => [r.cwid, r.granteeName])).toEqual([
      ["fake001", "Pat Example"],
      ["fake004", "Dee Directory"],
    ]);
  });

  it("importFunctionalRoles writes the ED name onto a new imported row", async () => {
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake005"]);
    h.fetchDirectory.mockResolvedValue([edPerson("fake005", "Eve", "Example")]);
    h.writeFindMany.mockResolvedValue([]);
    h.txFindMany.mockResolvedValue([]);
    h.txCreateMany.mockResolvedValue({ count: 1 });
    await importFunctionalRoles(ACTOR);
    expect(h.txCreateMany).toHaveBeenCalledTimes(1);
    expect(h.txCreateMany.mock.calls[0]![0].data[0]).toMatchObject({
      cwid: "fake005",
      granteeName: "Eve Example",
    });
  });

  it("an ED failure imports the row with a null granteeName, not an error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.listDevelopmentAllowlistCwids.mockReturnValue(["fake005"]);
    h.fetchDirectory.mockRejectedValue(new Error("ldap down"));
    h.writeFindMany.mockResolvedValue([]);
    h.txFindMany.mockResolvedValue([]);
    h.txCreateMany.mockResolvedValue({ count: 1 });
    const result = await importFunctionalRoles(ACTOR);
    expect(result.added).toBe(1);
    expect(h.txCreateMany.mock.calls[0]![0].data[0]).toMatchObject({
      cwid: "fake005",
      granteeName: null,
    });
  });
});
