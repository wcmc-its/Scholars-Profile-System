/**
 * /api/edit/grant-recs/feedback (GET + POST) — #1609.
 *
 * The actor rule mirrors the mentee-suggestion dismiss route: genuine self OR a
 * genuine (non-impersonating) superuser. Another scholar, a non-superuser
 * steward / proxy, and an impersonating superuser all 404 (never 403), so the
 * route does not confirm whose feedback exists. Flag off ⇒ 404 after authz,
 * before any read / write. Writes upsert (or delete on clear) the one
 * (cwid, opportunityId) row plus a B03 `grant_rec_feedback` audit row in one
 * transaction; a no-op write audits nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEffectiveEditSession,
  mockGetSession,
  mockImpersonationActive,
  mockFindMany,
  mockFindUnique,
  mockUpsert,
  mockDelete,
  mockTransaction,
  mockAppendAuditRow,
  mockLogEditDenial,
  mockEnabled,
} = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockDelete: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockEnabled: vi.fn(),
}));

// Impersonated writes re-check that the REAL initiator is a superuser
// (lib/edit/request.ts); these overlays model a superuser-started View as.
vi.mock("@/lib/auth/superuser", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth/superuser")>()),
  isSuperuser: async () => true,
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
vi.mock("@/lib/edit/grant-recs", () => ({ isGrantRecsEnabled: mockEnabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { grantRecFeedback: { findMany: mockFindMany } },
    write: { $transaction: mockTransaction },
  },
}));

import { GET, POST } from "@/app/api/edit/grant-recs/feedback/route";

const SELF = "self01";
const OTHER = "other9";
const ADMIN = "adm001";
const STEWARD = "stw001";
const URL_BASE = "http://localhost/api/edit/grant-recs/feedback";

function get(cwid: string): NextRequest {
  return new NextRequest(`${URL_BASE}?cwid=${cwid}`);
}
function post(body: unknown): NextRequest {
  return new NextRequest(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
const SAVE = { cwid: SELF, opportunityId: "NIH-PA-1", status: "saved" };

function asGenuine(cwid: string, extra: Record<string, unknown> = {}) {
  mockGetEffectiveEditSession.mockResolvedValue({ cwid, isSuperuser: cwid === ADMIN, ...extra });
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
  mockEnabled.mockReturnValue(true);
  mockFindMany.mockResolvedValue([]);
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockResolvedValue({});
  mockDelete.mockResolvedValue({ count: 1 });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      grantRecFeedback: { findUnique: mockFindUnique, upsert: mockUpsert, deleteMany: mockDelete },
      $executeRaw: vi.fn(),
    }),
  );
});

describe("GET /api/edit/grant-recs/feedback", () => {
  it("401 with no session", async () => {
    mockGetEffectiveEditSession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue(null);
    expect((await GET(get(SELF))).status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("400 on a malformed cwid", async () => {
    expect((await GET(get("bad%20cwid!"))).status).toBe(400);
  });

  it("returns the scholar's own feedback, dropping unknown vocabulary (no-store)", async () => {
    const at = new Date("2026-10-01T12:00:00Z");
    mockFindMany.mockResolvedValue([
      { opportunityId: "A", status: "saved", reason: null, updatedAt: at },
      { opportunityId: "B", status: "not_relevant", reason: "off_topic", updatedAt: at },
      { opportunityId: "C", status: "legacy", reason: null, updatedAt: at },
    ]);
    const res = await GET(get(SELF));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.feedback).toEqual([
      { opportunityId: "A", status: "saved", reason: null, updatedAt: at.toISOString() },
      { opportunityId: "B", status: "not_relevant", reason: "off_topic", updatedAt: at.toISOString() },
    ]);
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ cwid: SELF });
  });

  it("404 (not 403) for another scholar's feedback — never read", async () => {
    const res = await GET(get(OTHER));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(mockLogEditDenial).toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("404 for a non-superuser steward; 200 for a genuine superuser", async () => {
    asGenuine(STEWARD, { isCommsSteward: true });
    expect((await GET(get(SELF))).status).toBe(404);
    asGenuine(ADMIN);
    expect((await GET(get(SELF))).status).toBe(200);
  });

  it("404 while a superuser impersonates the scholar (View-as confers nothing)", async () => {
    asImpersonating(ADMIN, SELF);
    expect((await GET(get(SELF))).status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("404 grant_recs_disabled when the flag is off (after authz)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(get(SELF));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "grant_recs_disabled" });
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/grant-recs/feedback", () => {
  it("401 with no session — nothing written", async () => {
    mockGetEffectiveEditSession.mockResolvedValue(null);
    mockGetSession.mockResolvedValue(null);
    expect((await POST(post(SAVE))).status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 for another scholar's cwid — nothing written", async () => {
    const res = await POST(post({ ...SAVE, cwid: OTHER }));
    expect(res.status).toBe(404);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: SELF, targetCwid: OTHER, reason: "not_self" }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 for a steward / impersonating superuser — nothing written", async () => {
    asGenuine(STEWARD, { isCommsSteward: true });
    expect((await POST(post(SAVE))).status).toBe(404);
    asImpersonating(ADMIN, SELF);
    expect((await POST(post(SAVE))).status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 grant_recs_disabled when the flag is off — and a stranger still 404s not_found first", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await POST(post(SAVE));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "grant_recs_disabled" });
    const stranger = await POST(post({ ...SAVE, cwid: OTHER }));
    expect(await stranger.json()).toMatchObject({ error: "not_found" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 on a bad opportunityId / status / reason", async () => {
    expect((await POST(post({ ...SAVE, opportunityId: "" }))).status).toBe(400);
    expect((await POST(post({ ...SAVE, opportunityId: "x".repeat(129) }))).status).toBe(400);
    expect((await POST(post({ ...SAVE, status: "dismissed" }))).status).toBe(400);
    expect((await POST(post({ ...SAVE, status: undefined }))).status).toBe(400);
    // a reason only rides not_relevant, and must be in the vocabulary
    expect((await POST(post({ ...SAVE, reason: "off_topic" }))).status).toBe(400);
    expect(
      (await POST(post({ ...SAVE, status: "not_relevant", reason: "meh" }))).status,
    ).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("save: upserts the row (actor = the real human) + a grant_rec_feedback audit row", async () => {
    const res = await POST(post(SAVE));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "saved", unchanged: false });
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ cwid_opportunityId: { cwid: SELF, opportunityId: "NIH-PA-1" } });
    expect(arg.create).toMatchObject({ cwid: SELF, status: "saved", reason: null, actorCwid: SELF });
    const [, row] = mockAppendAuditRow.mock.calls[0];
    expect(row).toMatchObject({
      actorCwid: SELF,
      impersonatedCwid: null,
      targetEntityType: "scholar",
      targetEntityId: SELF,
      action: "grant_rec_feedback",
      beforeValues: { opportunityId: "NIH-PA-1", status: null, reason: null },
      afterValues: { opportunityId: "NIH-PA-1", status: "saved", reason: null },
    });
  });

  it("a genuine superuser may act for the scholar; the row records the superuser as actor", async () => {
    asGenuine(ADMIN);
    const res = await POST(post({ ...SAVE, status: "not_relevant", reason: "not_eligible" }));
    expect(res.status).toBe(200);
    expect(mockUpsert.mock.calls[0][0].update).toEqual({
      status: "not_relevant",
      reason: "not_eligible",
      actorCwid: ADMIN,
    });
    expect(mockAppendAuditRow.mock.calls[0][1].actorCwid).toBe(ADMIN);
  });

  it("clear (status null) deletes the row and audits the transition", async () => {
    mockFindUnique.mockResolvedValue({ status: "not_relevant", reason: "off_topic" });
    const res = await POST(post({ ...SAVE, status: null }));
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({
      where: { cwid: SELF, opportunityId: "NIH-PA-1" },
    });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({
      beforeValues: { status: "not_relevant", reason: "off_topic" },
      afterValues: { status: null, reason: null },
    });
  });

  it("a no-op write (same status + reason, or clearing nothing) touches nothing and audits nothing", async () => {
    mockFindUnique.mockResolvedValue({ status: "saved", reason: null });
    const res = await POST(post(SAVE));
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true });
    mockFindUnique.mockResolvedValue(null);
    await POST(post({ ...SAVE, status: null }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("boom"));
    const res = await POST(post(SAVE));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
