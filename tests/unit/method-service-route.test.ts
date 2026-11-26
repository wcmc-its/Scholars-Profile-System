/**
 * POST /api/edit/method-service: a unit's method services.
 *
 * readEditRequest is mocked to inject a parsed context (the core-staff route
 * test's approach); editOk/editError, the authz predicates, the validators and
 * the family check stay real. DB and audit are mocked. Made-up units, people
 * and families only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  deptFindUnique: vi.fn(),
  coreFindUnique: vi.fn(),
  unitAdminFindMany: vi.fn(),
  unitAdminFindUnique: vi.fn(),
  familyGroupBy: vi.fn(),
  suppressionFindMany: vi.fn(),
  sensitivityFindMany: vi.fn(),
  serviceFindUnique: vi.fn(),
  transaction: vi.fn(),
  txCreate: vi.fn(),
  txUpdate: vi.fn(),
  txDelete: vi.fn(),
  txFindUnique: vi.fn(),
  txQueryRaw: vi.fn(),
  bustCache: vi.fn(),
  appendAuditRow: vi.fn(),
  logEditDenial: vi.fn(),
  resolveEditIdentity: vi.fn(),
  loadServiceReview: vi.fn(),
  fetchAffiliations: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: m.readEditRequest,
  resolveEditIdentity: m.resolveEditIdentity,
}));
// The review loader has its own tests; here only who may read it matters.
vi.mock("@/lib/api/method-service-review", () => ({ loadServiceReview: m.loadServiceReview }));
// The public page's cache: here only that a write clears it matters.
vi.mock("@/lib/api/method-service-collaborations", () => ({
  bustMethodServiceCache: m.bustCache,
}));
vi.mock("@/lib/edit/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/authz")>()),
  logEditDenial: m.logEditDenial,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: m.appendAuditRow }));
// PubMed: never the network. The matching itself stays real.
vi.mock("@/lib/edit/pubmed-affiliations", () => ({ fetchAuthorAffiliations: m.fetchAffiliations }));
vi.mock("@/lib/db", () => {
  const read = {
    department: { findUnique: m.deptFindUnique },
    core: { findUnique: m.coreFindUnique },
    unitAdmin: { findMany: m.unitAdminFindMany, findUnique: m.unitAdminFindUnique },
    scholarFamily: { groupBy: m.familyGroupBy },
    familySuppressionOverlay: { findMany: m.suppressionFindMany },
    familySensitivityOverlay: { findMany: m.sensitivityFindMany },
  };
  return {
    prisma: read,
    db: {
      read,
      write: { $transaction: m.transaction, methodService: { findUnique: m.serviceFindUnique } },
    },
  };
});

import { GET, POST } from "@/app/api/edit/method-service/route";

const ACTOR = "act0001";
const DEPT_A = "DEPTA";
const DEPT_B = "DEPTB";
const CORE = "77";
const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };
const FAM_2 = { supercategory: "evidence_synthesis", familyLabel: "Example search methods" };

const fakeTx = {
  $queryRaw: m.txQueryRaw,
  methodService: {
    create: m.txCreate,
    update: m.txUpdate,
    delete: m.txDelete,
    findUnique: m.txFindUnique,
  },
};

/** A stored row, as the DB hands it back. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 5,
    entityType: "department",
    entityId: DEPT_A,
    name: "Example service",
    url: "https://example.org/service",
    families: [FAM],
    supportedPmids: ["111", "222"],
    excludedPmids: [],
    countStaffPapers: false,
    affiliationPhrases: [],
    coauthoredPmids: [],
    ...over,
  };
}

const CREATE = {
  op: "create",
  entityType: "department",
  entityId: DEPT_A,
  name: "Example service",
  url: "https://example.org/service",
  families: [FAM],
};

/** No role of any kind unless a test grants one. */
const NOBODY = { isSuperuser: false, isCommsSteward: false };
const SUPERUSER = { isSuperuser: true };
/** Who `call` signs in when a test names nobody. */
let defaultSession: Record<string, unknown> = NOBODY;

async function call(
  body: Record<string, unknown>,
  session: Record<string, unknown> = defaultSession,
  identity: { realCwid?: string; impersonatedCwid?: string | null } = {},
) {
  m.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: { cwid: ACTOR, ...NOBODY, ...session },
      realCwid: identity.realCwid ?? ACTOR,
      impersonatedCwid: identity.impersonatedCwid ?? null,
      requestId: "req-1",
      body,
    },
  });
  return POST(
    new NextRequest("http://localhost/api/edit/method-service", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: "{}",
    }),
  );
}

