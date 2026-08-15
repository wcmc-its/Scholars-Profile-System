/**
 * `app/edit/administrators/page.tsx` — the Administrators roster page (#728
 * Phase B). Route-level authorization + scope-wiring tests. Mocks the boundary
 * deps; uses the real `logEditDenial` (so the denial log line is exercised),
 * mirroring `edit-scholars-roster-page.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockIsTabEnabled,
  mockLoadOwnerScope,
  mockLoadRoster,
  mockGetCoreList,
  mockRedirect,
  mockRoster,
  mockForbidden,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockIsTabEnabled: vi.fn(),
  mockLoadOwnerScope: vi.fn(),
  mockLoadRoster: vi.fn(),
  mockGetCoreList: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockRoster: vi.fn(() => null),
  mockForbidden: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationEnabled: () => false,
}));
vi.mock("@/lib/edit/administrators", () => ({
  isAdministratorsTabEnabled: mockIsTabEnabled,
  loadOwnerManagedUnitScope: mockLoadOwnerScope,
}));
vi.mock("@/lib/api/administrators-roster", () => ({
  loadUnitAdministratorRoster: mockLoadRoster,
}));
// cores-as-org-units P2 — the page's new `allCores` prop source.
vi.mock("@/lib/api/cores", () => ({ getCoreList: mockGetCoreList }));
vi.mock("@/components/edit/administrators-roster", () => ({ AdministratorsRoster: mockRoster }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/admin-subnav", () => ({ AdminSubnav: () => null }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/db", () => ({
  db: { read: { scholar: { findUnique: vi.fn().mockResolvedValue(null) } }, write: {} },
}));

import AdministratorsPage from "@/app/edit/administrators/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;

const SUPERUSER = { cwid: "adm001", isSuperuser: true };
const OWNER = { cwid: "own01", isSuperuser: false };
const NOBODY = { cwid: "nob01", isSuperuser: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockIsTabEnabled.mockReturnValue(true);
  mockLoadRoster.mockResolvedValue({ entries: [], nameResolutionDegraded: false });
  mockGetCoreList.mockResolvedValue([]);
});

describe("/edit/administrators — authorization", () => {
  it("signed-out → SAML redirect with ?return=/edit/administrators", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(AdministratorsPage()).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/administrators",
    );
    expect(mockLoadRoster).not.toHaveBeenCalled();
  });

  it("flag off → ForbiddenEditPage, no roster query", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockIsTabEnabled.mockReturnValue(false);
    const result = asEl(await AdministratorsPage());
    // C8/C9 — the denial branch is wrapped in the same ConsoleShell the
    // success path uses, so the top-level element is the shell and
    // ForbiddenEditPage is its child, not the return value itself.
    expect(asEl(result.props.children).type).toBe(mockForbidden);
    expect(mockLoadRoster).not.toHaveBeenCalled();
    // logEditDenial emits the denial line.
    expect(console.warn).toHaveBeenCalled();
  });

  it("non-superuser who owns no unit → ForbiddenEditPage, no roster query", async () => {
    mockGetEditSession.mockResolvedValue(NOBODY);
    mockLoadOwnerScope.mockResolvedValue([]);
    const result = asEl(await AdministratorsPage());
    expect(asEl(result.props.children).type).toBe(mockForbidden);
    expect(mockLoadOwnerScope).toHaveBeenCalledOnce();
    expect(mockLoadRoster).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("owner → roster loaded with their owned scope, not forbidden", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadOwnerScope.mockResolvedValue(["N1280", "N1280-A"]);
    mockLoadRoster.mockResolvedValue({
      entries: [
        {
          cwid: "x1",
          name: "X",
          title: null,
          nameResolved: true,
          grants: [
            {
              entityType: "department",
              entityId: "N1280",
              unitName: "Medicine",
              role: "curator",
              source: "ED:DA",
            },
          ],
        },
      ],
      nameResolutionDegraded: false,
    });
    const result = asEl(await AdministratorsPage());
    // The page renders (not Forbidden); the roster query ran with the owned scope.
    expect(result.type).not.toBe(mockForbidden);
    expect(mockLoadOwnerScope).toHaveBeenCalledOnce();
    const [arg] = mockLoadRoster.mock.calls[0];
    expect(arg).toEqual({ scope: ["N1280", "N1280-A"] });
  });

  it("superuser → roster loaded with scope undefined (sees all)", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const result = asEl(await AdministratorsPage());
    expect(result.type).not.toBe(mockForbidden);
    expect(mockLoadOwnerScope).not.toHaveBeenCalled();
    const [arg] = mockLoadRoster.mock.calls[0];
    expect(arg).toEqual({ scope: undefined });
  });

  it("does not override unitsTab — the ConsoleShell baseline governs (Gap 4b)", async () => {
    // Regression for docs/edit-console-ia-spec.md Gap 4b: this page used to pass
    // `unitsTab={session.isSuperuser}`, which REPLACED (not OR'd onto) the
    // deriveConsoleTabs baseline, silently dropping Units for a comms_steward
    // who also owns a unit — the only way a non-superuser steward reaches this
    // page at all (a pure steward with no owned unit hits Forbidden above).
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadOwnerScope.mockResolvedValue(["N1280"]);
    const result = asEl(await AdministratorsPage());
    expect(result.props.unitsTab).toBeUndefined();
  });

  it("passes the core catalog through as allCores (cores-as-org-units P2)", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetCoreList.mockResolvedValue([
      { id: "2", name: "Biomedical Imaging", facility: null, hasConfirmedPublications: false },
    ]);
    const result = asEl(await AdministratorsPage());
    const children = result.props.children as unknown[];
    const rosterEl = children.map(asEl).find((c) => c.type === mockRoster);
    expect(rosterEl).toBeTruthy();
    expect((rosterEl!.props as { allCores: unknown }).allCores).toEqual([
      { id: "2", name: "Biomedical Imaging", facility: null, hasConfirmedPublications: false },
    ]);
    expect(mockGetCoreList).toHaveBeenCalledOnce();
  });
});
