/**
 * POST /api/edit/coi-gap/[id]/dismiss — the self-only disavow of a
 * publication-derived COI-gap candidate (`SELF_EDIT_COI_GAP_HINT`, dormant).
 *
 * Mirrors `reject-route.test.ts`. Verifies: the GENUINE-self authorization
 * (403 when the candidate belongs to someone else, 403 while impersonating even
 * the owner — a superuser "View as" must NOT be able to dismiss), the 404 for a
 * missing candidate, the dormant 503 (placed after authz, before any write), the
 * single-transaction write (status→dismissed + reviewedAt + a B03
 * `coi_gap_dismiss` audit row), and idempotency.
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
vi.mock("@/lib/edit/authz", async () => {
  // verifyRequestOrigin is consumed by readEditRequest; keep the real same-origin
  // check happy by returning ok, and stub logEditDenial.
  return {
    verifyRequestOrigin: () => ({ ok: true }),
    logEditDenial: mockLogEditDenial,
  };
});
vi.mock("@/lib/edit/coi-gap-hint", () => ({ isCoiGapHintEnabled: mockIsCoiGapEnabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { coiGapCandidate: { findUnique: mockCandidateFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/coi-gap/[id]/dismiss/route";

const SELF = "self01";
const OTHER = "other9";
const ADMIN = "adm001";

function post(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/edit/coi-gap/${id}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Configure the session as a genuine (non-impersonating) self viewer. */
function asGenuine(cwid: string) {
  mockGetEffectiveEditSession.mockResolvedValue({ cwid, isSuperuser: cwid === ADMIN });
  mockGetSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
  mockImpersonationActive.mockReturnValue(false);
}

/** Configure the session as a superuser impersonating `targetCwid` via "View as". */
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
  mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: SELF, status: "new" });
  mockCandidateUpdate.mockResolvedValue({ id: "gap-1" });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coiGapCandidate: { update: mockCandidateUpdate }, $executeRaw: vi.fn() }),
  );
});

describe("POST /api/edit/coi-gap/[id]/dismiss", () => {
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
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: OTHER, status: "new" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockLogEditDenial).toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 while impersonating the owner — a superuser View-as cannot dismiss", async () => {
    // Superuser ADMIN impersonating the owner SELF; the candidate IS SELF's, but
    // the real human is the superuser, so genuine-self fails.
    asImpersonating(ADMIN, SELF);
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: SELF, status: "new" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("503 coi_gap_disabled when the flag is off (after authz, before any write)", async () => {
    mockIsCoiGapEnabled.mockReturnValue(false);
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "coi_gap_disabled" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("an unauthorized call still 403s even when the flag is off (authz precedes the dormant gate)", async () => {
    mockIsCoiGapEnabled.mockReturnValue(false);
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: OTHER, status: "new" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
  });

  it("is idempotent — an already-dismissed candidate returns ok without re-writing", async () => {
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: SELF, status: "dismissed" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "dismissed", alreadyDismissed: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("commits status=dismissed + reviewedAt + a coi_gap_dismiss audit row in one tx", async () => {
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "dismissed" });

    const update = mockCandidateUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: "gap-1" });
    expect(update.data.status).toBe("dismissed");
    expect(update.data.reviewedAt).toBeInstanceOf(Date);

    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("coi_gap_dismiss");
    expect(row.targetEntityType).toBe("coi_gap_candidate");
    expect(row.targetEntityId).toBe("gap-1");
    expect(row.actorCwid).toBe(SELF);
    expect(row.impersonatedCwid).toBeNull();
    expect(row.beforeValues).toEqual({ status: "new" });
    expect(row.afterValues).toEqual({ status: "dismissed" });
  });

  it("500 write_failed when the transaction throws (nothing leaked, no audit)", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