/** Grant the actor a role on one department (the `getEffectiveUnitRole` lookup). */
function grantDepartment(code: string, role: "owner" | "curator") {
  m.unitAdminFindMany.mockImplementation(
    async (args: { where: { OR: Array<{ entityType: string; entityId: string }> } }) =>
      args.where.OR.some((u) => u.entityType === "department" && u.entityId === code)
        ? [{ entityType: "department", entityId: code, role }]
        : [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  defaultSession = NOBODY;
  m.fetchAffiliations.mockResolvedValue(new Map());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("METHOD_SERVICES", "on");
  vi.stubEnv("METHODS_LENS_PAGES", "on");
  vi.stubEnv("METHODS_LENS_ENABLED", "on");
  vi.stubEnv("METHODS_LENS_SENSITIVE_GATE", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.deptFindUnique.mockImplementation(async (args: { where: { code: string } }) =>
    [DEPT_A, DEPT_B].includes(args.where.code) ? { code: args.where.code } : null,
  );
  m.coreFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === CORE ? { id: CORE } : null,
  );
  m.unitAdminFindMany.mockResolvedValue([]);
  m.unitAdminFindUnique.mockResolvedValue(null);
  // Both made-up families are real and visible unless a test says otherwise.
  m.familyGroupBy.mockResolvedValue([FAM, FAM_2]);
  m.suppressionFindMany.mockResolvedValue([]);
  m.sensitivityFindMany.mockResolvedValue([]);
  m.serviceFindUnique.mockResolvedValue(row());
  m.txCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 9,
    ...args.data,
  }));
  m.txUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...row(),
    ...args.data,
  }));
  m.txDelete.mockResolvedValue({});
  m.txQueryRaw.mockResolvedValue([{ id: 5 }]);
  // The locked re-read sees what the first read saw unless a test says another
  // request got in between.
  m.txFindUnique.mockImplementation((...args: unknown[]) => m.serviceFindUnique(...args));
  m.appendAuditRow.mockResolvedValue(undefined);
  m.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/edit/method-service: gates", () => {
  it.each(["METHOD_SERVICES", "METHODS_LENS_PAGES", "METHODS_LENS_ENABLED"])(
    "404s when %s is off, before reading the request",
    async (flag) => {
      vi.stubEnv(flag, "off");
      const res = await call(CREATE, { isSuperuser: true });
      expect(res.status).toBe(404);
      expect(m.readEditRequest).not.toHaveBeenCalled();
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );

  it("passes through a readEditRequest rejection (401)", async () => {
    m.readEditRequest.mockResolvedValue({ ok: false, response: new NextResponse(null, { status: 401 }) });
    const res = await POST(new NextRequest("http://localhost/api/edit/method-service", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s an unknown op", async () => {
    const res = await call({ ...CREATE, op: "merge" }, { isSuperuser: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_op" });
  });

  it.each(["division", "center", "institution", "scholar", undefined])(
    "400s entityType %s, even for a superuser",
    async (entityType) => {
      const res = await call({ ...CREATE, entityType }, { isSuperuser: true });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_entity_type", field: "entityType" });
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );

  it("404s an unknown department and an unknown core", async () => {
    const dept = await call({ ...CREATE, entityId: "NOPE" }, { isSuperuser: true });
    expect(dept.status).toBe(404);
    expect(await dept.json()).toMatchObject({ error: "unit_not_found" });
    const core = await call({ ...CREATE, entityType: "core", entityId: "404" }, { isSuperuser: true });
    expect(core.status).toBe(404);
    expect(await core.json()).toMatchObject({ error: "core_not_found" });
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/method-service: superuser only", () => {
  const ALL_OPS: Array<[string, Record<string, unknown>]> = [
    ["create", CREATE],
    ["create on a core", { ...CREATE, entityType: "core", entityId: CORE }],
    ["update", { op: "update", id: 5, name: "Renamed" }],
    ["delete", { op: "delete", id: 5 }],
    ["exclude", { op: "exclude", id: 5, pmid: "111" }],
    ["restore", { op: "restore", id: 5, pmid: "111" }],
  ];

  it.each(ALL_OPS)("a superuser can %s", async (_label, body) => {
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: body.op === "restore" ? ["111"] : [] }));
    const res = await call(body, SUPERUSER);
    expect(res.status).toBe(200);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.logEditDenial).not.toHaveBeenCalled();
  });

  it.each(ALL_OPS)("a unit owner gets 403 on %s, logged, with no write", async (_label, body) => {
    // Owner of the department AND of the core: neither grant opens anything.
    grantDepartment(DEPT_A, "owner");
    m.unitAdminFindUnique.mockResolvedValue({ role: "owner" });
    const res = await call(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
    expect(m.logEditDenial).toHaveBeenCalledWith({
      actorCwid: ACTOR,
      targetCwid: ACTOR,
      path: "/api/edit/method-service",
      reason: "not_superuser",
    });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
    expect(m.bustCache).not.toHaveBeenCalled();
    // Refused before anything is looked up: no probing for a unit or a service.
    expect(m.deptFindUnique).not.toHaveBeenCalled();
    expect(m.coreFindUnique).not.toHaveBeenCalled();
    expect(m.serviceFindUnique).not.toHaveBeenCalled();
    expect(m.unitAdminFindMany).not.toHaveBeenCalled();
    expect(m.unitAdminFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    { isCommsSteward: true },
    { isContentEditor: true },
    { isCoreDirector: true },
    { isCommsSteward: true, isObserver: true },
  ])("%o gets 403 on every op", async (session) => {
    for (const [, body] of ALL_OPS) {
      const res = await call(body, session);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "not_superuser" });
    }
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("an unknown op from someone who is not a superuser is a 403, not a 400", async () => {
    const res = await call({ op: "merge" });
    expect(res.status).toBe(403);
  });

  it("View as: the verdict is the viewed person's, so a superuser viewing a unit owner is refused", async () => {
    // `readEditRequest` hands the route the EFFECTIVE session.
    const res = await call(CREATE, NOBODY, { realCwid: "real001", impersonatedCwid: ACTOR });
    expect(res.status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/method-service: create", () => {
  const SU = { isSuperuser: true };

  it("writes the row and one roster_change audit row in the same transaction", async () => {
    const res = await call(
      { ...CREATE, supportedPmids: ["111", "PMID: 222", "111"] },
      SU,
      { realCwid: "real001", impersonatedCwid: ACTOR },
    );
    expect(res.status).toBe(200);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.txCreate).toHaveBeenCalledWith({
      data: {
        entityType: "department",
        entityId: DEPT_A,
        name: "Example service",
        url: "https://example.org/service",
        families: [FAM],
        supportedPmids: ["111", "222"],
        excludedPmids: [],
        affiliationPhrases: [],
        authorNames: [],
        coauthoredPmids: [],
        nameMatchedPmids: [],
        affiliationCheckedPmids: [],
        countStaffPapers: false,
        addedBy: ACTOR, // the EFFECTIVE actor
      },
      select: expect.any(Object),
    });
    expect(m.appendAuditRow).toHaveBeenCalledTimes(1);
    const [tx, audit] = m.appendAuditRow.mock.calls[0];
    expect(tx).toBe(fakeTx); // the transaction's own client, not db.write
    expect(audit).toMatchObject({
      actorCwid: "real001", // the REAL human
      impersonatedCwid: ACTOR,
      action: "roster_change",
      targetEntityType: "department",
      targetEntityId: DEPT_A,
      fieldsChanged: ["method_services"],
      beforeValues: null,
      afterValues: {
        id: 9,
        name: "Example service",
        url: "https://example.org/service",
        families: [FAM],
        countStaffPapers: false,
        supportedPmidCount: 2,
        supportedPmids: ["111", "222"],
        excludedPmidCount: 0,
      },
      requestId: "req-1",
    });
    expect(audit.ts).toBeInstanceOf(Date);
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      service: { id: 9, entityType: "department", entityId: DEPT_A, supportedPmids: ["111", "222"] },
    });
  });

  it("audits a core's service against the core", async () => {
    await call({ ...CREATE, entityType: "core", entityId: CORE }, SU);
    expect(m.appendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "roster_change",
      targetEntityType: "core",
      targetEntityId: CORE,
    });
  });

  it("defaults countStaffPapers to true for a core and false for a department", async () => {
    await call({ ...CREATE, entityType: "core", entityId: CORE }, SU);
    expect(m.txCreate.mock.calls[0][0].data.countStaffPapers).toBe(true);
    await call(CREATE, SU);
    expect(m.txCreate.mock.calls[1][0].data.countStaffPapers).toBe(false);
  });

  it("honours an explicit countStaffPapers and rejects a non-boolean", async () => {
    await call({ ...CREATE, countStaffPapers: true }, SU);
    expect(m.txCreate.mock.calls[0][0].data.countStaffPapers).toBe(true);
    const bad = await call({ ...CREATE, countStaffPapers: "yes" }, SU);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "countStaffPapers" });
  });

  it("records a long PMID list in the audit row as its count only", async () => {
    const pmids = Array.from({ length: 101 }, (_, i) => String(1000 + i));
    await call({ ...CREATE, supportedPmids: pmids }, SU);
    const after = m.appendAuditRow.mock.calls[0][1].afterValues;
    expect(after.supportedPmidCount).toBe(101);
    expect(after).not.toHaveProperty("supportedPmids");
    expect(m.txCreate.mock.calls[0][0].data.supportedPmids).toHaveLength(101);
  });

  it.each([
    ["an http URL", { url: "http://example.org" }, "invalid_url", "url"],
    ["an empty URL", { url: "" }, "url_required", "url"],
    ["a missing URL", { url: undefined }, "invalid_value", "url"],
    ["a javascript: URL", { url: "javascript:alert(1)" }, "invalid_url", "url"],
    ["an empty name", { name: "  " }, "name_required", "name"],
    ["an over-long name", { name: "x".repeat(256) }, "name_too_long", "name"],
    ["no families", { families: [] }, "families_required", "families"],
    ["a malformed family", { families: [{ supercategory: "x" }] }, "invalid_value", "families"],
    ["a token that is not a PMID", { supportedPmids: ["111", "abc"] }, "invalid_pmids", "supportedPmids"],
    ["excludedPmids on create", { excludedPmids: ["111"] }, "invalid_value", "excludedPmids"],
    ["coauthoredPmids from the client", { coauthoredPmids: ["111"] }, "invalid_value", "coauthoredPmids"],
    ["a phrase under 3 characters", { affiliationPhrases: ["ab"] }, "phrase_too_short", "affiliationPhrases"],
    ["a phrase over 120 characters", { affiliationPhrases: ["x".repeat(121)] }, "phrase_too_long", "affiliationPhrases"],
    [
      "more than 10 phrases",
      { affiliationPhrases: Array.from({ length: 11 }, (_, i) => `Example unit ${i}`) },
      "too_many_phrases",
      "affiliationPhrases",
    ],
    ["phrases that are not strings", { affiliationPhrases: [1] }, "invalid_value", "affiliationPhrases"],
    ["nameMatchedPmids from the client", { nameMatchedPmids: ["111"] }, "invalid_value", "nameMatchedPmids"],
    ["an author name with no initial", { authorNames: ["Rivera Stone"] }, "author_name_no_initial", "authorNames"],
    ["an author name under 2 characters", { authorNames: ["R"] }, "author_name_too_short", "authorNames"],
    ["an author name over 80 characters", { authorNames: [`${"x".repeat(79)} B`] }, "author_name_too_long", "authorNames"],
    [
      "more than 50 author names",
      { authorNames: Array.from({ length: 51 }, (_, i) => `Exampl${"e".repeat(i + 1)} B`) },
      "too_many_author_names",
      "authorNames",
    ],
    ["author names that are not strings", { authorNames: [1] }, "invalid_value", "authorNames"],
  ])("400s %s", async (_label, over, error, field) => {
    const res = await call({ ...CREATE, ...over }, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error, field });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s a body with a required field left out", async () => {
    for (const key of ["name", "url", "families"] as const) {
      const rest = Object.fromEntries(Object.entries(CREATE).filter(([k]) => k !== key));
      const res = await call(rest, SU);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ field: key });
    }
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s more than 5000 PMIDs rather than truncating", async () => {
    const pmids = Array.from({ length: 5001 }, (_, i) => String(i + 1));
    const res = await call({ ...CREATE, supportedPmids: pmids }, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too_many_pmids" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s a family that does not exist", async () => {
    m.familyGroupBy.mockResolvedValue([]);
    const res = await call(CREATE, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_family", field: "families" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s a label that matches only case-insensitively", async () => {
    // The column's collation would return the row for the wrong case.
    m.familyGroupBy.mockResolvedValue([FAM]);
    const res = await call({ ...CREATE, families: [{ ...FAM, familyLabel: FAM.familyLabel.toUpperCase() }] }, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_family" });
  });

  it("400s when one of several families is unknown", async () => {
    m.familyGroupBy.mockResolvedValue([FAM]);
    const res = await call({ ...CREATE, families: [FAM, FAM_2] }, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_family" });
  });

  it("400s a suppressed family and a sensitive family", async () => {
    m.suppressionFindMany.mockResolvedValue([FAM]);
    expect((await call(CREATE, SU)).status).toBe(400);
    m.suppressionFindMany.mockResolvedValue([]);
    m.sensitivityFindMany.mockResolvedValue([FAM]);
    const res = await call(CREATE, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_family" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("500s write_failed when the transaction throws", async () => {
    m.transaction.mockRejectedValue(new Error("db down"));
    const res = await call(CREATE, SU);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});

describe("POST /api/edit/method-service: update and delete use the STORED row's unit", () => {
  it("an update never changes the owner, and is audited against the stored unit", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ entityId: DEPT_B }));
    const res = await call(
      { op: "update", id: 5, entityType: "core", entityId: CORE, name: "Renamed" },
      SUPERUSER,
    );
    expect(res.status).toBe(200);
    expect(m.txUpdate).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { name: "Renamed" }, // no entityType / entityId
      select: expect.any(Object),
    });
    expect(m.appendAuditRow.mock.calls[0][1]).toMatchObject({
      targetEntityType: "department",
      targetEntityId: DEPT_B,
    });
  });

  it("reads the stored row from the writer", async () => {
    await call({ op: "delete", id: 5 }, { isSuperuser: true });
    expect(m.serviceFindUnique).toHaveBeenCalledWith({ where: { id: 5 }, select: expect.any(Object) });
  });

  it("404s an id with no row; 400s a malformed id", async () => {
    m.serviceFindUnique.mockResolvedValue(null);
    const missing = await call({ op: "update", id: 99, name: "X" }, { isSuperuser: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "service_not_found" });
    for (const id of ["5", 0, -1, 1.5, null, undefined]) {
      const res = await call({ op: "delete", id }, { isSuperuser: true });
      expect(res.status).toBe(400);
    }
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("404s when the stored row's unit no longer exists", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ entityId: "GONE" }));
    const res = await call({ op: "delete", id: 5 }, { isSuperuser: true });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/edit/method-service: update", () => {
  const SU = { isSuperuser: true };

  it("writes only the fields that changed and audits before and after", async () => {
    const res = await call(
      {
        op: "update",
        id: 5,
        name: "Example service", // unchanged
        url: "https://example.org/new",
        supportedPmids: ["111", "222", "333"],
        excludedPmids: ["111"],
        countStaffPapers: true,
      },
      SU,
    );
    expect(res.status).toBe(200);
    expect(m.txUpdate).toHaveBeenCalledWith({
      where: { id: 5 },
      data: {
        url: "https://example.org/new",
        supportedPmids: ["111", "222", "333"],
        excludedPmids: ["111"],
        countStaffPapers: true,
      },
      select: expect.any(Object),
    });
    const [tx, audit] = m.appendAuditRow.mock.calls[0];
    expect(tx).toBe(fakeTx);
    expect(audit).toMatchObject({
      action: "roster_change",
      targetEntityType: "department",
      targetEntityId: DEPT_A,
      fieldsChanged: ["method_services"],
      beforeValues: { url: "https://example.org/service", supportedPmidCount: 2, excludedPmidCount: 0 },
      afterValues: { url: "https://example.org/new", supportedPmidCount: 3, excludedPmidCount: 1 },
    });
    expect(await res.json()).toMatchObject({ changed: true, service: { url: "https://example.org/new" } });
  });

  it("is a no-op, with no write and no audit row, when nothing differs", async () => {
    // MySQL hands a JSON object's keys back re-ordered; that is not a change.
    m.serviceFindUnique.mockResolvedValue(
      row({ families: [{ familyLabel: FAM.familyLabel, supercategory: FAM.supercategory }] }),
    );
    const res = await call({ op: "update", id: 5, name: " Example service ", families: [FAM] }, SU);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false, service: { id: 5 } });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
    expect(m.familyGroupBy).not.toHaveBeenCalled();
  });

  it("checks new families and 400s an unknown one", async () => {
    m.familyGroupBy.mockResolvedValue([FAM]);
    const res = await call({ op: "update", id: 5, families: [FAM, FAM_2] }, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_family" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("does not re-check families an update leaves alone", async () => {
    m.familyGroupBy.mockResolvedValue([]); // the stored family has since lost its page
    const res = await call({ op: "update", id: 5, name: "Renamed" }, SU);
    expect(res.status).toBe(200);
    expect(m.familyGroupBy).not.toHaveBeenCalled();
  });

  it.each([
    [{ url: "" }, "url_required"],
    [{ url: "http://example.org" }, "invalid_url"],
    [{ name: "" }, "name_required"],
    [{ families: [] }, "families_required"],
    [{ excludedPmids: ["x"] }, "invalid_pmids"],
  ])("400s %o", async (over, error) => {
    const res = await call({ op: "update", id: 5, ...over }, SU);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error });
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/method-service: delete", () => {
  it("hard-deletes and audits the row that was there", async () => {
    const res = await call({ op: "delete", id: 5 }, SUPERUSER);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: 5, changed: true });
    expect(m.txDelete).toHaveBeenCalledWith({ where: { id: 5 } });
    const [tx, audit] = m.appendAuditRow.mock.calls[0];
    expect(tx).toBe(fakeTx);
    expect(audit).toMatchObject({
      action: "roster_change",
      targetEntityType: "department",
      targetEntityId: DEPT_A,
      fieldsChanged: ["method_services"],
      beforeValues: { id: 5, name: "Example service", supportedPmidCount: 2 },
      afterValues: null,
      actorCwid: ACTOR,
      impersonatedCwid: null,
      requestId: "req-1",
    });
  });
});

