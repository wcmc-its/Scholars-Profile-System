/**
 * POST /api/edit/report-access — gating + validation + the grant/revoke
 * dispatch. Mirrors `coi-gap-dismiss-route.test.ts`: the real
 * `readEditRequest` preamble runs (origin check stubbed ok), the session
 * seams are mocked, and `lib/edit/report-access` is mocked at the module
 * boundary so this suite asserts what the route wires where, not the
 * grant functions' own logic (covered in `report-access.test.ts`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEffectiveEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockGrant: vi.fn(),
  mockRevoke: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: h.mockGetEffectiveEditSession,
  impersonationActive: h.mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: h.mockGetSession }));
vi.mock("@/lib/auth/session", () => ({ nowSeconds: () => 1_000 }));
vi.mock("@/lib/edit/authz", () => ({
  verifyRequestOrigin: () => ({ ok: true }),
  logEditDenial: h.mockLogEditDenial,
}));
vi.mock("@/lib/edit/report-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/report-access")>();
  return {
    ...actual,
    grantReportAccess: h.mockGrant,
    revokeReportAccess: h.mockRevoke,
    listReportAccess: h.mockList,
  };
});
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import { POST } from "@/app/api/edit/report-access/route";

const ADMIN = "adm0001";
const PLAIN = "usr0001";

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/edit/report-access", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function asGenuine(cwid: string, roles: { isSuperuser?: boolean; isCommsSteward?: boolean } = {}) {
  h.mockGetEffectiveEditSession.mockResolvedValue({
    cwid,
    isSuperuser: roles.isSuperuser ?? false,
    isCommsSteward: roles.isCommsSteward ?? false,
  });
  h.mockGetSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
  h.mockImpersonationActive.mockReturnValue(false);
}

const VALID = { op: "grant", reportKey: "mentored-publications", scopeKey: "md", cwid: "Abc1234" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  asGenuine(ADMIN, { isSuperuser: true });
  h.mockGrant.mockResolvedValue({ changed: true });
  h.mockRevoke.mockResolvedValue({ changed: true });
  h.mockList.mockResolvedValue([
    {
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "abc1234",
      grantedBy: ADMIN,
      grantedAt: new Date("2026-09-18T12:00:00Z"),
    },
  ]);
});

describe("POST /api/edit/report-access — gating", () => {
  it("401 with no session", async () => {
    h.mockGetEffectiveEditSession.mockResolvedValue(null);
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
    expect(h.mockGrant).not.toHaveBeenCalled();
  });

  it("403 not_comms_steward for a plain user, before any field is validated", async () => {
    asGenuine(PLAIN);
    const res = await POST(post({ op: "bogus" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_comms_steward" });
    expect(h.mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ actorCwid: PLAIN, reason: "not_comms_steward" }),
    );
    expect(h.mockGrant).not.toHaveBeenCalled();
  });

  it("a comms_steward passes", async () => {
    asGenuine("stw0001", { isCommsSteward: true });
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(h.mockGrant).toHaveBeenCalledWith(expect.objectContaining({ actorCwid: "stw0001" }));
  });
});

describe("POST /api/edit/report-access — validation", () => {
  it.each([
    [{ ...VALID, op: "delete" }, "invalid_op"],
    [{ ...VALID, reportKey: "other-report" }, "invalid_report_key"],
    [{ ...VALID, scopeKey: "phd" }, "invalid_scope_key"],
    [{ ...VALID, cwid: "1abc" }, "invalid_cwid"],
    [{ ...VALID, cwid: "a" }, "invalid_cwid"],
    [{ ...VALID, cwid: "abcdefghijklm" }, "invalid_cwid"],
    [{ ...VALID, cwid: 42 }, "invalid_cwid"],
  ])("400 for %j → %s", async (body, error) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error });
    expect(h.mockGrant).not.toHaveBeenCalled();
    expect(h.mockRevoke).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/report-access — writes", () => {
  it("grant: lowercases the cwid, keys the audit on the real actor, returns the updated list", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(h.mockGrant).toHaveBeenCalledWith({
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "abc1234",
      actorCwid: ADMIN,
      impersonatedCwid: null,
      requestId: expect.any(String),
    });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, op: "grant", changed: true });
    expect(body.rows).toEqual([
      expect.objectContaining({ cwid: "abc1234", scopeKey: "md", grantedAt: "2026-09-18T12:00:00.000Z" }),
    ]);
    expect(h.mockRevoke).not.toHaveBeenCalled();
  });

  it("revoke: dispatches to revokeReportAccess and accepts the wildcard scope", async () => {
    h.mockRevoke.mockResolvedValue({ changed: false });
    const res = await POST(post({ ...VALID, op: "revoke", scopeKey: "*" }));
    expect(res.status).toBe(200);
    expect(h.mockRevoke).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "*", cwid: "abc1234" }));
    expect(await res.json()).toMatchObject({ ok: true, op: "revoke", changed: false });
    expect(h.mockGrant).not.toHaveBeenCalled();
  });

  it("500 write_failed when the grant throws", async () => {
    h.mockGrant.mockRejectedValue(new Error("boom"));
    const res = await POST(post(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
