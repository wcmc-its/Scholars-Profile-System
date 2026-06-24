/**
 * POST /api/edit/core-claim/bulk — the scale companion to the single-claim route
 * (#1239). One request claims/rejects many pmids: the upsert + audit loop runs in
 * ONE transaction, writeback fans out best-effort after the commit. readEditRequest
 * is mocked to inject a parsed context; editOk/editError stay real so status codes
 * are exercised; the active-claim read (loadActiveCoreClaimsByCore) is exercised
 * for real against a mocked `coreClaim.findMany`. DB + audit + writeback are mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockReadEditRequest,
  mockCoreFindUnique,
  mockClaimFindMany,
  mockUnitAdminFindUnique,
  mockTransaction,
  mockClaimUpsert,
  mockAppendAuditRow,
  mockWriteBack,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockCoreFindUnique: vi.fn(),
  mockClaimFindMany: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockClaimUpsert: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockWriteBack: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/cores/claim-writeback", () => ({ writeBackCoreClaim: mockWriteBack }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      coreClaim: { findMany: mockClaimFindMany },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
    },
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/core-claim/bulk/route";

const ACTOR = "rev01";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/edit/core-claim/bulk", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
}

// Configure the injected request context for one call. Defaults to a superuser
// session (authz passes); `sessionOver` exercises the role-based / denied paths.
async function call(
  bodyOver: Record<string, unknown> = {},
  sessionOver: Record<string, unknown> = {},
) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: { cwid: ACTOR, isSuperuser: true, isCommsSteward: false, ...sessionOver },
      realCwid: ACTOR,
      impersonatedCwid: null,
      requestId: "req-1",
      body: { coreId: "2", pmids: ["1", "2", "3"], status: "claimed", ...bodyOver },
    },
  });
  return POST(req());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCoreFindUnique.mockResolvedValue({ id: "2" });
  mockUnitAdminFindUnique.mockResolvedValue(null); // role none; superuser session allows
  mockClaimFindMany.mockResolvedValue([]); // no prior active claims by default
  mockClaimUpsert.mockResolvedValue({});
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockWriteBack.mockResolvedValue({ ok: true, skipped: false });
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coreClaim: { upsert: mockClaimUpsert } }),
  );
});

describe("POST /api/edit/core-claim/bulk", () => {
  it("claims every pmid in one transaction + mirrors each to the engine after commit", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      coreId: "2",
      status: "claimed",
      written: 3,
      skipped: 0,
      writebackOk: 3,
    });
    // one transaction, one upsert + one audit row per pmid
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockClaimUpsert).toHaveBeenCalledTimes(3);
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(3);
    const upsert = mockClaimUpsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ pmid_coreId: { pmid: "1", coreId: "2" } });
    expect(upsert.create.status).toBe("claimed");
    // writeback runs once per written pmid (best-effort, after the commit)
    expect(mockWriteBack).toHaveBeenCalledTimes(3);
    const audit = mockAppendAuditRow.mock.calls[0][1];
    expect(audit.action).toBe("core_claim");
    expect(audit.afterValues).toEqual({ status: "claimed" });
    expect(audit.actorCwid).toBe(ACTOR);
    // the active-claim read is scoped to this core and excludes soft-revoked claims
    expect(mockClaimFindMany.mock.calls[0][0]).toMatchObject({
      where: { coreId: "2", revokedAt: null },
    });
  });

  it("rejects every pmid (status:'rejected') with the rejected upsert + audit + writeback", async () => {
    const res = await call({ pmids: ["1", "2"], status: "rejected" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "rejected", written: 2 });
    expect(mockClaimUpsert.mock.calls[0][0].create.status).toBe("rejected");
    expect(mockAppendAuditRow.mock.calls[0][1].afterValues).toEqual({ status: "rejected" });
    expect(mockWriteBack).toHaveBeenCalledWith({ pmid: "1", coreId: "2", status: "rejected" });
  });

  it("idempotently skips a pmid already at status:'rejected'", async () => {
    mockClaimFindMany.mockResolvedValue([{ pmid: "1", status: "rejected" }]);
    const res = await call({ pmids: ["1", "2"], status: "rejected" });
    expect(await res.json()).toMatchObject({ written: 1, skipped: 1 });
    expect(mockClaimUpsert).toHaveBeenCalledTimes(1);
    expect(mockClaimUpsert.mock.calls[0][0].where).toEqual({
      pmid_coreId: { pmid: "2", coreId: "2" },
    });
  });

  it("403s a non-superuser with no role on the core, before any write", async () => {
    mockUnitAdminFindUnique.mockResolvedValue(null); // no role
    const res = await call({}, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_core_owner" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("allows a non-superuser CURATOR of the core", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({ role: "curator" });
    const res = await call({ pmids: ["1"] }, { isSuperuser: false });
    expect(res.status).toBe(200);
    expect(mockClaimUpsert).toHaveBeenCalledTimes(1);
  });

  it("counts only successful writebacks (best-effort; a failure never fails the claim)", async () => {
    mockWriteBack
      .mockResolvedValueOnce({ ok: true, skipped: false })
      .mockRejectedValueOnce(new Error("ddb down"))
      .mockResolvedValueOnce({ ok: true, skipped: false });
    const res = await call(); // 3 pmids
    expect(res.status).toBe(200); // still 200 — writeback is advisory
    expect(await res.json()).toMatchObject({ written: 3, writebackOk: 2 });
  });

  it("skips pmids already at the target status (idempotent), writing only the rest", async () => {
    mockClaimFindMany.mockResolvedValue([{ pmid: "1", status: "claimed" }]);
    const res = await call({ pmids: ["1", "2"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: 1, skipped: 1 });
    expect(mockClaimUpsert).toHaveBeenCalledTimes(1);
    expect(mockClaimUpsert.mock.calls[0][0].where).toEqual({
      pmid_coreId: { pmid: "2", coreId: "2" },
    });
    // before-value reflects no prior active claim for pmid 2
    expect(mockAppendAuditRow.mock.calls[0][1].beforeValues).toBeNull();
  });

  it("de-dupes repeated pmids before writing", async () => {
    await call({ pmids: ["7", "7", "7"] });
    expect(mockClaimUpsert).toHaveBeenCalledTimes(1);
  });

  it("writes nothing (no transaction) when every pmid is already at the target status", async () => {
    mockClaimFindMany.mockResolvedValue([
      { pmid: "1", status: "claimed" },
      { pmid: "2", status: "claimed" },
      { pmid: "3", status: "claimed" },
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: 0, skipped: 3 });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("rejects an empty pmids array with 400 invalid_pmids", async () => {
    const res = await call({ pmids: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_pmids" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an over-cap batch (>500) with 400 invalid_pmids", async () => {
    const res = await call({ pmids: Array.from({ length: 501 }, (_, i) => String(i + 1)) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_pmids" });
  });

  it("rejects a malformed pmid with 400 invalid_pmids (before any DB write)", async () => {
    const res = await call({ pmids: ["1", "abc"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_pmids" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses 'revoked' as a bulk action with 400 invalid_status", async () => {
    const res = await call({ status: "revoked" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_status" });
  });

  it("404s when the core does not exist", async () => {
    mockCoreFindUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "core_not_found" });
  });

  it("returns 500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