describe("POST /api/edit/method-service: exclude (Not ours) and restore (undo)", () => {
  beforeEach(() => {
    defaultSession = SUPERUSER;
  });

  it("exclude adds the PMID to the stored excluded list and audits it in the same transaction", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: ["900"] }));
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, op: "exclude", changed: true });
    expect(body.service.excludedPmids).toEqual(["900", "111"]);

    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 }, data: { excludedPmids: ["900", "111"] } }),
    );
    // Audited with the transaction's own client, reusing roster_change on the unit.
    expect(m.appendAuditRow).toHaveBeenCalledTimes(1);
    const [tx, audit] = m.appendAuditRow.mock.calls[0];
    expect(tx).toBe(fakeTx);
    expect(audit).toMatchObject({
      actorCwid: ACTOR,
      targetEntityType: "department",
      targetEntityId: DEPT_A,
      action: "roster_change",
      fieldsChanged: ["method_services"],
    });
    expect(audit.beforeValues).toMatchObject({ excludedPmidCount: 1, excludedPmids: ["900"] });
    expect(audit.afterValues).toMatchObject({
      excludedPmidCount: 2,
      excludedPmids: ["900", "111"],
      excludedPmid: "111",
    });
  });

  it("exclude leaves the supported list alone: excluded wins at read time", async () => {
    await call({ op: "exclude", id: 5, pmid: "111" });
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ excludedPmids: ["111"] });
  });

  it("restore removes the PMID again and audits which one", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: ["900", "111"] }));
    const res = await call({ op: "restore", id: 5, pmid: "111" });
    expect(res.status).toBe(200);
    expect((await res.json()).service.excludedPmids).toEqual(["900"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ excludedPmids: ["900"] });
    expect(m.appendAuditRow.mock.calls[0][1].afterValues).toMatchObject({
      excludedPmidCount: 1,
      restoredPmid: "111",
    });
  });

  it("reads `PMID: 111` and a leading zero as the same PMID", async () => {
    await call({ op: "exclude", id: 5, pmid: "PMID: 0111" });
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ excludedPmids: ["111"] });
  });

  it("is a no-op, with no write and no audit row, when the list already says so", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: ["111"] }));
    const again = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(await again.json()).toMatchObject({ ok: true, changed: false });
    const never = await call({ op: "restore", id: 5, pmid: "222" });
    expect(await never.json()).toMatchObject({ ok: true, changed: false });
    expect(m.txUpdate).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
    expect(m.bustCache).not.toHaveBeenCalled();
  });

  it("locks the row, then decides from the read made under the lock", async () => {
    const order: string[] = [];
    m.txQueryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock:${strings.join("?")}:${values.join(",")}`);
      return [{ id: 5 }];
    });
    m.txFindUnique.mockImplementation(async () => {
      order.push("read");
      return row();
    });
    m.txUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      order.push("write");
      return { ...row(), ...args.data };
    });
    await call({ op: "exclude", id: 5, pmid: "111" });
    expect(order).toEqual([
      "lock:SELECT id FROM method_service WHERE id = ? FOR UPDATE:5",
      "read",
      "write",
    ]);
  });

  it("two excludes at once: the second starts from what the first wrote, so neither is lost", async () => {
    // Both requests read [] before either wrote. The lock makes the second
    // re-read after the first committed ["111"].
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: [] }));
    m.txFindUnique.mockResolvedValue(row({ excludedPmids: ["111"] }));
    const res = await call({ op: "exclude", id: 5, pmid: "222" });
    expect((await res.json()).service.excludedPmids).toEqual(["111", "222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ excludedPmids: ["111", "222"] });
    // The audit row's "before" is the row as it really was.
    expect(m.appendAuditRow.mock.calls[0][1].beforeValues).toMatchObject({
      excludedPmidCount: 1,
      excludedPmids: ["111"],
    });
  });

  it("an exclude that another request already made is a no-op, with no second audit row", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: [] }));
    m.txFindUnique.mockResolvedValue(row({ excludedPmids: ["111"] }));
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, changed: false });
    expect(body.service.excludedPmids).toEqual(["111"]);
    expect(m.txUpdate).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
  });

  it("a restore does not bring back an exclusion made in between", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ excludedPmids: ["111"] }));
    m.txFindUnique.mockResolvedValue(row({ excludedPmids: ["111", "222"] }));
    await call({ op: "restore", id: 5, pmid: "111" });
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ excludedPmids: ["222"] });
  });

  it("404s when the service was removed before the lock was taken", async () => {
    m.txFindUnique.mockResolvedValue(null);
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "service_not_found" });
    expect(m.txUpdate).not.toHaveBeenCalled();
  });

  it("the 5000 cap is checked against the locked read, not the earlier one", async () => {
    m.serviceFindUnique.mockResolvedValue(
      row({ excludedPmids: Array.from({ length: 4999 }, (_, i) => String(700000 + i)) }),
    );
    m.txFindUnique.mockResolvedValue(
      row({ excludedPmids: Array.from({ length: 5000 }, (_, i) => String(700000 + i)) }),
    );
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too_many_pmids" });
    expect(m.txUpdate).not.toHaveBeenCalled();
  });

  it("create, update and delete each clear the public page's cache", async () => {
    await call(CREATE);
    await call({ op: "update", id: 5, name: "Renamed service" });
    await call({ op: "delete", id: 5 });
    expect(m.bustCache).toHaveBeenCalledTimes(3);
  });

  it("clears the public page's cache after a change", async () => {
    await call({ op: "exclude", id: 5, pmid: "111" });
    expect(m.bustCache).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 111, "", "abc", "111 222", ["111"]])("400s pmid %j", async (pmid) => {
    const res = await call({ op: "exclude", id: 5, pmid });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_pmids", field: "pmid" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("400s rather than grow the excluded list past 5000", async () => {
    m.serviceFindUnique.mockResolvedValue(
      row({ excludedPmids: Array.from({ length: 5000 }, (_, i) => String(700000 + i)) }),
    );
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too_many_pmids" });
    expect(m.txUpdate).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
  });

  it("404s an id with no row", async () => {
    m.serviceFindUnique.mockResolvedValue(null);
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(404);
  });

  it("500s write_failed when the transaction throws", async () => {
    m.transaction.mockRejectedValue(new Error("boom"));
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});

describe("GET /api/edit/method-service: the review numbers", () => {
  const REVIEW = { collaborations: 2, support: 1, supportedListed: 2, supportedOnPage: 1, perMethod: [], marked: [], excluded: [] };
  const get = (query = "?id=5") =>
    GET(new NextRequest(`http://localhost/api/edit/method-service${query}`));
  const signIn = (session: Record<string, unknown> = {}) =>
    m.resolveEditIdentity.mockResolvedValue({
      session: { cwid: ACTOR, ...NOBODY, ...session },
      realCwid: ACTOR,
      impersonatedCwid: null,
    });

  beforeEach(() => {
    signIn();
    m.loadServiceReview.mockResolvedValue(REVIEW);
  });

  it("404s while the flag is off, before resolving anyone", async () => {
    vi.stubEnv("METHOD_SERVICES", "off");
    expect((await get()).status).toBe(404);
    expect(m.resolveEditIdentity).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    m.resolveEditIdentity.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(m.loadServiceReview).not.toHaveBeenCalled();
  });

  it.each(["", "?id=0", "?id=abc", "?id=5%20OR%201"])("400s query %j", async (query) => {
    signIn(SUPERUSER);
    expect((await get(query)).status).toBe(400);
    expect(m.serviceFindUnique).not.toHaveBeenCalled();
  });

  it("a superuser gets the review, uncached", async () => {
    signIn(SUPERUSER);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, review: REVIEW });
    expect(m.loadServiceReview).toHaveBeenCalledWith(expect.objectContaining({ id: 5, entityId: DEPT_A }));
  });

  it("a unit owner gets 403, and neither the service nor the review is read", async () => {
    grantDepartment(DEPT_A, "owner");
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
    expect(m.serviceFindUnique).not.toHaveBeenCalled();
    expect(m.loadServiceReview).not.toHaveBeenCalled();
    expect(m.logEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: ACTOR, reason: "not_superuser" }),
    );
  });

  it.each([
    { isCommsSteward: true },
    { isContentEditor: true },
    { isCoreDirector: true },
    { isCommsSteward: true, isObserver: true },
  ])("%o gets 403", async (session) => {
    signIn(session);
    const res = await get();
    expect(res.status).toBe(403);
    expect(m.loadServiceReview).not.toHaveBeenCalled();
  });

  it("404s an id with no row", async () => {
    signIn(SUPERUSER);
    m.serviceFindUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("500s read_failed when the loader throws", async () => {
    signIn(SUPERUSER);
    m.loadServiceReview.mockRejectedValue(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
  });
});

describe("POST /api/edit/method-service: co-authors from PubMed affiliations", () => {
  const PHRASE = "Example Health Sciences Library";
  const MATCH = ["Department of Examples, Example University.", "example health  sciences LIBRARY, Example City."];
  const NO_MATCH = ["Department of Examples, Example University."];
  /** What `fetchAuthorAffiliations` hands back: an answer for each PMID given
   *  that is in `known`, and `complete` only when that is all of them. */
  const answers =
    (known: Record<string, string[]>, error?: string) =>
    async (pmids: string[]) => {
      const affiliations = new Map(pmids.filter((p) => p in known).map((p) => [p, known[p]]));
      return {
        affiliations,
        complete: affiliations.size === pmids.length,
        ...(error ? { error } : {}),
      };
    };
  const checkedRow = (over: Record<string, unknown> = {}) =>
    row({
      affiliationPhrases: [PHRASE],
      coauthoredPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
      ...over,
    });
  beforeEach(() => {
    defaultSession = SUPERUSER;
    m.fetchAffiliations.mockImplementation(answers({ "111": MATCH, "222": NO_MATCH }));
  });

  it("create stores the phrases, the supported PMIDs with a matching author, and what was checked", async () => {
    const res = await call({ ...CREATE, supportedPmids: ["111", "222"], affiliationPhrases: [` ${PHRASE} `] });
    expect(res.status).toBe(200);
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txCreate.mock.calls[0][0].data).toMatchObject({
      affiliationPhrases: [PHRASE],
      coauthoredPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
    });
    const body = await res.json();
    expect(body.service).toMatchObject({ affiliationPhrases: [PHRASE], coauthoredPmids: ["111"] });
    // Server-only bookkeeping: never in the view.
    expect(body.service).not.toHaveProperty("affiliationCheckedPmids");
    expect(body).not.toHaveProperty("warning");
    expect(body).not.toHaveProperty("pubmed");
    expect(m.appendAuditRow.mock.calls[0][1].afterValues).toMatchObject({
      affiliationPhrases: [PHRASE],
      coauthoredPmidCount: 1,
      affiliationCheckedPmidCount: 2,
    });
  });

  it("no phrases: an empty set, and PubMed is not asked", async () => {
    await call({ ...CREATE, supportedPmids: ["111", "222"] });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    expect(m.txCreate.mock.calls[0][0].data).toMatchObject({
      coauthoredPmids: [],
      affiliationCheckedPmids: [],
    });
  });

  it("no supported PMIDs: an empty set, and PubMed is not asked", async () => {
    await call({ ...CREATE, affiliationPhrases: [PHRASE] });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    expect(m.txCreate.mock.calls[0][0].data.coauthoredPmids).toEqual([]);
  });

  it("the client cannot set coauthoredPmids, on create or on update", async () => {
    for (const body of [
      { ...CREATE, coauthoredPmids: ["222"] },
      { op: "update", id: 5, name: "Renamed", coauthoredPmids: ["222"] },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_value", field: "coauthoredPmids" });
    }
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("update: new phrases are matched against the STORED supported list", async () => {
    const res = await call({ op: "update", id: 5, affiliationPhrases: [PHRASE] });
    expect(res.status).toBe(200);
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      affiliationPhrases: [PHRASE],
      coauthoredPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
    });
  });

  it("update: a longer supported list asks PubMed for the NEW pmids only, against the STORED phrases", async () => {
    m.serviceFindUnique.mockResolvedValue(checkedRow());
    m.fetchAffiliations.mockImplementation(answers({ "333": [`${PHRASE}, Example City.`] }));
    await call({ op: "update", id: 5, supportedPmids: ["222", "333"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["333"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      supportedPmids: ["222", "333"],
      coauthoredPmids: ["333"],
      affiliationCheckedPmids: ["222", "333"],
    });
  });

  it("update: removing every phrase empties both sets without asking PubMed", async () => {
    m.serviceFindUnique.mockResolvedValue(checkedRow());
    await call({ op: "update", id: 5, affiliationPhrases: [] });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      affiliationPhrases: [],
      coauthoredPmids: [],
      affiliationCheckedPmids: [],
    });
  });

  it("update: an update that names neither list does not ask PubMed", async () => {
    m.serviceFindUnique.mockResolvedValue(checkedRow());
    await call({ op: "update", id: 5, name: "Renamed" });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ name: "Renamed" });
  });

  it("update: a fully checked list costs no PubMed request, even with the phrases resent", async () => {
    m.serviceFindUnique.mockResolvedValue(checkedRow());
    const res = await call({ op: "update", id: 5, name: "Renamed", affiliationPhrases: [PHRASE] });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, changed: true });
    expect(body).not.toHaveProperty("warning");
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({ name: "Renamed" });
  });

  it("update: a changed phrase starts the check again from nothing", async () => {
    m.serviceFindUnique.mockResolvedValue(checkedRow());
    m.fetchAffiliations.mockImplementation(answers({ "111": NO_MATCH, "222": ["Example Core, Example City."] }));
    await call({ op: "update", id: 5, affiliationPhrases: ["Example Core"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      affiliationPhrases: ["Example Core"],
      coauthoredPmids: ["222"],
    });
  });

  it("update: an added phrase keeps the stored matches and re-checks only the rest", async () => {
    m.serviceFindUnique.mockResolvedValue(checkedRow());
    m.fetchAffiliations.mockImplementation(answers({ "222": ["Example Core, Example City."] }));
    await call({ op: "update", id: 5, affiliationPhrases: [PHRASE, "Example Core"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      affiliationPhrases: [PHRASE, "Example Core"],
      coauthoredPmids: ["111", "222"],
    });
  });

  it("update: a retry after a failed check writes the sets alone, and audits it", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ affiliationPhrases: [PHRASE], coauthoredPmids: [] }));
    const res = await call({ op: "update", id: 5, affiliationPhrases: [PHRASE] });
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      coauthoredPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
    });
    expect(m.appendAuditRow.mock.calls[0][1]).toMatchObject({
      beforeValues: { coauthoredPmidCount: 0 },
      afterValues: { coauthoredPmidCount: 1 },
    });
    expect(m.bustCache).toHaveBeenCalledTimes(1);
  });

  describe("when PubMed answers for only part of the list", () => {
    it("keeps what it read, warns with the progress, and the next save asks for the rest only", async () => {
      // The deadline passed after 111: nothing is known about 222 and 333.
      m.fetchAffiliations.mockImplementation(answers({ "111": MATCH }, "The operation timed out"));
      const first = await call({
        ...CREATE,
        supportedPmids: ["111", "222", "333"],
        affiliationPhrases: [PHRASE],
      });
      expect(await first.json()).toMatchObject({
        ok: true,
        changed: true,
        warning: "pubmed_incomplete",
        pubmed: { checked: 1, total: 3 },
      });
      expect(m.txCreate.mock.calls[0][0].data).toMatchObject({
        coauthoredPmids: ["111"],
        affiliationCheckedPmids: ["111"],
      });

      m.serviceFindUnique.mockResolvedValue(
        row({
          supportedPmids: ["111", "222", "333"],
          affiliationPhrases: [PHRASE],
          coauthoredPmids: ["111"],
          affiliationCheckedPmids: ["111"],
        }),
      );
      m.fetchAffiliations.mockClear();
      m.fetchAffiliations.mockImplementation(answers({ "222": NO_MATCH, "333": MATCH }));
      const second = await call({ op: "update", id: 5, affiliationPhrases: [PHRASE] });
      expect(m.fetchAffiliations).toHaveBeenCalledWith(["222", "333"]);
      const body = await second.json();
      expect(body).toMatchObject({ ok: true, changed: true });
      expect(body).not.toHaveProperty("warning");
      expect(m.txUpdate.mock.calls[0][0].data).toEqual({
        coauthoredPmids: ["111", "333"],
        affiliationCheckedPmids: ["111", "222", "333"],
      });
    });

    it("a PMID PubMed did not answer for never takes a stored match away", async () => {
      // 111 was a match and is still checked. 333 is new, and PubMed's answer
      // leaves it out: 111 stays, 333 stays unchecked, and the save warns.
      m.serviceFindUnique.mockResolvedValue(checkedRow());
      m.fetchAffiliations.mockImplementation(answers({}));
      const res = await call({ op: "update", id: 5, supportedPmids: ["111", "222", "333"] });
      expect(await res.json()).toMatchObject({
        ok: true,
        changed: true,
        warning: "pubmed_unavailable",
        pubmed: { checked: 2, total: 3 },
      });
      expect(m.txUpdate.mock.calls[0][0].data).toEqual({ supportedPmids: ["111", "222", "333"] });
    });
  });

  describe("when PubMed cannot be read", () => {
    beforeEach(() => {
      m.fetchAffiliations.mockImplementation(answers({}, "EFetch 502"));
    });

    it("create still saves, with empty sets and a warning", async () => {
      const res = await call({ ...CREATE, supportedPmids: ["111"], affiliationPhrases: [PHRASE] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        changed: true,
        warning: "pubmed_unavailable",
        pubmed: { checked: 0, total: 1 },
      });
      expect(m.txCreate.mock.calls[0][0].data).toMatchObject({
        affiliationPhrases: [PHRASE],
        coauthoredPmids: [],
        affiliationCheckedPmids: [],
      });
      expect(m.appendAuditRow).toHaveBeenCalledTimes(1);
    });

    it("a lookup that throws is handled the same way", async () => {
      m.fetchAffiliations.mockRejectedValue(new Error("boom"));
      const res = await call({ ...CREATE, supportedPmids: ["111"], affiliationPhrases: [PHRASE] });
      expect(await res.json()).toMatchObject({ ok: true, warning: "pubmed_unavailable" });
    });

    it("update still saves the rest, keeps the stored sets, and warns", async () => {
      const stored = checkedRow();
      m.serviceFindUnique.mockResolvedValue(stored);
      m.txUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        ...stored,
        ...args.data,
      }));
      const res = await call({ op: "update", id: 5, name: "Renamed", supportedPmids: ["111", "222", "333"] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, changed: true, warning: "pubmed_unavailable" });
      expect(m.fetchAffiliations).toHaveBeenCalledWith(["333"]);
      // Not in the write at all: the columns keep their previous values.
      expect(m.txUpdate.mock.calls[0][0].data).toEqual({
        name: "Renamed",
        supportedPmids: ["111", "222", "333"],
      });
      expect(body.service.coauthoredPmids).toEqual(["111"]);
      expect(m.bustCache).toHaveBeenCalledTimes(1);
    });

    it("an update with nothing else to save is no write, and still warns", async () => {
      m.serviceFindUnique.mockResolvedValue(
        row({ affiliationPhrases: [PHRASE], coauthoredPmids: ["111"], affiliationCheckedPmids: ["111"] }),
      );
      const res = await call({ op: "update", id: 5, affiliationPhrases: [PHRASE] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, changed: false, warning: "pubmed_unavailable" });
      expect(m.fetchAffiliations).toHaveBeenCalledWith(["222"]);
      expect(m.transaction).not.toHaveBeenCalled();
    });
  });
});

