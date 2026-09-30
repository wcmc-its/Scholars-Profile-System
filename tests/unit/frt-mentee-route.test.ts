/**
 * POST /api/edit/frt-mentees/[id] — dismiss / restore / assign a CWID on a
 * Faculty Review Tool mentee. Same actor rule as the co-author suggestion
 * routes (mentee-suggestions-dismiss-route.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getEffectiveEditSession: vi.fn(),
  getSession: vi.fn(),
  impersonationActive: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  appendAuditRow: vi.fn(),
  logEditDenial: vi.fn(),
  enabled: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.getEffectiveEditSession,
  impersonationActive: h.impersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.getSession }));
vi.mock("@/lib/auth/session", () => ({ nowSeconds: () => 1_000 }));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/authz", async () => ({
  verifyRequestOrigin: () => ({ ok: true }),
  logEditDenial: h.logEditDenial,
}));
vi.mock("@/lib/edit/mentee-suggestions-flag", () => ({ isMenteeSuggestionsEnabled: h.enabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { frtMentee: { findUnique: h.findUnique } },
    write: { $transaction: h.transaction },
  },
}));

import { POST } from "@/app/api/edit/frt-mentees/[id]/route";

const SELF = "self01";
const ADMIN = "adm001";

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/edit/frt-mentees/7", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ id: "7" }) };

function asGenuine(cwid: string) {
  h.getEffectiveEditSession.mockResolvedValue({ cwid, isSuperuser: cwid === ADMIN });
  h.getSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
  h.impersonationActive.mockReturnValue(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  asGenuine(SELF);
  h.enabled.mockReturnValue(true);
  h.findUnique.mockResolvedValue({ id: 7, mentorCwid: SELF, menteeCwid: null, dismissedAt: null });
  h.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ frtMentee: { update: h.update } }),
  );
});

describe("POST /api/edit/frt-mentees/[id]", () => {
  it("assigns a CWID, marks it hand-assigned, and audits before/after", async () => {
    const res = await POST(post({ op: "assign", cwid: " ABC2001 " }), ctx);
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ menteeCwid: "abc2001", cwidAssignedBy: SELF }),
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "frt_mentee_assign_cwid",
        targetEntityType: "frt_mentee",
        targetEntityId: "7",
        beforeValues: { menteeCwid: null },
        afterValues: { menteeCwid: "abc2001" },
      }),
    );
  });

  it("accepts cwid null as 'no WCM person'", async () => {
    h.findUnique.mockResolvedValue({
      id: 7,
      mentorCwid: SELF,
      menteeCwid: "abc2001",
      dismissedAt: null,
    });
    const res = await POST(post({ op: "assign", cwid: null }), ctx);
    expect(res.status).toBe(200);
    expect(h.update.mock.calls[0][0].data.menteeCwid).toBeNull();
  });

  it("400 for a malformed CWID or the mentor's own CWID", async () => {
    expect((await POST(post({ op: "assign", cwid: "not a cwid!" }), ctx)).status).toBe(400);
    expect((await POST(post({ op: "assign", cwid: SELF }), ctx)).status).toBe(400);
    expect((await POST(post({ op: "assign" }), ctx)).status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("dismisses and restores", async () => {
    await POST(post({ op: "dismiss" }), ctx);
    expect(h.update.mock.calls[0][0].data).toMatchObject({ dismissedBy: SELF });
    await POST(post({ op: "restore" }), ctx);
    expect(h.update.mock.calls[1][0].data).toEqual({ dismissedAt: null, dismissedBy: null });
    expect(h.appendAuditRow.mock.calls.map((c) => c[1].action)).toEqual([
      "frt_mentee_dismiss",
      "frt_mentee_restore",
    ]);
  });

  it("404 for another mentor's row; a genuine superuser may act", async () => {
    asGenuine("other9");
    expect((await POST(post({ op: "dismiss" }), ctx)).status).toBe(404);
    expect(h.transaction).not.toHaveBeenCalled();
    asGenuine(ADMIN);
    expect((await POST(post({ op: "dismiss" }), ctx)).status).toBe(200);
  });

  it("503 when the flag is off, 400 for an unknown op", async () => {
    expect((await POST(post({ op: "explode" }), ctx)).status).toBe(400);
    h.enabled.mockReturnValue(false);
    expect((await POST(post({ op: "dismiss" }), ctx)).status).toBe(503);
  });
});
