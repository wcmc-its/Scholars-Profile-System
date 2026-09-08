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
  mockClientFindFirst,
  mockClientCreate,
  mockReadClientFindMany,
  mockFetchDirectory,
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
  mockClientFindFirst: vi.fn(),
  mockClientCreate: vi.fn(),
  mockReadClientFindMany: vi.fn(),
  mockFetchDirectory: vi.fn(),
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
vi.mock("@/lib/sources/ldap", () => ({ fetchDirectoryPeopleByCwid: mockFetchDirectory }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      scholar: { findMany: mockScholarFindMany },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
      coreClient: { findMany: mockReadClientFindMany },
    },
    write: {
      $transaction: mockTransaction,
      coreClient: {
        findMany: mockClientFindMany,
        findFirst: mockClientFindFirst,
        create: mockClientCreate,
      },
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
  mockClientFindFirst.mockResolvedValue({ id: "row-1", cwid: "djb2001", removedAt: null }); // an active row exists (DELETE default)
  mockScholarFindMany.mockResolvedValue([]);
  mockReadClientFindMany.mockResolvedValue([]); // no active roster rows (lookup + POST id read)
  mockFetchDirectory.mockResolvedValue([]); // ED knows nobody by default
  mockClientCreate.mockResolvedValue({ id: "row-new" });
  mockClientUpsert.mockResolvedValue({ id: "row-upserted" });
  mockClientUpdate.mockResolvedValue({});
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockWriteBack.mockResolvedValue({ ok: true, skipped: false });
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      coreClient: {
        upsert: mockClientUpsert,
        update: mockClientUpdate,
        findMany: mockTxFindMany,
        create: mockClientCreate,
      },
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
    mockClientFindFirst.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "client_not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s when the row exists but is already soft-removed", async () => {
    mockClientFindFirst.mockResolvedValue({ id: "row-1", cwid: "djb2001", removedAt: new Date() });
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
    // Updates by row id now — the probe above resolved it, and a name-only row
    // has no (coreId, cwid) pair to address.
    expect(update.where).toEqual({ id: "row-1" });
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

describe('POST /api/edit/core-client — mode: "lookup"', () => {
  it("resolves Scholars first, falls back to the enterprise directory, and WRITES NOTHING", async () => {
    mockScholarFindMany.mockResolvedValue([
      { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon", primaryDepartment: "Radiology" },
    ]);
    mockFetchDirectory.mockResolvedValue([
      { cwid: "ab1234", name: "Al Best", dept: "Research Computing", title: null, firstName: null, lastName: null, email: null },
    ]);
    const res = await post({ cwids: ["djb2001", "ab1234"], mode: "lookup" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: "lookup",
      resolved: [
        { cwid: "djb2001", name: "Doug Ballon", dept: "Radiology", source: "scholars", alreadyPresent: false },
        { cwid: "ab1234", name: "Al Best", dept: "Research Computing", slug: null, source: "directory", alreadyPresent: false },
      ],
    });
    // The whole point of a lookup: no transaction, no upsert, no mirror.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockClientUpsert).not.toHaveBeenCalled();
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("only asks the directory about CWIDs Scholars did not resolve", async () => {
    mockScholarFindMany.mockResolvedValue([
      { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon", primaryDepartment: null },
    ]);
    await post({ cwids: ["djb2001", "ab1234"], mode: "lookup" });
    expect(mockFetchDirectory).toHaveBeenCalledWith(["ab1234"]);
  });

  it("skips the directory entirely when Scholars resolved everyone", async () => {
    mockScholarFindMany.mockResolvedValue([
      { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon", primaryDepartment: null },
    ]);
    await post({ cwids: ["djb2001"], mode: "lookup" });
    expect(mockFetchDirectory).not.toHaveBeenCalled();
  });

  it("degrades to Scholars-only when the directory throws — a lookup must not fail on an ED outage", async () => {
    mockScholarFindMany.mockResolvedValue([]);
    mockFetchDirectory.mockRejectedValue(new Error("ldap down"));
    const res = await post({ cwids: ["ab1234"], mode: "lookup" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resolved: [{ cwid: "ab1234", name: null, source: null }],
    });
  });

  it("flags a CWID already on this core's active roster", async () => {
    mockScholarFindMany.mockResolvedValue([
      { cwid: "djb2001", preferredName: "Doug Ballon", slug: "doug-ballon", primaryDepartment: null },
    ]);
    mockReadClientFindMany.mockResolvedValue([{ cwid: "djb2001" }]);
    const res = await post({ cwids: ["djb2001"], mode: "lookup" });
    expect(await res.json()).toMatchObject({ resolved: [{ alreadyPresent: true }] });
  });

  it("still runs the authorization gate — a lookup is not a public directory probe", async () => {
    const res = await post({ cwids: ["djb2001"], mode: "lookup" }, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(mockFetchDirectory).not.toHaveBeenCalled();
  });
});

describe('POST /api/edit/core-client — mode: "name"', () => {
  it("creates a cwid-less row, audits it as core_client_add, and mirrors NOTHING", async () => {
    const res = await post({
      mode: "name",
      displayName: "  Ada Lovelace  ",
      affiliation: "Analytical Engines",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      added: [{ id: "row-new", cwid: null, name: "Ada Lovelace", affiliation: "Analytical Engines" }],
    });
    expect(mockClientCreate).toHaveBeenCalledTimes(1);
    expect(mockClientCreate.mock.calls[0][0].data).toMatchObject({
      coreId: "2",
      cwid: null,
      displayName: "Ada Lovelace",
      affiliation: "Analytical Engines",
    });
    const audit = mockAppendAuditRow.mock.calls[0][1];
    expect(audit).toMatchObject({
      action: "core_client_add",
      targetEntityType: "core",
      targetEntityId: "2:row-new",
    });
    // No CWID means nothing for the engine to match — the mirror is untouched.
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("stores a blank affiliation as null rather than an empty string", async () => {
    await post({ mode: "name", displayName: "Ada Lovelace", affiliation: "   " });
    expect(mockClientCreate.mock.calls[0][0].data.affiliation).toBeNull();
  });

  it("400s on a missing or over-long display name", async () => {
    expect((await post({ mode: "name", displayName: "   " })).status).toBe(400);
    expect((await post({ mode: "name", displayName: 42 })).status).toBe(400);
    expect((await post({ mode: "name", displayName: "x".repeat(256) })).status).toBe(400);
    expect(mockClientCreate).not.toHaveBeenCalled();
  });

  it("rejects a case-insensitive duplicate name without writing", async () => {
    mockClientFindMany.mockResolvedValue([{ id: "row-1", displayName: "Ada Lovelace" }]);
    const res = await post({ mode: "name", displayName: "  ada LOVELACE " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: [], alreadyPresent: ["ada LOVELACE"] });
    expect(mockClientCreate).not.toHaveBeenCalled();
  });

  it("403s a non-owner before it writes", async () => {
    const res = await post({ mode: "name", displayName: "Ada Lovelace" }, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(mockClientCreate).not.toHaveBeenCalled();
  });
});

describe("engine mirror excludes name-only rows", () => {
  it("filters cwid: null out of the list it mirrors after a CWID add", async () => {
    // The in-transaction re-read returns the FULL active roster, name-only rows
    // included; only the mirror drops them.
    mockTxFindMany.mockResolvedValue([{ cwid: "djb2001" }, { cwid: null }, { cwid: "jx2001" }]);
    await post({ cwids: ["djb2001"] });
    expect(mockWriteBack).toHaveBeenCalledWith({ coreId: "2", cwids: ["djb2001", "jx2001"] });
  });

  it("filters them out on the remove path too", async () => {
    mockTxFindMany.mockResolvedValue([{ cwid: null }, { cwid: "jx2001" }]);
    await del();
    expect(mockWriteBack).toHaveBeenCalledWith({ coreId: "2", cwids: ["jx2001"] });
  });
});

describe("DELETE by row id — the only handle that reaches a name-only client", () => {
  it("probes and removes by id, scoped to the core", async () => {
    mockClientFindFirst.mockResolvedValue({ id: "row-3", cwid: null, removedAt: null });
    const res = await del({ id: "row-3", cwid: undefined });
    expect(res.status).toBe(200);
    expect(mockClientFindFirst.mock.calls[0][0].where).toEqual({ id: "row-3", coreId: "2" });
    expect(mockClientUpdate.mock.calls[0][0].where).toEqual({ id: "row-3" });
    const audit = mockAppendAuditRow.mock.calls[0][1];
    expect(audit).toMatchObject({ action: "core_client_remove", targetEntityId: "2:row-3" });
  });

  it("404s when the id belongs to another core — an id alone must not cross the authz boundary", async () => {
    mockClientFindFirst.mockResolvedValue(null);
    const res = await del({ id: "row-elsewhere", cwid: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "client_not_found" });
    expect(mockClientUpdate).not.toHaveBeenCalled();
  });
});

describe("regressions found in adversarial review", () => {
  it("takes the added row id from the WRITE, never a replica read", async () => {
    // db.read is a separate client bound to the Aurora READER; a read-your-writes
    // read there raced replica lag in prod (staging has no reader), came back
    // empty, and left the row keyed on its cwid so Remove 404'd forever.
    mockClientUpsert.mockResolvedValue({ id: "row-from-write" });
    mockReadClientFindMany.mockResolvedValue([]); // a fully lagged replica
    const res = await post({ cwids: ["djb2001"] });
    expect(await res.json()).toMatchObject({ added: [{ cwid: "djb2001", id: "row-from-write" }] });
    // The upsert must ask for the id, or there is nothing to take.
    expect(mockClientUpsert.mock.calls[0][0].select).toEqual({ id: true });
  });

  it("pairs a CWID client's remove audit with its add — by cwid, not the row id", async () => {
    // The panel always removes BY ID, so keying the audit on the id would break
    // add/remove pairing for every CWID client in the audit log.
    mockClientFindFirst.mockResolvedValue({ id: "row-1", cwid: "djb2001", removedAt: null });
    await del({ id: "row-1", cwid: undefined });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "core_client_remove",
      targetEntityId: "2:djb2001",
    });
  });

  it("falls back to the row id in the audit only for a NAME-ONLY row", async () => {
    mockClientFindFirst.mockResolvedValue({ id: "row-3", cwid: null, removedAt: null });
    await del({ id: "row-3", cwid: undefined });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({ targetEntityId: "2:row-3" });
  });

  it("caps the PARSED cwid count, not just the array length", async () => {
    // One array element can carry a whole pasted block, so the array-length cap
    // alone let 500 strings x 100 cwids through — and in lookup mode that fans
    // out to that many sequential LDAP searches.
    const oneBigBlock = [Array.from({ length: 501 }, (_, i) => `ab${1000 + i}`).join(" ")];
    const res = await post({ cwids: oneBigBlock });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cwids" });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockFetchDirectory).not.toHaveBeenCalled();
  });

  it("blocks a name-only duplicate that differs only by internal whitespace", async () => {
    // HTML collapses the run, so both rows would render identically and the
    // owner could not tell them apart. The unique index cannot catch it.
    mockClientFindMany.mockResolvedValue([
      { id: "row-1", displayName: "Ada Lovelace", affiliation: null },
    ]);
    const res = await post({ mode: "name", displayName: "Ada   Lovelace" });
    expect(await res.json()).toMatchObject({ added: [] });
    expect(mockClientCreate).not.toHaveBeenCalled();
  });

  it("matches an ALREADY-STORED name that carries internal whitespace", async () => {
    // The incoming name is collapsed on the way in, so the normalizer only earns
    // its keep on the STORED side — a row written before this change (or by any
    // other path) can still hold "Ada  Lovelace", and must still be recognised.
    mockClientFindMany.mockResolvedValue([
      { id: "row-1", displayName: "Ada  Lovelace", affiliation: null },
    ]);
    const res = await post({ mode: "name", displayName: "Ada Lovelace" });
    expect(await res.json()).toMatchObject({ added: [] });
    expect(mockClientCreate).not.toHaveBeenCalled();
  });

  it("matches a stored AFFILIATION that carries internal whitespace", async () => {
    mockClientFindMany.mockResolvedValue([
      { id: "row-1", displayName: "Ada Lovelace", affiliation: "Analytical   Engines" },
    ]);
    const res = await post({
      mode: "name",
      displayName: "Ada Lovelace",
      affiliation: "Analytical Engines",
    });
    expect(await res.json()).toMatchObject({ added: [] });
    expect(mockClientCreate).not.toHaveBeenCalled();
  });

  it("stores the collapsed name, so what is written matches what was compared", async () => {
    await post({ mode: "name", displayName: "  Ada   Lovelace  " });
    expect(mockClientCreate.mock.calls[0][0].data.displayName).toBe("Ada Lovelace");
  });

  it("lets the affiliation disambiguate two real people who share a name", async () => {
    mockClientFindMany.mockResolvedValue([
      { id: "row-1", displayName: "Ada Lovelace", affiliation: "MIT" },
    ]);
    const res = await post({
      mode: "name",
      displayName: "Ada Lovelace",
      affiliation: "Cornell",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: [{ name: "Ada Lovelace" }] });
    expect(mockClientCreate).toHaveBeenCalledTimes(1);
  });

  it("still blocks the exact same name AND affiliation", async () => {
    mockClientFindMany.mockResolvedValue([
      { id: "row-1", displayName: "Ada Lovelace", affiliation: "MIT" },
    ]);
    const res = await post({ mode: "name", displayName: "ada lovelace", affiliation: " MIT " });
    expect(await res.json()).toMatchObject({ added: [] });
    expect(mockClientCreate).not.toHaveBeenCalled();
  });

  it("scopes the name-only duplicate probe to this core's ACTIVE cwid-less rows", async () => {
    await post({ mode: "name", displayName: "Ada Lovelace" });
    expect(mockClientFindMany.mock.calls[0][0].where).toEqual({
      coreId: "2",
      cwid: null,
      removedAt: null,
    });
  });

  it("scopes the DELETE-by-id probe to this core", async () => {
    // Asserting the WHERE, not the mock's return: the mock answers whatever it
    // is asked, so a dropped coreId scope would still return a row and pass.
    mockClientFindFirst.mockResolvedValue({ id: "row-3", cwid: null, removedAt: null });
    await del({ id: "row-3", cwid: undefined });
    expect(mockClientFindFirst.mock.calls[0][0].where).toEqual({ id: "row-3", coreId: "2" });
  });
});
