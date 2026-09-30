/**
 * POST /api/edit/center/[code]/nci-2a/accept — bulk Accept (report 2, PR 2b):
 * gated like the PATCH (403 before the body is read), 1–50 ids, one
 * transaction reading on the writer, one `cancer_funding_override` audit row
 * per accepted award with before === after, and human / no-percent / foreign
 * rows skipped and reported back. Fixture ids are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockTxFindMany,
  mockTxUpdateMany,
  mockAppendAuditRow,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTxFindMany: vi.fn(),
  mockTxUpdateMany: vi.fn(),
  mockAppendAuditRow: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await mockGetEditSession();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/audit")>()),
  appendAuditRow: mockAppendAuditRow,
}));

import { POST } from "@/app/api/edit/center/[code]/nci-2a/accept/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const CENTER = { code: "meyer_cancer_center" };
const fakeTx = {
  cancerCenterFundingAward: { findMany: mockTxFindMany, updateMany: mockTxUpdateMany },
};
const params = () => Promise.resolve({ code: CENTER.code });

function post(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/edit/center/${CENTER.code}/nci-2a/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockCenterFindUnique.mockResolvedValue(CENTER);
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: CENTER.code, role: "curator" },
  ]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxUpdateMany.mockResolvedValue({ count: 1 });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTxFindMany.mockResolvedValue([
    { id: "a1", cancerRelevantPercent: 40, cancerRelevantPercentSource: "llm" },
    { id: "a2", cancerRelevantPercent: 75, cancerRelevantPercentSource: "llm" },
    { id: "h1", cancerRelevantPercent: 60, cancerRelevantPercentSource: "human" },
    { id: "n1", cancerRelevantPercent: null, cancerRelevantPercentSource: "llm" },
  ]);
});

describe("POST /api/edit/center/[code]/nci-2a/accept", () => {
  it("403s a non-curator before looking at the body", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(post({ awardIds: "not-an-array" }), { params: params() });
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s an unknown center", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await POST(post({ awardIds: ["a1"] }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("400s an empty, malformed or over-cap id list", async () => {
    for (const awardIds of [[], "a1", [1], [""], Array.from({ length: 51 }, (_, i) => `x${i}`)]) {
      const res = await POST(post({ awardIds }), { params: params() });
      expect(res.status).toBe(400);
    }
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("takes exactly 50 ids, and counts duplicates once", async () => {
    mockTxFindMany.mockResolvedValue([]);
    const fifty = Array.from({ length: 50 }, (_, i) => `x${i}`);
    expect((await POST(post({ awardIds: fifty }), { params: params() })).status).toBe(200);
    const res = await POST(post({ awardIds: [...fifty, "x0"] }), { params: params() });
    expect(res.status).toBe(200);
  });

  it("accepts the AI rows in one transaction with one before===after audit row each; skips the rest", async () => {
    const res = await POST(post({ awardIds: ["a1", "h1", "n1", "zz", "a2"] }), {
      params: params(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toEqual([
      { awardId: "a1", cancerRelevantPercent: 40 },
      { awardId: "a2", cancerRelevantPercent: 75 },
    ]);
    expect(json.skipped).toEqual([
      { awardId: "h1", reason: "already_reviewed" },
      { awardId: "n1", reason: "no_percent" },
      { awardId: "zz", reason: "not_found" },
    ]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Read on the writer (inside the tx), scoped to this center.
    expect(mockTxFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ["a1", "h1", "n1", "zz", "a2"] },
      centerCode: CENTER.code,
    });
    expect(mockTxUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockTxUpdateMany.mock.calls[0][0]).toEqual({
      where: {
        id: "a1",
        centerCode: CENTER.code,
        cancerRelevantPercentSource: "llm",
        cancerRelevantPercent: 40,
      },
      data: { cancerRelevantPercentSource: "human" },
    });
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(2);
    const audit = mockAppendAuditRow.mock.calls[0][1];
    expect(audit).toMatchObject({
      action: "cancer_funding_override",
      targetEntityType: "cancer_funding_award",
      targetEntityId: "a1",
      actorCwid: "cur001",
      fieldsChanged: ["cancerRelevantPercent"],
      beforeValues: { cancerRelevantPercent: 40 },
      afterValues: { cancerRelevantPercent: 40 },
    });
  });

  it("a row a PATCH changed mid-flight matches nothing: skipped, no audit row", async () => {
    mockTxUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(post({ awardIds: ["a1"] }), { params: params() });
    const json = await res.json();
    expect(json.accepted).toEqual([]);
    expect(json.skipped).toEqual([{ awardId: "a1", reason: "already_reviewed" }]);
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("gives the transaction room for a full 50-id batch (not Prisma's 5 s default)", async () => {
    await POST(post({ awardIds: ["a1"] }), { params: params() });
    expect(mockTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it("500s when the transaction fails", async () => {
    mockAppendAuditRow.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(post({ awardIds: ["a1"] }), { params: params() });
    expect(res.status).toBe(500);
  });
});
