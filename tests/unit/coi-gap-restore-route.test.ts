/**
 * POST /api/edit/coi-gap/[id]/restore — the self-only UNDO of a COI-gap
 * dismissal (`SELF_EDIT_COI_GAP_HINT`, dormant). The inverse of the dismiss
 * route; shares its GENUINE-self authorization and dormant gate.
 *
 * Verifies: 403 when the candidate belongs to someone else, 403 while
 * impersonating even the owner (a "View as" superuser must NOT be able to undo),
 * 404 for a missing candidate, the dormant 503 (after authz, before any write),
 * the single-transaction write (status→new + a B03 `coi_gap_restore` audit row),
 * and idempotency when the candidate is not currently dismissed.
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

import { POST } from "@/app/api/edit/coi-gap/[id]/restore/route";

const SELF = "self01";
const OTHER = "other9";
const ADMIN = "adm001";

function post(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/edit/coi-gap/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
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
  // Default: a currently-dismissed candidate owned by SELF.
  mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: SELF, status: "dismissed" });
  mockCandidateUpdate.mockResolvedValue({ id: "gap-1" });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coiGapCandidate: { update: mockCandidateUpdate }, $executeRaw: vi.fn() }),
  );
});

describe("POST /api/edit/coi-gap/[id]/restore", () => {
  it("403 when the candidate belongs to another scholar", async () => {
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: OTHER, status: "dismissed" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 while impersonating the owner — a superuser View-as cannot undo", async () => {
    asImpersonating(ADMIN, SELF);
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("200 — a genuine (non-impersonating) superuser may restore another scholar's candidate (operator decision)", async () => {
    asGenuine(ADMIN); // { cwid: ADMIN, isSuperuser: true }, no impersonation
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: OTHER, status: "dismissed" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "new" });
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("coi_gap_restore");
    expect(row.actorCwid).toBe(ADMIN);
    expect(row.impersonatedCwid).toBeNull();
  });

  it("404 when the candidate does not exist", async () => {
    mockCandidateFindUnique.mockResolvedValue(null);
    const res = await POST(post("nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("503 coi_gap_disabled when the flag is off (after authz, before any write)", async () => {
    mockIsCoiGapEnabled.mockReturnValue(false);
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(503);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("is idempotent — a candidate that is not dismissed returns ok without re-writing", async () => {
    mockCandidateFindUnique.mockResolvedValue({ id: "gap-1", cwid: SELF, status: "new" });
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "new", alreadyActive: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("commits status=new + a coi_gap_restore audit row (dismissed→new) in one tx", async () => {
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "new" });

    const update = mockCandidateUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: "gap-1" });
    expect(update.data.status).toBe("new");

    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("coi_gap_restore");
    expect(row.targetEntityType).toBe("coi_gap_candidate");
    expect(row.targetEntityId).toBe("gap-1");
    expect(row.actorCwid).toBe(SELF);
    expect(row.impersonatedCwid).toBeNull();
    expect(row.beforeValues).toEqual({ status: "dismissed" });
    expect(row.afterValues).toEqual({ status: "new" });
  });

  it("500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post("gap-1"), ctx("gap-1"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
