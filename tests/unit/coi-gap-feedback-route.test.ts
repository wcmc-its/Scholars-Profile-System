/**
 * POST /api/edit/coi-gap/[id]/feedback — the self-only 3-way response on a
 * publication-derived COI-gap suggestion (`SELF_EDIT_COI_GAP_HINT`, dormant).
 * Replaces the old binary dismiss.
 *
 * Verifies: the GENUINE-self authorization (403 for another scholar's candidate,
 * 403 while impersonating even the owner — a superuser "View as" must NOT record
 * feedback), 404 for a missing candidate, the dormant 503 (after authz, before
 * any write AND before the reason is validated), 400 invalid_reason for a
 * garbage/absent reason, the reason→(status, feedbackReason) mapping in a single
 * transaction (status + feedbackReason + reviewedAt + a B03 `coi_gap_feedback`
 * audit row), and idempotency.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEffectiveEditSession,
  mockGetSession,
  mockImpersonationActive,
  mockCandidateFindUnique,
  mockCandidateUpdate,
  mockTransaction,
  mockAppendAuditRow,
  mockLogEditDenial,
  mockIsCoiGapEnabled,
} = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockCandidateFindUnique: vi.fn(),
  mockCandidateUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockIsCoiGapEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEffectiveEditSession,
  impersonationActive: mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/session", () => ({ nowSeconds: () => 1_000 }));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/authz", async () => ({
  verifyRequestOrigin: () => ({ ok: true }),
  logEditDenial: mockLogEditDenial,
}));
vi.mock("@/lib/edit/coi-gap-hint", () => ({ isCoiGapHintEnabled: mockIsCoiGapEnabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { coiGapCandidate: { findUnique: mockCandidateFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/coi-gap/[id]/feedback/route";

const SELF = "self01";
const OTHER = "other9";
const ADMIN = "adm001";

function post(id: string, body: unknown = { reason: "invalid" }): NextRequest {
  return new NextRequest(`http://localhost/api/edit/coi-gap/${id}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function asGenuine(cwid: string) {
  mockGetEffectiveEditSession.mockResolvedValue({ cwid, isSuperuser: cwid === ADMIN });
  mockGetSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
  mockImpersonationActive.mockReturnValue(false);
}

function asImpersonating(realCwid: string, targetCwid: string) {
  mockGetEffectiveEditSession.mockResolvedValue({ cwid: targetCwid, isSuperuser: false });
  mockGetSession.mockResolvedValue({
    cwid: realCwid,
    iat: 0,
    exp: 0,
    impersonating: { targetCwid, startedAt: 900 },
  });
  mockImpersonationActive.mockReturnValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  asGenuine(SELF);
  mockIsCoiGapEnabled.mockReturnValue(true);
  mockCandidateFindUnique.mockResolvedValue({
    id: "gap-1",
    cwid: SELF,
    status: "new",
    feedbackReason: null,
  });
  mockCandidateUpdate.mockResolvedValue({ id: "gap-1" });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coiGapCandidate: { update: mockCandidateUpdate }, $executeRaw: vi.fn() }),
  );
});

describe("POST /api/edit/coi-gap/[id]/feedback", () => {
  it("400 invalid_id when the id is empty", async () => {
    const res = await POST(post(""), ctx(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_id" });
  });

  it("404 when the candidate does not exist", async () => {
    mockCandidateFindUnique.mockResolvedValue(null);
    const res = await POST(post("nope"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 when the candidate belongs to another scholar", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "gap-1",
      cwid: OTHER,
      status: "new",
      feedbackReason: null,
    });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockLogEditDenial).toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 while impersonating the owner — a superuser View-as cannot record feedback", async () => {
    asImpersonating(ADMIN, SELF);
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("200 — a genuine (non-impersonating) superuser may record on another scholar's candidate (operator decision)", async () => {
    asGenuine(ADMIN);
    mockCandidateFindUnique.mockResolvedValue({
      id: "gap-1",
      cwid: OTHER,
      status: "new",
      feedbackReason: null,
    });
    const res = await POST(post("gap-1", { reason: "historical" }), ctx("gap-1"));
    expect(res.status).toBe(200);
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("coi_gap_feedback");
    expect(row.actorCwid).toBe(ADMIN);
    expect(row.impersonatedCwid).toBeNull();
  });

  it("503 coi_gap_disabled when the flag is off (after authz, before any write or reason check)", async () => {
    mockIsCoiGapEnabled.mockReturnValue(false);
    const res = await POST(post("gap-1", { reason: "garbage" }), ctx("gap-1"));
    expect(res.status).toBe(503);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("an unauthorized call still 403s even when the flag is off (authz precedes the dormant gate)", async () => {
    mockIsCoiGapEnabled.mockReturnValue(false);
    mockCandidateFindUnique.mockResolvedValue({
      id: "gap-1",
      cwid: OTHER,
      status: "new",
      feedbackReason: null,
    });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
  });

  it("400 invalid_reason for an unknown reason", async () => {
    const res = await POST(post("gap-1", { reason: "nope" }), ctx("gap-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_reason", field: "reason" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 invalid_reason when reason is absent", async () => {
    const res = await POST(post("gap-1", {}), ctx("gap-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_reason" });
  });

  it.each([
    ["will_disclose", "acknowledged"],
    ["historical", "dismissed"],
    ["invalid", "dismissed"],
  ] as const)(
    "reason=%s persists status=%s + feedbackReason + a coi_gap_feedback audit row in one tx",
    async (reason, status) => {
      const res = await POST(post("gap-1", { reason }), ctx("gap-1"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status, reason });

      const update = mockCandidateUpdate.mock.calls[0][0];
      expect(update.where).toEqual({ id: "gap-1" });
      expect(update.data.status).toBe(status);
      expect(update.data.feedbackReason).toBe(reason);
      expect(update.data.reviewedAt).toBeInstanceOf(Date);

      const row = mockAppendAuditRow.mock.calls[0][1];
      expect(row.action).toBe("coi_gap_feedback");
      expect(row.fieldsChanged).toEqual(["status", "feedbackReason"]);
      expect(row.beforeValues).toEqual({ status: "new", feedbackReason: null });
      expect(row.afterValues).toEqual({ status, feedbackReason: reason });
    },
  );

  it("is idempotent — the candidate already holds exactly this feedback returns ok without re-writing", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "gap-1",
      cwid: SELF,
      status: "dismissed",
      feedbackReason: "invalid",
    });
    const res = await POST(post("gap-1", { reason: "invalid" }), ctx("gap-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "dismissed", reason: "invalid", unchanged: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("re-records a DIFFERENT reason over a prior one (change of mind) in a single write", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "gap-1",
      cwid: SELF,
      status: "dismissed",
      feedbackReason: "historical",
    });
    const res = await POST(post("gap-1", { reason: "invalid" }), ctx("gap-1"));
    expect(res.status).toBe(200);
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.beforeValues).toEqual({ status: "dismissed", feedbackReason: "historical" });
    expect(row.afterValues).toEqual({ status: "dismissed", feedbackReason: "invalid" });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("500 write_failed when the transaction throws (nothing leaked, no audit)", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
