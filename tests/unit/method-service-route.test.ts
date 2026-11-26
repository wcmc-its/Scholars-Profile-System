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
  appendAuditRow: vi.fn(),
  logEditDenial: vi.fn(),
  resolveEditIdentity: vi.fn(),
  loadServiceReview: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: m.readEditRequest,
  resolveEditIdentity: m.resolveEditIdentity,
}));
// The review loader has its own tests; here only who may read it matters.
vi.mock("@/lib/api/method-service-review", () => ({ loadServiceReview: m.loadServiceReview }));
vi.mock("@/lib/edit/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/authz")>()),
  logEditDenial: m.logEditDenial,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: m.appendAuditRow }));
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

const fakeTx = { methodService: { create: m.txCreate, update: m.txUpdate, delete: m.txDelete } };

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

async function call(
  body: Record<string, unknown>,
  session: Record<string, unknown> = NOBODY,
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

describe("POST /api/edit/method-service: who may create", () => {
  it("a department owner can", async () => {
    grantDepartment(DEPT_A, "owner");
    const res = await call(CREATE);
    expect(res.status).toBe(200);
    expect(m.txCreate).toHaveBeenCalledTimes(1);
  });

  it("a department curator can", async () => {
    grantDepartment(DEPT_A, "curator");
    const res = await call(CREATE);
    expect(res.status).toBe(200);
    expect(m.txCreate).toHaveBeenCalledTimes(1);
  });

  it("an outsider gets 403 and the denial is logged, with no write", async () => {
    const res = await call(CREATE);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_curator" });
    expect(m.logEditDenial).toHaveBeenCalledWith({
      actorCwid: ACTOR,
      targetCwid: DEPT_A,
      path: "/api/edit/method-service",
      reason: "not_curator",
      targetEntityType: "department",
      targetEntityId: DEPT_A,
    });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
  });

  it("an editor of another department gets 403", async () => {
    grantDepartment(DEPT_B, "owner");
    const res = await call(CREATE);
    expect(res.status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("a core owner can, and a core curator can", async () => {
    for (const role of ["owner", "curator"]) {
      m.unitAdminFindUnique.mockResolvedValue({ role });
      const res = await call({ ...CREATE, entityType: "core", entityId: CORE });
      expect(res.status).toBe(200);
    }
    expect(m.unitAdminFindUnique).toHaveBeenCalledWith({
      where: { entityType_entityId_cwid: { entityType: "core", entityId: CORE, cwid: ACTOR } },
      select: { role: true },
    });
    expect(m.txCreate).toHaveBeenCalledTimes(2);
  });

  it("a Cores director can, with no grant on the core", async () => {
    const res = await call({ ...CREATE, entityType: "core", entityId: CORE }, { isCoreDirector: true });
    expect(res.status).toBe(200);
    expect(m.unitAdminFindUnique).not.toHaveBeenCalled();
  });

  it("a Cores director has no say over a department", async () => {
    const res = await call(CREATE, { isCoreDirector: true });
    expect(res.status).toBe(403);
  });

  it("an outsider to a core gets 403 not_core_owner, logged", async () => {
    const res = await call({ ...CREATE, entityType: "core", entityId: CORE });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
    expect(m.logEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_core_owner", targetEntityType: "core", targetEntityId: CORE }),
    );
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("a department grant with the core's id does not open the core", async () => {
    grantDepartment(CORE, "owner");
    const res = await call({ ...CREATE, entityType: "core", entityId: CORE });
    expect(res.status).toBe(403);
  });

  it.each([{ isSuperuser: true }, { isCommsSteward: true }, { isContentEditor: true }])(
    "%o can, on a department and on a core, with no grant",
    async (session) => {
      expect((await call(CREATE, session)).status).toBe(200);
      expect((await call({ ...CREATE, entityType: "core", entityId: CORE }, session)).status).toBe(200);
    },
  );
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
  it("a department A editor cannot update department B's row, even if the body names A", async () => {
    grantDepartment(DEPT_A, "owner");
    m.serviceFindUnique.mockResolvedValue(row({ entityId: DEPT_B }));
    const res = await call({ op: "update", id: 5, entityType: "department", entityId: DEPT_A, name: "Hijacked" });
    expect(res.status).toBe(403);
    expect(m.logEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ targetEntityType: "department", targetEntityId: DEPT_B }),
    );
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("a department A editor cannot delete department B's row, even if the body names A", async () => {
    grantDepartment(DEPT_A, "curator");
    m.serviceFindUnique.mockResolvedValue(row({ entityId: DEPT_B }));
    const res = await call({ op: "delete", id: 5, entityType: "department", entityId: DEPT_A });
    expect(res.status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("a department editor cannot touch a core's row by naming their department", async () => {
    grantDepartment(DEPT_A, "owner");
    m.serviceFindUnique.mockResolvedValue(row({ entityType: "core", entityId: CORE }));
    const res = await call({ op: "update", id: 5, entityType: "department", entityId: DEPT_A, name: "X" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
  });

  it("the row's own editor can update it, and the owner never changes", async () => {
    grantDepartment(DEPT_B, "curator");
    m.serviceFindUnique.mockResolvedValue(row({ entityId: DEPT_B }));
    const res = await call({ op: "update", id: 5, entityType: "core", entityId: CORE, name: "Renamed" });
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
    grantDepartment(DEPT_A, "owner");
    const res = await call({ op: "delete", id: 5 });
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

  it("an outsider cannot delete", async () => {
    const res = await call({ op: "delete", id: 5 });
    expect(res.status).toBe(403);
    expect(m.txDelete).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/method-service: exclude (Not ours) and restore (undo)", () => {
  beforeEach(() => grantDepartment(DEPT_A, "curator"));

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
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
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
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("an outsider gets 403 for exclude and for restore, logged, with no write", async () => {
    m.unitAdminFindMany.mockResolvedValue([]);
    for (const op of ["exclude", "restore"]) {
      const res = await call({ op, id: 5, pmid: "111" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "not_curator" });
    }
    expect(m.logEditDenial).toHaveBeenCalledTimes(2);
    expect(m.logEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: ACTOR, targetEntityType: "department", targetEntityId: DEPT_A }),
    );
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.appendAuditRow).not.toHaveBeenCalled();
  });

  it("is authorized against the STORED row: department A's editor cannot exclude from department B's service, whatever the body names", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ entityId: DEPT_B }));
    const res = await call({
      op: "exclude",
      id: 5,
      pmid: "111",
      entityType: "department",
      entityId: DEPT_A,
    });
    expect(res.status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("a department editor cannot exclude from a core's service", async () => {
    m.serviceFindUnique.mockResolvedValue(row({ entityType: "core", entityId: CORE }));
    const res = await call({ op: "exclude", id: 5, pmid: "111" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
    expect(m.transaction).not.toHaveBeenCalled();
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
  const REVIEW = { collaborations: 2, supportedListed: 2, supportedOnPage: 1, perMethod: [], marked: [], excluded: [] };
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
    expect((await get(query)).status).toBe(400);
    expect(m.serviceFindUnique).not.toHaveBeenCalled();
  });

  it("the unit's editor gets the review, uncached", async () => {
    grantDepartment(DEPT_A, "curator");
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, review: REVIEW });
    expect(m.loadServiceReview).toHaveBeenCalledWith(expect.objectContaining({ id: 5, entityId: DEPT_A }));
  });

  it("an outsider gets 403 and the review is never loaded", async () => {
    const res = await get();
    expect(res.status).toBe(403);
    expect(m.loadServiceReview).not.toHaveBeenCalled();
    expect(m.logEditDenial).toHaveBeenCalled();
  });

  it("is authorized against the stored row's unit, not the caller's", async () => {
    grantDepartment(DEPT_A, "owner");
    m.serviceFindUnique.mockResolvedValue(row({ entityId: DEPT_B }));
    expect((await get()).status).toBe(403);
    expect(m.loadServiceReview).not.toHaveBeenCalled();
  });

  it("an observer's read-only steward view does not open it, as it does not open a write", async () => {
    signIn({ isCommsSteward: true, isObserver: true });
    const res = await get();
    expect(res.status).toBe(403);
    expect(m.loadServiceReview).not.toHaveBeenCalled();
  });

  it("404s an id with no row", async () => {
    grantDepartment(DEPT_A, "curator");
    m.serviceFindUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("500s read_failed when the loader throws", async () => {
    grantDepartment(DEPT_A, "curator");
    m.loadServiceReview.mockRejectedValue(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
  });
});