describe("POST /api/edit/method-service: co-authors from PubMed author names", () => {
  const NAME = "Rivera Stone B";
  const PHRASE = "Example Health Sciences Library";
  const ELSEWHERE = ["Department of Examples, Example University."];
  type Known = Record<string, { affiliations?: string[]; authors?: Array<[string, string]> }>;
  /** What `fetchAuthorAffiliations` hands back for the PMIDs in `known`. */
  const answers = (known: Known) => async (pmids: string[]) => {
    const got = pmids.filter((p) => p in known);
    return {
      affiliations: new Map(got.map((p) => [p, known[p].affiliations ?? ELSEWHERE])),
      authors: new Map(
        got.map((p) => [p, (known[p].authors ?? []).map(([lastName, initials]) => ({ lastName, initials }))]),
      ),
      complete: got.length === pmids.length,
    };
  };
  const PUBMED: Known = {
    "111": { authors: [["Okafor", "CA"], ["Rivera-Stone", "BK"]] },
    "222": { authors: [["Rivera Stone", "K"]] },
  };
  const namedRow = (over: Record<string, unknown> = {}) =>
    row({
      authorNames: [NAME],
      coauthoredPmids: ["111"],
      nameMatchedPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
      ...over,
    });
  beforeEach(() => {
    defaultSession = SUPERUSER;
    m.fetchAffiliations.mockImplementation(answers(PUBMED));
  });

  it("a service with names and no phrases is checked, and a name match is stored as one", async () => {
    const res = await call({ ...CREATE, supportedPmids: ["111", "222"], authorNames: [` ${NAME} `] });
    expect(res.status).toBe(200);
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txCreate.mock.calls[0][0].data).toMatchObject({
      affiliationPhrases: [],
      authorNames: [NAME],
      coauthoredPmids: ["111"],
      nameMatchedPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
    });
    const body = await res.json();
    expect(body.service).toMatchObject({ authorNames: [NAME], coauthoredPmids: ["111"] });
    expect(m.appendAuditRow.mock.calls[0][1].afterValues).toMatchObject({
      authorNames: [NAME],
      coauthoredPmidCount: 1,
      nameMatchedPmidCount: 1,
    });
  });

  it("an update that only adds the first name runs the check on the stored list", async () => {
    m.serviceFindUnique.mockResolvedValue(row());
    const res = await call({ op: "update", id: 5, authorNames: [NAME] });
    expect(res.status).toBe(200);
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      authorNames: [NAME],
      coauthoredPmids: ["111"],
      nameMatchedPmids: ["111"],
      affiliationCheckedPmids: ["111", "222"],
    });
  });

  it("an affiliation match is not recorded as a name match, even when the name matches too", async () => {
    m.fetchAffiliations.mockImplementation(
      answers({ "111": { affiliations: [`${PHRASE}, Example City.`], authors: [["Rivera Stone", "B"]] } }),
    );
    await call({ ...CREATE, supportedPmids: ["111"], affiliationPhrases: [PHRASE], authorNames: [NAME] });
    expect(m.txCreate.mock.calls[0][0].data).toMatchObject({
      coauthoredPmids: ["111"],
      nameMatchedPmids: [],
    });
  });

  it("the same names on a fully checked list ask PubMed nothing", async () => {
    m.serviceFindUnique.mockResolvedValue(namedRow());
    const res = await call({ op: "update", id: 5, authorNames: [NAME] });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ changed: false });
  });

  it("changing a name starts the check again", async () => {
    m.serviceFindUnique.mockResolvedValue(namedRow());
    await call({ op: "update", id: 5, authorNames: ["Rivera Stone K"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toMatchObject({
      authorNames: ["Rivera Stone K"],
      coauthoredPmids: ["222"],
      nameMatchedPmids: ["222"],
    });
  });

  it("removing one of two names starts the check again", async () => {
    m.serviceFindUnique.mockResolvedValue(
      namedRow({ authorNames: [NAME, "Okafor C"], coauthoredPmids: ["111"], nameMatchedPmids: ["111"] }),
    );
    await call({ op: "update", id: 5, authorNames: ["Okafor C"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["111", "222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toMatchObject({ authorNames: ["Okafor C"] });
  });

  it("removing the only name, with no phrases, clears the matches without asking PubMed", async () => {
    m.serviceFindUnique.mockResolvedValue(namedRow());
    await call({ op: "update", id: 5, authorNames: [] });
    expect(m.fetchAffiliations).not.toHaveBeenCalled();
    expect(m.txUpdate.mock.calls[0][0].data).toEqual({
      authorNames: [],
      coauthoredPmids: [],
      nameMatchedPmids: [],
      affiliationCheckedPmids: [],
    });
  });

  it("adding a name keeps the matches already found and re-checks the rest", async () => {
    m.serviceFindUnique.mockResolvedValue(namedRow());
    await call({ op: "update", id: 5, authorNames: [NAME, "Rivera Stone K"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toMatchObject({
      authorNames: [NAME, "Rivera Stone K"],
      coauthoredPmids: ["111", "222"],
      nameMatchedPmids: ["111", "222"],
    });
  });

  it("adding a name to a service with a phrase keeps its affiliation matches as they were", async () => {
    m.serviceFindUnique.mockResolvedValue(
      row({
        affiliationPhrases: [PHRASE],
        coauthoredPmids: ["111"],
        affiliationCheckedPmids: ["111", "222"],
      }),
    );
    await call({ op: "update", id: 5, authorNames: ["Rivera Stone K"] });
    expect(m.fetchAffiliations).toHaveBeenCalledWith(["222"]);
    expect(m.txUpdate.mock.calls[0][0].data).toMatchObject({
      coauthoredPmids: ["111", "222"],
      nameMatchedPmids: ["222"],
    });
  });

  it("the client cannot set nameMatchedPmids on an update", async () => {
    m.serviceFindUnique.mockResolvedValue(namedRow());
    const res = await call({ op: "update", id: 5, name: "Renamed", nameMatchedPmids: ["222"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_value", field: "nameMatchedPmids" });
    expect(m.transaction).not.toHaveBeenCalled();
  });
});
