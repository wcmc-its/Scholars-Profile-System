/**
 * POST /api/edit/reporter-profile/[id]/{confirm,reject,revoke} — the RePORTER
 * PMID-overlap "Is this you?" actions (`REPORTER_MATCH_V2`, dormant).
 *
 * Verifies (spec §11 rows 4–9, 11): the flag-first 404 dark behavior, the
 * GENUINE-self-or-superuser authz (403 for another scholar, 403 while
 * impersonating even the owner — IS-1), 404 for a missing candidate, the reject
 * enum guard, the state machine (confirm only from pending → person_nih_profile
 * upsert; reject → terminal + reason; revoke only from confirmed → profile
 * delete), idempotency (`unchanged: true`, no tx), and 409 invalid_state.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEffectiveEditSession,
  mockGetSession,
  mockImpersonationActive,
  mockCandidateFindUnique,
  mockCandidateUpdate,
  mockProfileUpsert,
  mockProfileDeleteMany,
  mockTransaction,
  mockAppendAuditRow,
  mockLogEditDenial,
  mockIsEnabled,
} = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockCandidateFindUnique: vi.fn(),
  mockCandidateUpdate: vi.fn(),
  mockProfileUpsert: vi.fn(),
  mockProfileDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockIsEnabled: vi.fn(),
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
vi.mock("@/lib/edit/reporter-match", () => ({ isReporterMatchV2Enabled: mockIsEnabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { reporterProfileCandidate: { findUnique: mockCandidateFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));

import { POST as confirmPost } from "@/app/api/edit/reporter-profile/[id]/confirm/route";
import { POST as rejectPost } from "@/app/api/edit/reporter-profile/[id]/reject/route";
import { POST as revokePost } from "@/app/api/edit/reporter-profile/[id]/revoke/route";

const SELF = "self01";
const OTHER = "other9";
const ADMIN = "adm001";

function post(action: string, id: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://localhost/api/edit/reporter-profile/${id}/${action}`, {
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
  mockIsEnabled.mockReturnValue(true);
  mockCandidateFindUnique.mockResolvedValue({
    id: "rp-1",
    cwid: SELF,
    externalProfileId: 12345,
    status: "pending",
    rejectReason: null,
  });
  mockCandidateUpdate.mockResolvedValue({ id: "rp-1" });
  mockProfileUpsert.mockResolvedValue({});
  mockProfileDeleteMany.mockResolvedValue({ count: 1 });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      reporterProfileCandidate: { update: mockCandidateUpdate },
      personNihProfile: { upsert: mockProfileUpsert, deleteMany: mockProfileDeleteMany },
      $executeRaw: vi.fn(),
    }),
  );
});

describe("authz + flag gate (shared across confirm/reject/revoke)", () => {
  it("404 (flag-first, fully dark) when REPORTER_MATCH_V2 is off — before any auth probe", async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(404);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 invalid_id when the id is empty", async () => {
    const res = await confirmPost(post("confirm", ""), ctx(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_id" });
  });

  it("404 when the candidate does not exist", async () => {
    mockCandidateFindUnique.mockResolvedValue(null);
    const res = await confirmPost(post("confirm", "nope"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 not_self for another scholar's candidate", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: OTHER,
      externalProfileId: 12345,
      status: "pending",
      rejectReason: null,
    });
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockLogEditDenial).toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403 while impersonating the owner — a superuser View-as cannot confirm (IS-1)", async () => {
    asImpersonating(ADMIN, SELF);
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("200 — a genuine (non-impersonating) superuser may act on another scholar's candidate", async () => {
    asGenuine(ADMIN);
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: OTHER,
      externalProfileId: 12345,
      status: "pending",
      rejectReason: null,
    });
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(200);
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.actorCwid).toBe(ADMIN);
    expect(row.impersonatedCwid).toBeNull();
  });
});

describe("confirm", () => {
  it("pending → confirmed: candidate update + person_nih_profile upsert + audit, one tx", async () => {
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "confirmed" });

    const update = mockCandidateUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: "rp-1" });
    expect(update.data.status).toBe("confirmed");
    expect(update.data.reviewedBy).toBe(SELF);

    const upsert = mockProfileUpsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ cwid_nihProfileId: { cwid: SELF, nihProfileId: 12345 } });
    expect(upsert.create.resolutionSource).toBe("pmid-overlap-confirmed");
    expect(upsert.create.source).toBe("RePORTER");

    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("reporter_profile_confirm");
    expect(row.targetEntityType).toBe("reporter_profile_candidate");
  });

  it("idempotent when already confirmed — unchanged, no tx", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: SELF,
      externalProfileId: 12345,
      status: "confirmed",
      rejectReason: null,
    });
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("409 invalid_state confirming a terminal (rejected) candidate", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: SELF,
      externalProfileId: 12345,
      status: "rejected",
      rejectReason: "not_me",
    });
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(409);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("500 write_failed when the tx throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await confirmPost(post("confirm", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(500);
  });
});

describe("reject", () => {
  it.each(["not_me", "name_only", "cant_tell"] as const)(
    "reason=%s → rejected + rejectReason + audit",
    async (reason) => {
      const res = await rejectPost(post("reject", "rp-1", { reason }), ctx("rp-1"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: "rejected", reason });
      const update = mockCandidateUpdate.mock.calls[0][0];
      expect(update.data.status).toBe("rejected");
      expect(update.data.rejectReason).toBe(reason);
      expect(mockProfileUpsert).not.toHaveBeenCalled(); // no profile write on reject
      expect(mockAppendAuditRow.mock.calls[0][1].action).toBe("reporter_profile_reject");
    },
  );

  it("400 invalid_reason for an unknown/absent reason", async () => {
    expect((await rejectPost(post("reject", "rp-1", { reason: "nope" }), ctx("rp-1"))).status).toBe(400);
    expect((await rejectPost(post("reject", "rp-1", {}), ctx("rp-1"))).status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("idempotent when already rejected — unchanged, no tx", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: SELF,
      status: "rejected",
      rejectReason: "not_me",
    });
    const res = await rejectPost(post("reject", "rp-1", { reason: "not_me" }), ctx("rp-1"));
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("revoke", () => {
  it("confirmed → revoked: candidate update + person_nih_profile delete + audit", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: SELF,
      externalProfileId: 12345,
      status: "confirmed",
      rejectReason: null,
    });
    const res = await revokePost(post("revoke", "rp-1"), ctx("rp-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "revoked" });
    expect(mockCandidateUpdate.mock.calls[0][0].data.status).toBe("revoked");
    const del = mockProfileDeleteMany.mock.calls[0][0];
    expect(del.where).toEqual({ cwid: SELF, nihProfileId: 12345 });
    expect(mockAppendAuditRow.mock.calls[0][1].action).toBe("reporter_profile_revoke");
  });

  it("409 invalid_state revoking a still-pending candidate (no profile to drop)", async () => {
    const res = await revokePost(post("revoke", "rp-1"), ctx("rp-1")); // default status pending
    expect(res.status).toBe(409);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("idempotent when already revoked — unchanged, no tx", async () => {
    mockCandidateFindUnique.mockResolvedValue({
      id: "rp-1",
      cwid: SELF,
      externalProfileId: 12345,
      status: "revoked",
      rejectReason: null,
    });
    const res = await revokePost(post("revoke", "rp-1"), ctx("rp-1"));
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
