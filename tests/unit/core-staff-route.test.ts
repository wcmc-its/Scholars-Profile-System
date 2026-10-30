/**
 * POST/DELETE /api/edit/core-staff: a core's curated staff list.
 * readEditRequest is mocked to inject a parsed context; editOk/editError stay
 * real so status codes are exercised. DB + audit + engine writeback are mocked.
 * Fake CWIDs only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const {
  mockReadEditRequest,
  mockCoreFindUnique,
  mockUnitAdminFindUnique,
  mockStaffFindMany,
  mockStaffFindUnique,
  mockTransaction,
  mockTxCreate,
  mockTxDelete,
  mockTxFindMany,
  mockAppendAuditRow,
  mockWriteBack,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockCoreFindUnique: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockStaffFindMany: vi.fn(),
  mockStaffFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxCreate: vi.fn(),
  mockTxDelete: vi.fn(),
  mockTxFindMany: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockWriteBack: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/cores/staff-writeback", () => ({ writeBackCoreStaff: mockWriteBack }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
    },
    write: {
      $transaction: mockTransaction,
      coreStaff: { findMany: mockStaffFindMany, findUnique: mockStaffFindUnique },
    },
  },
}));

import { DELETE, POST } from "@/app/api/edit/core-staff/route";

const ACTOR = "own0001";

function req(method: "POST" | "DELETE"): NextRequest {
  return new NextRequest("http://localhost/api/edit/core-staff", {
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
    ctx({ coreId: "2", cwids: ["abc1234"], ...body }, sessionOver),
  );
  return POST(req("POST"));
}

async function del(body: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) {
  mockReadEditRequest.mockResolvedValue(
    ctx({ coreId: "2", cwid: "abc1234", ...body }, sessionOver),
  );
  return DELETE(req("DELETE"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCoreFindUnique.mockResolvedValue({ id: "2" });
  mockUnitAdminFindUnique.mockResolvedValue(null); // role none; superuser session allows
  mockStaffFindMany.mockResolvedValue([]); // nobody on the list yet
  mockStaffFindUnique.mockResolvedValue({ cwid: "abc1234" }); // DELETE default: on the list
  mockTxCreate.mockResolvedValue({});
  mockTxDelete.mockResolvedValue({});
  mockTxFindMany.mockResolvedValue([]);
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockWriteBack.mockResolvedValue({ ok: true, skipped: false });
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coreStaff: { create: mockTxCreate, delete: mockTxDelete, findMany: mockTxFindMany } }),
  );
});

describe("POST /api/edit/core-staff", () => {
  it("passes through a readEditRequest rejection (401)", async () => {
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

  it("allows a per-core OWNER", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({ role: "owner" });
    const res = await post({}, { isSuperuser: false });
    expect(res.status).toBe(200);
    expect(mockTxCreate).toHaveBeenCalledTimes(1);
  });

  it("allows a Cores director with no UnitAdmin row (Owner of every core)", async () => {
    const res = await post({}, { isSuperuser: false, isCoreDirector: true });
    expect(res.status).toBe(200);
    expect(mockUnitAdminFindUnique).not.toHaveBeenCalled();
    expect(mockTxCreate).toHaveBeenCalledTimes(1);
  });

  it("allows a comms_steward with no UnitAdmin row", async () => {
    const res = await post({}, { isSuperuser: false, isCommsSteward: true });
    expect(res.status).toBe(200);
  });

  it("400s a missing coreId, an empty list, and an over-cap list", async () => {
    expect((await post({ coreId: "" })).status).toBe(400);
    const empty = await post({ cwids: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "invalid_cwids" });
    const over = await post({ cwids: Array.from({ length: 501 }, (_, i) => `ab${i}`) });
    expect(over.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s a single element that parses out to more than the cap", async () => {
    const block = Array.from({ length: 501 }, (_, i) => `ab${i}`).join(" ");
    const res = await post({ cwids: [block] });
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s when the core does not exist", async () => {
    mockCoreFindUnique.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "core_not_found" });
  });

  it("adds new CWIDs: creates + audits core_staff_add + mirrors the IN-TX full list", async () => {
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "abc1234" }, { cwid: "old0001" }]);
    const res = await post({ cwids: ["ABC1234, bad-token"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      added: ["abc1234"],
      alreadyPresent: [],
      invalid: ["bad-token"],
    });
    expect(mockTxCreate).toHaveBeenCalledWith({
      data: { coreId: "2", cwid: "abc1234", addedBy: ACTOR, createdAt: expect.any(Date) },
    });
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "core_staff_add",
      targetEntityType: "core",
      targetEntityId: "2:abc1234",
      beforeValues: { active: false },
      afterValues: { active: true },
      actorCwid: ACTOR,
      requestId: "req-1",
    });
    expect(mockWriteBack).toHaveBeenCalledWith({ coreId: "2", cwids: ["abc1234", "old0001"] });
  });

  it("reports CWIDs already listed without writing or mirroring", async () => {
    mockStaffFindMany.mockResolvedValue([{ cwid: "abc1234" }]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: [], alreadyPresent: ["abc1234"] });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("a writeback that throws never fails the committed write", async () => {
    mockWriteBack.mockRejectedValue(new Error("ddb down"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: ["abc1234"] });
  });

  it("500s write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
    expect(mockWriteBack).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/edit/core-staff", () => {
  it("403s a non-owner before any write", async () => {
    const res = await del({}, { isSuperuser: false });
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s a malformed cwid", async () => {
    const res = await del({ cwid: "not a cwid" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_cwid" });
  });

  it("404s a CWID not on the list", async () => {
    mockStaffFindUnique.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "staff_not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("removes: deletes + audits core_staff_remove + mirrors the remaining list", async () => {
    mockTxFindMany.mockResolvedValueOnce([{ cwid: "old0001" }]);
    const res = await del({ cwid: "ABC1234" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true });
    expect(mockStaffFindUnique).toHaveBeenCalledWith({
      where: { coreId_cwid: { coreId: "2", cwid: "abc1234" } },
      select: { cwid: true },
    });
    expect(mockTxDelete).toHaveBeenCalledWith({
      where: { coreId_cwid: { coreId: "2", cwid: "abc1234" } },
    });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "core_staff_remove",
      targetEntityId: "2:abc1234",
      beforeValues: { active: true },
      afterValues: { active: false },
    });
    expect(mockWriteBack).toHaveBeenCalledWith({ coreId: "2", cwids: ["old0001"] });
  });
});
