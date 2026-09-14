/**
 * POST /api/edit/mentee-suggestions/[id]/dismiss (+ /restore) — #2634.
 *
 * Mirrors `coi-gap-dismiss-route.test.ts`: the actor rule (genuine self OR a
 * genuine superuser; a non-owner and an impersonating superuser both 404 so
 * another mentor's row is never confirmed to exist), the dormant 503 placed
 * after authz, reason validation, and the single-transaction write (dismissed_*
 * columns + a B03 `mentee_suggestion_dismiss` audit row keyed on
 * `{mentorCwid}:{menteeCwid}`).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEffectiveEditSession,
  mockGetSession,
  mockImpersonationActive,
  mockFindUnique,
  mockUpdate,
  mockTransaction,
  mockAppendAuditRow,
  mockLogEditDenial,
  mockEnabled,
} = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockEnabled: vi.fn(),
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
vi.mock("@/lib/edit/mentee-suggestions-flag", () => ({ isMenteeSuggestionsEnabled: mockEnabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { menteeSuggestion: { findUnique: mockFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));

import { POST as dismiss } from "@/app/api/edit/mentee-suggestions/[id]/dismiss/route";
import { POST as restore } from "@/app/api/edit/mentee-suggestions/[id]/restore/route";

const SELF = "self01";
const OTHER = "other9";
const ADMIN = "adm001";

function post(path: string, body: unknown = { reason: "colleague" }): NextRequest {
  return new NextRequest(`http://localhost/api/edit/mentee-suggestions/${path}`, {
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

const ACTIVE = {
  id: 7,
  mentorCwid: SELF,
  menteeCwid: "pxr4012",
  dismissedAt: null,
  dismissReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  asGenuine(SELF);
  mockEnabled.mockReturnValue(true);
  mockFindUnique.mockResolvedValue(ACTIVE);
  mockUpdate.mockResolvedValue({ id: 7 });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ menteeSuggestion: { update: mockUpdate }, $executeRaw: vi.fn() }),
  );
});

describe("POST /api/edit/mentee-suggestions/[id]/dismiss", () => {
  it("400 invalid_id for a non-numeric id", async () => {
    const res = await dismiss(post("abc/dismiss"), ctx("abc"));
    expect(res.status).toBe(400);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("404 when the row does not exist", async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await dismiss(post("7/dismiss"), ctx("7"));
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 (not 403) when the row belongs to another mentor — existence is never confirmed", async () => {
    mockFindUnique.mockResolvedValue({ ...ACTIVE, mentorCwid: OTHER });
    const res = await dismiss(post("7/dismiss"), ctx("7"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(mockLogEditDenial).toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404 while a superuser impersonates the owner (View-as confers nothing)", async () => {
    asImpersonating(ADMIN, SELF);
    const res = await dismiss(post("7/dismiss"), ctx("7"));
    expect(res.status).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("503 mentee_suggestions_disabled when the flag is off (after authz, before any write)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await dismiss(post("7/dismiss"), ctx("7"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "mentee_suggestions_disabled" });
    expect(mockTransaction).not.toHaveBeenCalled();
    // ...but a non-owner still 404s ahead of the dormant gate.
    mockFindUnique.mockResolvedValue({ ...ACTIVE, mentorCwid: OTHER });
    expect((await dismiss(post("7/dismiss"), ctx("7"))).status).toBe(404);
  });

  it("400 invalid_reason for a reason outside DISMISS_REASONS", async () => {
    const res = await dismiss(post("7/dismiss", { reason: "meh" }), ctx("7"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_reason", field: "reason" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("happy path: writes dismissedAt/By/Reason + a mentee_suggestion_dismiss audit row keyed mentor:mentee", async () => {
    const res = await dismiss(post("7/dismiss", { reason: "never_worked" }), ctx("7"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "dismissed",
      reason: "never_worked",
    });

    const update = mockUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: 7 });
    expect(update.data.dismissedAt).toBeInstanceOf(Date);
    expect(update.data.dismissedBy).toBe(SELF);
    expect(update.data.dismissReason).toBe("never_worked");

    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("mentee_suggestion_dismiss");
    expect(row.targetEntityType).toBe("mentee_suggestion");
    expect(row.targetEntityId).toBe(`${SELF}:pxr4012`);
    expect(row.actorCwid).toBe(SELF);
    expect(row.impersonatedCwid).toBeNull();
    expect(row.afterValues).toEqual({ reason: "never_worked" });
  });

  it("a genuine superuser may dismiss another mentor's row; the audit names the admin", async () => {
    asGenuine(ADMIN);
    mockFindUnique.mockResolvedValue({ ...ACTIVE, mentorCwid: OTHER });
    const res = await dismiss(post("7/dismiss"), ctx("7"));
    expect(res.status).toBe(200);
    expect(mockAppendAuditRow.mock.calls[0][1].actorCwid).toBe(ADMIN);
    expect(mockUpdate.mock.calls[0][0].data.dismissedBy).toBe(ADMIN);
  });

  it("is idempotent for the same reason (no re-write)", async () => {
    mockFindUnique.mockResolvedValue({
      ...ACTIVE,
      dismissedAt: new Date(),
      dismissReason: "colleague",
    });
    const res = await dismiss(post("7/dismiss", { reason: "colleague" }), ctx("7"));
    expect(await res.json()).toMatchObject({ alreadyDismissed: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("500 write_failed when the transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await dismiss(post("7/dismiss"), ctx("7"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/edit/mentee-suggestions/[id]/restore", () => {
  it("nulls the dismissed_* columns + writes a mentee_suggestion_restore audit row", async () => {
    mockFindUnique.mockResolvedValue({
      ...ACTIVE,
      dismissedAt: new Date(),
      dismissReason: "private",
    });
    const res = await restore(post("7/restore", {}), ctx("7"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "active" });
    expect(mockUpdate.mock.calls[0][0].data).toEqual({
      dismissedAt: null,
      dismissedBy: null,
      dismissReason: null,
    });
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("mentee_suggestion_restore");
    expect(row.targetEntityId).toBe(`${SELF}:pxr4012`);
    expect(row.beforeValues).toEqual({ reason: "private" });
    expect(row.afterValues).toEqual({ reason: null });
  });

  it("an already-active row returns ok without a write; a non-owner 404s; flag off 503s", async () => {
    expect(await (await restore(post("7/restore", {}), ctx("7"))).json()).toMatchObject({
      alreadyActive: true,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    mockFindUnique.mockResolvedValue({ ...ACTIVE, mentorCwid: OTHER, dismissedAt: new Date() });
    expect((await restore(post("7/restore", {}), ctx("7"))).status).toBe(404);
    mockFindUnique.mockResolvedValue({ ...ACTIVE, dismissedAt: new Date() });
    mockEnabled.mockReturnValue(false);
    expect((await restore(post("7/restore", {}), ctx("7"))).status).toBe(503);
  });
});
