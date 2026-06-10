/**
 * #552 Phase 7 — `app/edit/center/[code]/history/page.tsx` authorization gates.
 *
 * The three gates mirror the editor route: signed-out → SAML redirect,
 * no-role + center exists → 403 + logged denial, center absent → 404,
 * authorized → renders the view. The audit history is loaded ONLY after the
 * gate clears. The view component is mocked here (it has its own test in
 * `center-history-view.test.tsx`) — `vi.mock` is hoisted module-wide, so the
 * real-component render assertions cannot live in this file.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockRedirect,
  mockNotFound,
  mockLoadCtx,
  mockLoadHistory,
  mockLogDenial,
  mockFindUnique,
  mockForbidden,
  mockView,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockLoadCtx: vi.fn(),
  mockLoadHistory: vi.fn(),
  mockLogDenial: vi.fn(),
  mockFindUnique: vi.fn(),
  mockForbidden: vi.fn(() => null),
  mockView: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: mockLoadCtx }));
vi.mock("@/lib/api/center-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/center-audit")>();
  return { ...actual, loadCenterAuditHistory: mockLoadHistory };
});
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/db", () => ({
  db: { read: { center: { findUnique: mockFindUnique } }, write: {} },
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/center-history-view", () => ({ CenterHistoryView: mockView }));

import EditCenterHistoryPage from "@/app/edit/center/[code]/history/page";

type El = { type: unknown };
const asEl = (v: unknown) => v as El;
const params = (code: string) => Promise.resolve({ code });

const CTX = {
  unit: { code: "meyer_cancer_center", name: "Meyer Cancer Center" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadHistory.mockResolvedValue([]);
});

describe("/edit/center/[code]/history — authorization", () => {
  it("signed-out → SAML redirect with ?return=…/history, no context load", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditCenterHistoryPage({ params: params("meyer_cancer_center") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/center/meyer_cancer_center/history",
    );
    expect(mockLoadCtx).not.toHaveBeenCalled();
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("no role + center exists → ForbiddenEditPage + logged denial, no history load", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "self01", isSuperuser: false });
    mockLoadCtx.mockResolvedValue(null);
    mockFindUnique.mockResolvedValue({ code: "meyer_cancer_center" });
    const result = asEl(await EditCenterHistoryPage({ params: params("meyer_cancer_center") }));
    expect(result.type).toBe(mockForbidden);
    expect(mockLogDenial).toHaveBeenCalledWith(
      expect.objectContaining({ targetEntityType: "center", reason: "not_curator" }),
    );
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("no role + center absent → 404, no history load", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "self01", isSuperuser: false });
    mockLoadCtx.mockResolvedValue(null);
    mockFindUnique.mockResolvedValue(null);
    await expect(EditCenterHistoryPage({ params: params("nope") })).rejects.toThrow("__NOTFOUND__");
    expect(mockLogDenial).not.toHaveBeenCalled();
    expect(mockLoadHistory).not.toHaveBeenCalled();
  });

  it("authorized (curator/owner/superuser) → loads history, renders the view", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "cur01", isSuperuser: false });
    mockLoadCtx.mockResolvedValue(CTX);
    mockLoadHistory.mockResolvedValue([{ id: "1" }]);
    const result = asEl(await EditCenterHistoryPage({ params: params("meyer_cancer_center") }));
    expect(result.type).toBe(mockView);
    expect(mockLoadHistory).toHaveBeenCalledWith("meyer_cancer_center", expect.anything());
  });
});
