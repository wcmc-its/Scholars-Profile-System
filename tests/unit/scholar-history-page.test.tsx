/**
 * #955 finding #11 — `app/edit/scholar/[cwid]/history/page.tsx` authorization.
 *
 * The gate mirrors the scholar editor: signed-out → SAML redirect; self / proxy
 * / unit-admin / comms_steward / superuser → authorized; anyone else → a logged
 * 403; absent or soft-deleted scholar → 404; #536 hidden class + non-superuser
 * → 404 (superuser bypasses). History is loaded ONLY after the gate + existence
 * checks clear. The view + forbidden components are mocked (module-hoisted), so
 * we assert on the returned element type, not its render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockGetEditSession,
  mockIsGrantedProxy,
  mockCheckProxyConflict,
  mockResolveUnit,
  mockRequireSuperuserGet,
  mockIsPubliclyDisplayed,
  mockFindUnique,
  mockLoadHistory,
  mockForbidden,
  mockView,
  mockRedirect,
  mockNotFound,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetEditSession: vi.fn(),
  mockIsGrantedProxy: vi.fn(),
  mockCheckProxyConflict: vi.fn(),
  mockResolveUnit: vi.fn(),
  mockRequireSuperuserGet: vi.fn(),
  mockIsPubliclyDisplayed: vi.fn(),
  mockFindUnique: vi.fn(),
  mockLoadHistory: vi.fn(),
  mockForbidden: vi.fn(() => null),
  mockView: vi.fn(() => null),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
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
vi.mock("@/lib/eligibility", () => ({ isPubliclyDisplayed: mockIsPubliclyDisplayed }));
vi.mock("@/lib/api/scholar-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/scholar-audit")>();
  return { ...actual, loadScholarAuditHistory: mockLoadHistory };
});
vi.mock("@/lib/db", () => ({
  db: { read: { scholar: { findUnique: mockFindUnique } }, write: {} },
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/scholar-history-view", () => ({ ScholarHistoryView: mockView }));

import EditScholarHistoryPage from "@/app/edit/scholar/[cwid]/history/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const params = (cwid: string) => Promise.resolve({ cwid });
const TARGET = "abc1001";
const SCHOLAR = { preferredName: "Jane Doe", roleCategory: "full_time_faculty", deletedAt: null };

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
  mockIsGrantedProxy.mockResolvedValue(false);
  mockCheckProxyConflict.mockResolvedValue({ ok: true });
  mockResolveUnit.mockResolvedValue(null);
  mockRequireSuperuserGet.mockReturnValue(null);
  mockIsPubliclyDisplayed.mockReturnValue(true);
  mockFindUnique.mockResolvedValue(SCHOLAR);
  mockLoadHistory.mockResolvedValue([]);
});

describe("/edit/scholar/[cwid]/history — authorization", () => {
  it("signed-out → SAML redirect with ?return=…/history, no history load", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(EditScholarHistoryPage({ params: params(TARGET) })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/scholar/abc1001/history",
    );
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("self → loads history, renders the view", async () => {
    signedInAs(TARGET);
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
    expect(mockLoadHistory).toHaveBeenCalledWith(TARGET, expect.anything());
    expect(result.props.unavailable).toBe(false);
  });

  it("audit read failure → renders the view as unavailable, does not 500", async () => {
    // The read role lacks SELECT on `scholars_audit.manual_edit_audit` until a DBA grant
    // lands; the page must degrade to an honest notice rather than throwing.
    signedInAs(TARGET);
    mockLoadHistory.mockRejectedValue(new Error("SELECT command denied ... manual_edit_audit"));
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
    expect(result.props.unavailable).toBe(true);
    expect(result.props.entries).toEqual([]);
  });

  it("superuser (not self) → renders the view via the superuser gate", async () => {
    signedInAs("sup0001", { isSuperuser: true });
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
    expect(mockRequireSuperuserGet).toHaveBeenCalled();
  });

  it("comms_steward (not self) → renders the view, superuser check skipped", async () => {
    signedInAs("stw0001", { isCommsSteward: true });
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("granted proxy → renders the view", async () => {
    signedInAs("prx0001");
    mockIsGrantedProxy.mockResolvedValue(true);
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
    expect(mockRequireSuperuserGet).not.toHaveBeenCalled();
  });

  it("org-unit admin → renders the view", async () => {
    signedInAs("adm0001");
    mockResolveUnit.mockResolvedValue({ kind: "department", code: "MED" });
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
  });

  it("no edit access → ForbiddenEditPage + logged denial, no history load", async () => {
    signedInAs("nob0001");
    mockRequireSuperuserGet.mockReturnValue("not_superuser");
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockForbidden);
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("authorized but scholar absent → 404, no history load", async () => {
    signedInAs(TARGET);
    mockFindUnique.mockResolvedValue(null);
    await expect(EditScholarHistoryPage({ params: params(TARGET) })).rejects.toThrow("__NOTFOUND__");
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("authorized but scholar soft-deleted → 404", async () => {
    signedInAs(TARGET);
    mockFindUnique.mockResolvedValue({ ...SCHOLAR, deletedAt: new Date("2026-01-01") });
    await expect(EditScholarHistoryPage({ params: params(TARGET) })).rejects.toThrow("__NOTFOUND__");
  });

  it("#536 hidden class + non-superuser (even self) → 404", async () => {
    signedInAs(TARGET);
    mockIsPubliclyDisplayed.mockReturnValue(false);
    await expect(EditScholarHistoryPage({ params: params(TARGET) })).rejects.toThrow("__NOTFOUND__");
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("#536 hidden class + superuser → renders (superuser bypasses)", async () => {
    signedInAs("sup0001", { isSuperuser: true });
    mockIsPubliclyDisplayed.mockReturnValue(false);
    const result = asEl(await EditScholarHistoryPage({ params: params(TARGET) }));
    expect(result.type).toBe(mockView);
  });
});
