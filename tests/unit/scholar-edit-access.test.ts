/**
 * `lib/edit/scholar-edit-access.ts` — the shared scholar-editor authorization
 * resolver (#955 finding #11 fast-follow). Both `/edit/scholar/[cwid]` and its
 * `/history` sibling delegate their five-gate rule here, so this is where the
 * gate matrix is pinned. We mock the boundary primitives (session seam + the
 * proxy / unit-admin / superuser checks) and assert the verdict each branch
 * returns — `redirect` / `forbidden` / `authorized` — plus the `?return=` and
 * `edit_authz_denied` path shapes (which differ by `pathSuffix`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockGetEditSession,
  mockIsGrantedProxy,
  mockCheckProxyConflict,
  mockResolveUnit,
  mockRequireSuperuserGet,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetEditSession: vi.fn(),
  mockIsGrantedProxy: vi.fn(),
  mockCheckProxyConflict: vi.fn(),
  mockResolveUnit: vi.fn(),
  mockRequireSuperuserGet: vi.fn(),
}));

vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/proxy-authz", () => ({
  isGrantedProxy: mockIsGrantedProxy,
  checkProxyConflictingRole: mockCheckProxyConflict,
}));
vi.mock("@/lib/edit/unit-scholar-authz", () => ({
  resolveEditableUnitViaUnitAdmin: mockResolveUnit,
}));
vi.mock("@/lib/edit/authz", () => ({ requireSuperuserGet: mockRequireSuperuserGet }));
// The resolver passes `db.read` to the (mocked) proxy / unit-admin checks, which
// ignore it — so a bare stub satisfies the import.
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import { resolveScholarEditAccess } from "@/lib/edit/scholar-edit-access";

const TARGET = "abc1001";

/** Wire raw + effective sessions for a non-impersonating actor. */
function signedInAs(cwid: string, opts: { isSuperuser?: boolean; isCommsSteward?: boolean } = {}) {
  mockGetSession.mockResolvedValue({ cwid });
  mockGetEditSession.mockResolvedValue({
    cwid,
    isSuperuser: opts.isSuperuser ?? false,
    isCommsSteward: opts.isCommsSteward ?? false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: no proxy grant, no unit-admin grant, superuser re-check denies.
  mockIsGrantedProxy.mockResolvedValue(false);
  mockCheckProxyConflict.mockResolvedValue({ ok: true });
  mockResolveUnit.mockResolvedValue(null);
  mockRequireSuperuserGet.mockReturnValue("not_superuser");
});

describe("resolveScholarEditAccess — five-gate matrix", () => {
  it("signed-out → redirect to SAML login with ?return= (bare route)", async () => {
    mockGetSession.mockResolvedValue(null);
    const access = await resolveScholarEditAccess(TARGET);
    expect(access).toEqual({
      kind: "redirect",
      to: "/api/auth/saml/login?return=/edit/scholar/abc1001",
    });
    // Gate 1 short-circuits before any authz probe.
    expect(mockGetEditSession).not.toHaveBeenCalled();
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("signed-out on the /history sibling → ?return= carries the suffix", async () => {
    mockGetSession.mockResolvedValue(null);
    const access = await resolveScholarEditAccess(TARGET, "/history");
    expect(access).toEqual({
      kind: "redirect",
      to: "/api/auth/saml/login?return=/edit/scholar/abc1001/history",
    });
  });

  it("signed-out with a cwid that needs encoding → return value is URL-encoded", async () => {
    mockGetSession.mockResolvedValue(null);
    const access = await resolveScholarEditAccess("a/b c", "/history");
    expect(access).toEqual({
      kind: "redirect",
      to: "/api/auth/saml/login?return=/edit/scholar/a%2Fb%20c/history",
    });
  });

  it("effective session missing (defensive) → login redirect", async () => {
    mockGetSession.mockResolvedValue({ cwid: "raw" });
    mockGetEditSession.mockResolvedValue(null);
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("redirect");
  });

  it("self → authorized (isSelf), no proxy/unit/superuser probes", async () => {
    signedInAs(TARGET);
    const access = await resolveScholarEditAccess(TARGET);
    expect(access).toEqual({
      kind: "authorized",
      session: { cwid: TARGET, isSuperuser: false, isCommsSteward: false },
      isSelf: true,
      isProxy: false,
      isUnitAdmin: false,
      unit: null,
    });
    expect(mockIsGrantedProxy).not.toHaveBeenCalled();
    expect(mockResolveUnit).not.toHaveBeenCalled();
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("granted, conflict-free proxy → authorized (isProxy), superuser check skipped", async () => {
    signedInAs("prx0001");
    mockIsGrantedProxy.mockResolvedValue(true);
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("authorized");
    if (access.kind === "authorized") {
      expect(access.isProxy).toBe(true);
      expect(access.isUnitAdmin).toBe(false);
    }
    expect(mockResolveUnit).not.toHaveBeenCalled();
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("granted proxy but a conflicting role → NOT a proxy, falls through to a 403", async () => {
    signedInAs("prx0001");
    mockIsGrantedProxy.mockResolvedValue(true);
    mockCheckProxyConflict.mockResolvedValue({ ok: false, reason: "is_curator" });
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("forbidden");
    expect(mockRequireSuperuserGet).toHaveBeenCalled();
  });

  it("org-unit admin → authorized (isUnitAdmin) and returns the conferring unit", async () => {
    signedInAs("adm0001");
    mockResolveUnit.mockResolvedValue({ kind: "department", code: "MED" });
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("authorized");
    if (access.kind === "authorized") {
      expect(access.isUnitAdmin).toBe(true);
      expect(access.unit).toEqual({ kind: "department", code: "MED" });
    }
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("comms_steward (not self) → authorized, superuser check skipped", async () => {
    signedInAs("stw0001", { isCommsSteward: true });
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("authorized");
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("superuser (not self) → authorized via the GET-time re-check returning null", async () => {
    signedInAs("sup0001", { isSuperuser: true });
    mockRequireSuperuserGet.mockReturnValue(null);
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("authorized");
    // A non-self, non-steward actor still goes through the superuser gate.
    expect(mockRequireSuperuserGet).toHaveBeenCalledWith({
      session: { cwid: "sup0001", isSuperuser: true, isCommsSteward: false },
      path: "/edit/scholar/abc1001",
      targetId: TARGET,
    });
  });

  it("no access → forbidden; the denial path carries the /history suffix", async () => {
    signedInAs("nob0001");
    const access = await resolveScholarEditAccess(TARGET, "/history");
    expect(access).toEqual({ kind: "forbidden" });
    expect(mockRequireSuperuserGet).toHaveBeenCalledWith({
      session: { cwid: "nob0001", isSuperuser: false, isCommsSteward: false },
      path: "/edit/scholar/abc1001/history",
      targetId: TARGET,
    });
  });

  it("impersonation overlay (IS-1) — raw ≠ effective skips proxy/unit gates", async () => {
    // Raw human A is viewing-as B; B is not the target and not a superuser. The
    // proxy and unit-admin gates are RAW-keyed (`raw.cwid === session.cwid`), so
    // the overlay must NOT confer either — even though a grant exists.
    mockGetSession.mockResolvedValue({ cwid: "rawA" });
    mockGetEditSession.mockResolvedValue({ cwid: "effB", isSuperuser: false, isCommsSteward: false });
    mockIsGrantedProxy.mockResolvedValue(true);
    mockResolveUnit.mockResolvedValue({ kind: "department", code: "MED" });
    const access = await resolveScholarEditAccess(TARGET);
    expect(access.kind).toBe("forbidden");
    expect(mockIsGrantedProxy).not.toHaveBeenCalled();
    expect(mockResolveUnit).not.toHaveBeenCalled();
  });
});
