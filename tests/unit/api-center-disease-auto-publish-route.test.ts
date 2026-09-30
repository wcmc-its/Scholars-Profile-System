/**
 * `POST /api/edit/center/[code]/disease-auto-publish` — a center's
 * "Auto-publish high-confidence inferences" switch. Same authz as the
 * disease-assignments route; one column write + one audit row per change.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockCenterFindUnique,
  mockCenterProgramFindFirst,
  mockUnitAdminFindMany,
  mockTransaction,
  mockTxCenterUpdate,
  mockAppendAuditRow,
  mockReadEditRequest,
} = vi.hoisted(() => ({
  mockCenterFindUnique: vi.fn(),
  mockCenterProgramFindFirst: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxCenterUpdate: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockReadEditRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      center: { findUnique: mockCenterFindUnique },
      centerProgram: { findFirst: mockCenterProgramFindFirst },
      unitAdmin: { findMany: mockUnitAdminFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));

import { POST } from "@/app/api/edit/center/[code]/disease-auto-publish/route";

const CODE = "meyer_cancer_center";
const CURATOR = { cwid: "cur1001", isSuperuser: false };
const fakeTx = { center: { update: mockTxCenterUpdate } };

function call(
  body: unknown,
  opts?: { session?: { cwid: string; isSuperuser: boolean }; realCwid?: string; impersonatedCwid?: string | null },
) {
  const session = opts?.session ?? CURATOR;
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session,
      realCwid: opts?.realCwid ?? session.cwid,
      impersonatedCwid: opts?.impersonatedCwid ?? null,
      body,
      requestId: "req-1",
    },
  });
  const req = new NextRequest(`http://localhost/api/edit/center/${CODE}/disease-auto-publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ code: CODE }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockCenterFindUnique.mockResolvedValue({ code: CODE, diseaseAutoPublish: true });
  mockCenterProgramFindFirst.mockResolvedValue({ code: "BR" });
  mockUnitAdminFindMany.mockResolvedValue([{ entityType: "center", entityId: CODE, role: "curator" }]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxCenterUpdate.mockResolvedValue({});
  mockAppendAuditRow.mockResolvedValue(undefined);
});

describe("POST /api/edit/center/[code]/disease-auto-publish", () => {
  it("turns the switch off: one column write and one audit row, in one transaction", async () => {
    const res = await call({ enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: CODE, enabled: false, changed: true });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith({ where: { code: CODE }, data: { diseaseAutoPublish: false } });
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditRow.mock.calls[0][0]).toBe(fakeTx);
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      actorCwid: "cur1001",
      impersonatedCwid: null,
      targetEntityType: "center",
      targetEntityId: CODE,
      action: "disease_auto_publish_set",
      fieldsChanged: ["diseaseAutoPublish"],
      beforeValues: { diseaseAutoPublish: true },
      afterValues: { diseaseAutoPublish: false },
      requestId: "req-1",
    });
  });

  it("turns it back on", async () => {
    mockCenterFindUnique.mockResolvedValue({ code: CODE, diseaseAutoPublish: false });
    const res = await call({ enabled: true });
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith({ where: { code: CODE }, data: { diseaseAutoPublish: true } });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      beforeValues: { diseaseAutoPublish: false },
      afterValues: { diseaseAutoPublish: true },
    });
  });

  it("setting the value it already has writes nothing and audits nothing", async () => {
    const res = await call({ enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("audits the REAL actor, with the impersonated cwid in its own column", async () => {
    await call({ enabled: false }, { session: { cwid: "sup0001", isSuperuser: true }, realCwid: "sup0001", impersonatedCwid: "cur1001" });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({ actorCwid: "sup0001", impersonatedCwid: "cur1001" });
  });

  it.each([[{}], [{ enabled: "false" }], [{ enabled: 1 }], [{ enabled: null }]])(
    "400 invalid_enabled for %j, before any read",
    async (body) => {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "invalid_enabled" });
      expect(mockCenterFindUnique).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  it("400 unit_not_found for an unknown center", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await call({ enabled: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unit_not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 no_program_taxonomy for a center without programs (the Cancer-Center-only gate)", async () => {
    mockCenterProgramFindFirst.mockResolvedValue(null);
    const res = await call({ enabled: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_program_taxonomy" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 for an actor with no role on this center", async () => {
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await call({ enabled: false });
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("403 for a curator of a DIFFERENT center", async () => {
    // Apply the query's own (entityType, entityId) OR filter, as MySQL would.
    const rows = [{ entityType: "center", entityId: "other_center", role: "curator" }];
    mockUnitAdminFindMany.mockImplementation(
      async (args: { where: { OR: Array<{ entityType: string; entityId: string }> } }) =>
        rows.filter((r) => args.where.OR.some((l) => l.entityType === r.entityType && l.entityId === r.entityId)),
    );
    const res = await call({ enabled: false });
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a superuser may flip it with no unit role", async () => {
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await call({ enabled: false }, { session: { cwid: "sup0001", isSuperuser: true } });
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledTimes(1);
  });

  it("500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("boom"));
    const res = await call({ enabled: false });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "write_failed" });
  });
});
