/**
 * POST /api/edit/reject — the self-edit "Not mine" → ReCiter gold-standard
 * reject endpoint (#746, #570). Mirrors the edit-suppress / request-change
 * route mocking. Verifies body/authz gates, the dormant 503, the per-author
 * self-only authorization, the no-authorship gate, idempotency (a repeated
 * reject does not re-fire ReCiter), the single-transaction write (suppression +
 * pending-refresh + B03 audit `publication_reject`), and the best-effort
 * goldstandard POST that stamps the sentinel on success yet never rolls back the
 * committed local reject on failure.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockSuppressionFindFirst,
  mockSuppressionCreate,
  mockPendingCreate,
  mockPendingUpdate,
  mockAppendAuditRow,
  mockPublicationAuthorshipExists,
  mockReflectVisibility,
  mockResolveAffected,
  mockReflectSearch,
  mockIsRejectEnabled,
  mockIsApiConfigured,
  mockPostGoldStandard,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockSuppressionCreate: vi.fn(),
  mockPendingCreate: vi.fn(),
  mockPendingUpdate: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockPublicationAuthorshipExists: vi.fn(),
  mockReflectVisibility: vi.fn(),
  mockResolveAffected: vi.fn(),
  mockReflectSearch: vi.fn(),
  mockIsRejectEnabled: vi.fn(),
  mockIsApiConfigured: vi.fn(),
  mockPostGoldStandard: vi.fn(),
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
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/validators", () => ({
  publicationAuthorshipExists: mockPublicationAuthorshipExists,
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectVisibilityChange: mockReflectVisibility,
  resolveAffectedProfiles: mockResolveAffected,
}));
vi.mock("@/lib/edit/search-suppression", () => ({
  reflectSearchSuppression: mockReflectSearch,
}));
vi.mock("@/lib/reciter/client", () => ({
  isReciterRejectEnabled: mockIsRejectEnabled,
  isReciterApiConfigured: mockIsApiConfigured,
  postGoldStandardReject: mockPostGoldStandard,
}));
vi.mock("@/lib/db", () => ({
  db: {
    write: {
      $transaction: mockTransaction,
      reciterPendingRefresh: { update: mockPendingUpdate },
    },
    read: { suppression: { findFirst: mockSuppressionFindFirst } },
  },
}));

import { POST } from "@/app/api/edit/reject/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/reject", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const SELF_REJECT = { entityId: "12345678", contributorCwid: "self01" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockIsRejectEnabled.mockReturnValue(true);
  mockIsApiConfigured.mockReturnValue(false);
  mockPublicationAuthorshipExists.mockResolvedValue(true);
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockSuppressionCreate.mockResolvedValue({ id: "supp-1" });
  mockPendingCreate.mockResolvedValue({ id: "pend-1" });
  mockPendingUpdate.mockResolvedValue(undefined);
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockResolveAffected.mockResolvedValue([{ slug: "self-01", cwid: "self01" }]);
  mockReflectVisibility.mockResolvedValue(undefined);
  mockReflectSearch.mockResolvedValue(undefined);
  mockPostGoldStandard.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(
    async (cb: (tx: unknown) => unknown) =>
      cb({
        suppression: { create: mockSuppressionCreate },
        reciterPendingRefresh: { create: mockPendingCreate },
        $executeRaw: vi.fn(),
      }),
  );
});

describe("POST /api/edit/reject", () => {
  it("400 invalid_entity_id when the pmid is missing", async () => {
    const res = await POST(post({ contributorCwid: "self01" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_entity_id" });
  });

  it("400 invalid_contributor when the cwid is missing", async () => {
    const res = await POST(post({ entityId: "12345678" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_contributor" });
  });

  it("403 when a non-superuser rejects another scholar's authorship", async () => {
    const res = await POST(post({ entityId: "12345678", contributorCwid: "other9" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPostGoldStandard).not.toHaveBeenCalled();
  });

  it("503 reject_disabled when the feature is dormant (client keeps the off-ramp)", async () => {
    mockIsRejectEnabled.mockReturnValue(false);
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "reject_disabled" });
    // Dormant ⇒ no DB work at all.
    expect(mockPublicationAuthorshipExists).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 no_authorship when the scholar isn't an author of the pmid", async () => {
    mockPublicationAuthorshipExists.mockResolvedValue(false);
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_authorship" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("is idempotent — an existing un-revoked suppression returns ok without re-firing ReCiter", async () => {
    mockSuppressionFindFirst.mockResolvedValue({ id: "supp-existing" });
    mockIsApiConfigured.mockReturnValue(true);
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      suppressionId: "supp-existing",
      alreadyRejected: true,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPostGoldStandard).not.toHaveBeenCalled();
  });

  it("commits suppression + pending-refresh + a publication_reject audit row in one tx", async () => {
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressionId: "supp-1" });

    // suppression: per-author publication row, reason marks it a reject
    const supp = mockSuppressionCreate.mock.calls[0][0].data;
    expect(supp).toMatchObject({
      entityType: "publication",
      entityId: "12345678",
      contributorCwid: "self01",
      createdBy: "self01",
    });
    expect(supp.reason).toContain("Rejected");

    // pending-refresh: uid == contributor cwid, the real actor recorded
    expect(mockPendingCreate.mock.calls[0][0].data).toMatchObject({
      uid: "self01",
      pmid: "12345678",
      rejectedBy: "self01",
    });

    // B03 audit
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("publication_reject");
    expect(row.targetEntityType).toBe("publication");
    expect(row.targetEntityId).toBe("12345678");
    expect(row.afterValues).toMatchObject({
      suppression_id: "supp-1",
      pending_refresh_id: "pend-1",
      contributor_cwid: "self01",
      reciter_source: "Scholars",
    });
    // reflects the removal into profile + search (best-effort)
    expect(mockReflectVisibility).toHaveBeenCalled();
    expect(mockReflectSearch).toHaveBeenCalled();
  });

  it("dormant API (unconfigured) ⇒ records the reject locally, defers the goldstandard POST", async () => {
    mockIsApiConfigured.mockReturnValue(false);
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPostGoldStandard).not.toHaveBeenCalled();
    expect(mockPendingUpdate).not.toHaveBeenCalled();
  });

  it("configured API ⇒ best-effort goldstandard POST, stamps goldstandard_sent_at on success", async () => {
    mockIsApiConfigured.mockReturnValue(true);
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(200);
    expect(mockPostGoldStandard).toHaveBeenCalledWith({ uid: "self01", pmid: "12345678" });
    expect(mockPendingUpdate).toHaveBeenCalledWith({
      where: { id: "pend-1" },
      data: { goldstandardSentAt: expect.any(Date) },
    });
  });

  it("a failed goldstandard POST never rolls back the committed reject (200, sentinel left NULL)", async () => {
    mockIsApiConfigured.mockReturnValue(true);
    mockPostGoldStandard.mockRejectedValue(new Error("ReCiter timeout"));
    const res = await POST(post(SELF_REJECT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressionId: "supp-1" });
    // sentinel NOT stamped → the scanner will retry
    expect(mockPendingUpdate).not.toHaveBeenCalled();
  });

  it("a superuser may reject on behalf of another scholar (uid is that scholar)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockIsApiConfigured.mockReturnValue(true);
    const res = await POST(post({ entityId: "999", contributorCwid: "target7" }));
    expect(res.status).toBe(200);
    expect(mockPostGoldStandard).toHaveBeenCalledWith({ uid: "target7", pmid: "999" });
    // the audit actor is the real human (the superuser), target is the pmid
    expect(mockAppendAuditRow.mock.calls[0][1].actorCwid).toBe("adm001");
  });
});
