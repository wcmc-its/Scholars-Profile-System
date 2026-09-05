/**
 * POST/DELETE /api/edit/core-client — the "Known clients" CWID list
 * (ReciterAI #383 / SPS #2607, CWID-only pass). readEditRequest is mocked to
 * inject a parsed context; editOk/editError stay real so status codes are
 * exercised. DB + audit + engine writeback are mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const {
  mockReadEditRequest,
  mockCoreFindUnique,
  mockClientFindMany,
  mockTxFindMany,
  mockClientFindUnique,
  mockScholarFindMany,
  mockUnitAdminFindUnique,
  mockTransaction,
  mockClientUpsert,
  mockClientUpdate,
  mockAppendAuditRow,
  mockWriteBack,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockCoreFindUnique: vi.fn(),
  mockClientFindMany: vi.fn(),
  mockTxFindMany: vi.fn(),
  mockClientFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockClientUpsert: vi.fn(),
  mockClientUpdate: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockWriteBack: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/cores/client-writeback", () => ({ writeBackCoreClients: mockWriteBack }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      scholar: { findMany: mockScholarFindMany },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
    },
    write: {
      $transaction: mockTransaction,
      coreClient: { findMany: mockClientFindMany, findUnique: mockClientFindUnique },
    },
  },
}));

import { DELETE, POST } from "@/app/api/edit/core-client/route";

const ACTOR = "rev01";

function req(method: "POST" | "DELETE" = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/edit/core-client", {
    method,
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
}

function ctx(body: Record<string, unknown>, sessionOver: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    ctx: {
      session: { cwid: ACTOR, isSuperuser: true, isCommsSteward: false, ...sessionOver },
      realCwid: ACTOR,
      impersonatedCwid: null,
      requestId: "req-1",
      body,
    },
  };
}

async function post(body: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) {
  mockReadEditRequest.mockResolvedValue(
    ctx({ coreId: "2", cwids: ["djb2001"], ...body }, sessionOver),
  );
  return POST(req("POST"));
}

async function del(body: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) {
  mockReadEditRequest.mockResolvedValue(ctx({ coreId: "2", cwid: "djb2001", ...body }, sessionOver));
  return DELETE(req("DELETE"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCoreFindUnique.mockResolvedValue({ id: "2" });
  mockUnitAdminFindUnique.mockResolvedValue(null); // role none; superuser session allows
  mockClientFindMany.mockResolvedValue([]); // no prior active rows (db.write gating read) by default
  mockTxFindMany.mockResolvedValue([]); // empty in-tx mirror list by default
  mockClientFindUnique.mockResolvedValue({ removedAt: null }); // an active row exists (DELETE default)
  mockScholarFindMany.mockResolvedValue([]);
  mockClientUpsert.mockResolvedValue({});
  mockClientUpdate.mockResolvedValue({});
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockWriteBack.mockResolvedValue({ ok: true, skipped: false });
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      coreClient: { upsert: mockClientUpsert, update: mockClientUpdate, findMany: mockTxFindMany },
    }),
  );
});

describe("POST /api/edit/core-client", () => {
  it("401s (passthrough) when readEditRequest itself rejects the request", async () => {
    const unauth = NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    mockReadEditRequest.mockResolvedValue({ ok: false, response: unauth });
    const res = await POST(req("POST"));
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403s a non-superuser with no role on the core, before any write", async () => {
    const res = await post({}, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("allows a non-superuser CURATOR of the core", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({ role: "curator" });
    const res = await post({}, { isSuperuser: false });
    expect(res.status).toBe(200);
    expect(mockClientUpsert).toHaveBeenCalledTimes(1);
  });

  it("allows a comms_steward with no UnitAdmin row on the core", async () => {
    const res = await post({}, { isSuperuser: false, isCommsSteward: true });
    expect(res.status).toBe(200);
    expect(mockClientUpsert).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty cwids array with 400 invalid_cwids", async () => {
    const res = await post({ cwids: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cwids" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an over-cap batch (>500) with 400 invalid_cwids", async () => {
    const res = await post({ cwids: Array.from({ length: 501 }, (_, i) => `ab${i}`) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cwids" });
  });

  it("404s when the core does not exist", async () => {
    mockCoreFindUnique.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "core_not_found" });
  });

  it("adds a new CWID: upserts + audits (core_client_add) + mirrors the full active list", async () => {
    mockScholarFindMany.mockResolvedValue([
      { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon" },
    ]);
    mockClientFindMany.mockResolvedValueOnce([]); // pre-write active check (db.write, read-your-writes): none active yet
    // The tx mirror read gets its OWN, DISTINCT list — proves writeBackCoreClients
    // received the in-tx read, not whatever db.write/db.read findMany would return.
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "djb2001" }]);
    const res = await post({ cwids: ["DJB2001"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      added: [{ cwid: "djb2001", name: "Doug Ballon", slug: "doug-ballon" }],
      alreadyPresent: [],
      invalid: [],
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const upsert = mockClientUpsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ coreId_cwid: { coreId: "2", cwid: "djb2001" } });
    expect(upsert.update.removedBy).toBeNull();
    expect(upsert.update.removedAt).toBeNull();

    const audit = mockAppendAuditRow.mock.calls[0][1];
    expect(audit.action).toBe("core_client_add");
    expect(audit.targetEntityType).toBe("core");
    expect(audit.targetEntityId).toBe("2:djb2001");
    expect(audit.fieldsChanged).toEqual(["client"]);
    expect(audit.beforeValues).toEqual({ active: false });
    expect(audit.afterValues).toEqual({ active: true });
    expect(audit.actorCwid).toBe(ACTOR);

    // mirror runs AFTER the transaction, with the full post-write active list —
    // and that list must be the tx mock's DISTINCT list, not db.write's/db.read's.
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockWriteBack).toHaveBeenCalledWith({ coreId: "2", cwids: ["djb2001"] });
    expect(mockTxFindMany).toHaveBeenCalledTimes(1);
    const transactionOrder = mockTransaction.mock.invocationCallOrder[0];
    const upsertOrder = mockClientUpsert.mock.invocationCallOrder[0];
    const txFindManyOrder = mockTxFindMany.mock.invocationCallOrder[0];
    const writebackOrder = mockWriteBack.mock.invocationCallOrder[0];
    expect(txFindManyOrder).toBeGreaterThan(upsertOrder);
    expect(writebackOrder).toBeGreaterThan(transactionOrder);
  });

  it("re-adding a soft-removed CWID clears removedBy/removedAt (via the same upsert)", async () => {
    mockClientFindMany.mockResolvedValueOnce([]);
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "djb2001" }]);
    const res = await post({ cwids: ["djb2001"] });
    expect(res.status).toBe(200);
    const upsert = mockClientUpsert.mock.calls[0][0];
    expect(upsert.update).toMatchObject({ removedBy: null, removedAt: null, addedBy: ACTOR });
  });

  it("resolves slug: null for an added CWID with no Scholar row, and for one with no slug", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "djb2001", preferredName: "Doug Ballon", slug: null }]);
    mockClientFindMany.mockResolvedValueOnce([]);
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "djb2001" }]);
    const res = await post({ cwids: ["djb2001"] });
    expect(await res.json()).toMatchObject({
      added: [{ cwid: "djb2001", name: "Doug Ballon", slug: null }],
    });
  });

  it("reports an already-active CWID as alreadyPresent, writes nothing for it", async () => {
    mockClientFindMany.mockResolvedValueOnce([{ cwid: "djb2001" }]); // already active
    const res = await post({ cwids: ["djb2001"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: [], alreadyPresent: ["djb2001"], invalid: [] });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("reports a malformed token as invalid without rejecting the well-formed ones", async () => {
    mockClientFindMany.mockResolvedValueOnce([]);
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "djb2001" }]);
    const res = await post({ cwids: ["djb2001", "not-a-cwid"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      added: [{ cwid: "djb2001", name: null }],
      invalid: ["not-a-cwid"],
    });
  });

  it("writes nothing and never mirrors when every token is invalid", async () => {
    const res = await post({ cwids: ["not-a-cwid", "12345"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: [], alreadyPresent: [], invalid: ["not-a-cwid", "12345"] });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("returns 500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await post({ cwids: ["djb2001"] });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });

  it("a mirror failure is swallowed (advisory) and the add still 200s", async () => {
    mockClientFindMany.mockResolvedValueOnce([]);
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "djb2001" }]);
    mockWriteBack.mockRejectedValue(new Error("ddb down"));
    const res = await post({ cwids: ["djb2001"] });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/edit/core-client", () => {
  it("401s (passthrough) when readEditRequest itself rejects the request", async () => {
    const unauth = NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    mockReadEditRequest.mockResolvedValue({ ok: false, response: unauth });
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403s a non-superuser with no role on the core, before any write", async () => {
    const res = await del({}, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s a malformed cwid", async () => {
    const res = await del({ cwid: "not-a-cwid" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cwid" });
  });

  it("404s when the core does not exist", async () => {
    mockCoreFindUnique.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "core_not_found" });
  });

  it("404s when there is no active row for that CWID", async () => {
    mockClientFindUnique.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "client_not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s when the row exists but is already soft-removed", async () => {
    mockClientFindUnique.mockResolvedValue({ removedAt: new Date() });
    const res = await del();
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("soft-removes an active row: update + audit (core_client_remove) in one tx, then mirrors", async () => {
    // db.write's findMany is a stale/DISTINCT list that must NOT reach the
    // writeback — only the in-tx read (mockTxFindMany) may.
    mockClientFindMany.mockResolvedValue([{ cwid: "stale-should-not-be-used" }]);
    mockTxFindMany.mockResolvedValueOnce([]); // nothing left active after the removal, read INSIDE the tx
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true });

    const update = mockClientUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ coreId_cwid: { coreId: "2", cwid: "djb2001" } });
    expect(update.data.removedBy).toBe(ACTOR);
    expect(update.data.removedAt).toBeInstanceOf(Date);

    const audit = mockAppendAuditRow.mock.calls[0][1];
    expect(audit.action).toBe("core_client_remove");
    expect(audit.targetEntityType).toBe("core");
    expect(audit.targetEntityId).toBe("2:djb2001");
    expect(audit.fieldsChanged).toEqual(["client"]);
    expect(audit.beforeValues).toEqual({ active: true });
    expect(audit.afterValues).toEqual({ active: false });

    // mirror runs AFTER the transaction, with the tx mock's DISTINCT (empty)
    // remaining-active list — never db.write's/db.read's stale list.
    expect(mockWriteBack).toHaveBeenCalledWith({ coreId: "2", cwids: [] });
    expect(mockTxFindMany).toHaveBeenCalledTimes(1);
    const transactionOrder = mockTransaction.mock.invocationCallOrder[0];
    const updateOrder = mockClientUpdate.mock.invocationCallOrder[0];
    const txFindManyOrder = mockTxFindMany.mock.invocationCallOrder[0];
    const writebackOrder = mockWriteBack.mock.invocationCallOrder[0];
    expect(txFindManyOrder).toBeGreaterThan(updateOrder);
    expect(writebackOrder).toBeGreaterThan(transactionOrder);
  });

  it("returns 500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await del();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
