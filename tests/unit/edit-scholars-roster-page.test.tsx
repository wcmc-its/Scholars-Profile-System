/**
 * `app/edit/scholars/page.tsx` — the Profiles roster page (#160 UI follow-up).
 * Route-level authorization + query-wiring tests. Mocks the boundary deps and
 * uses the real `requireSuperuserGet` (so the denial log line is exercised),
 * mirroring the `/edit/scholar/[cwid]` page test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockGetEditSession,
  mockLoadEditRoster,
  mockLoadRosterFacets,
  mockRedirect,
  mockRoster,
  mockForbidden,
  mockUnitAdminFindMany,
  mockDivisionFindMany,
  mockCenterProxyEnabled,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadEditRoster: vi.fn(),
  mockLoadRosterFacets: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockCenterProxyEnabled: vi.fn(),
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
vi.mock("@/lib/api/edit-roster", () => ({
  loadEditRoster: mockLoadEditRoster,
  loadRosterFacets: mockLoadRosterFacets,
}));
vi.mock("@/lib/edit/unit-admin-center-proxy", () => ({
  isUnitAdminCenterProxyEnabled: mockCenterProxyEnabled,
}));
vi.mock("@/components/edit/profiles-roster", () => ({ ProfilesRoster: mockRoster }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
// For the component-render test below: render `next/link` as a plain anchor and
// stub the roster's child components so the real ProfilesRoster renders without
// pulling client-only machinery.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/edit/admin-subnav", () => ({ AdminSubnav: () => null }));
vi.mock("@/components/edit/view-as-button", () => ({
  ViewAsButton: ({ targetCwid }: { targetCwid: string }) => (
    <button data-testid={`view-as-${targetCwid}`}>View as</button>
  ),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: vi.fn().mockResolvedValue(null) },
      // B3 — the page resolves the viewer's unit scope on every GET via the real
      // `loadDataQualityScope`, so the grant + cascade reads must be stubbed.
      // Default: no grants (a plain scholar), which each test overrides.
      unitAdmin: { findMany: mockUnitAdminFindMany },
      division: { findMany: mockDivisionFindMany },
    },
    write: {},
  },
}));

import EditScholarsPage from "@/app/edit/scholars/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

const ADMIN = { cwid: "adm001", isSuperuser: true };
const SELF = { cwid: "self01", isSuperuser: false };
/** A unit Owner/Curator: no global role, admitted only by their grants (B3). */
const CURATOR = { cwid: "cur001", isSuperuser: false, isCommsSteward: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockLoadEditRoster.mockResolvedValue({ entries: [], total: 0 });
  mockLoadRosterFacets.mockResolvedValue({
    departments: [],
    divisions: [],
    centers: [],
    roleCategories: [],
  });
  // Default: the viewer holds no unit grants → empty scope → Forbidden unless
  // they are a superuser / comms_steward.
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  // Matches prod, where the flag is on.
  mockCenterProxyEnabled.mockReturnValue(true);
});

describe("/edit/scholars — authorization", () => {
  it("signed-out → SAML redirect with ?return=/edit/scholars", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditScholarsPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/scholars",
    );
    expect(mockLoadEditRoster).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser → ForbiddenEditPage inside ConsoleShell, no roster query", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    // B8 — the denial branch is wrapped in the same ConsoleShell the success
    // path uses, so the top-level element is the shell and ForbiddenEditPage
    // is its child, not the return value itself.
    expect(asEl(result.props.children).type).toBe(mockForbidden);
    expect(mockLoadEditRoster).not.toHaveBeenCalled();
    // requireSuperuserGet emits the denial line.
    expect(console.warn).toHaveBeenCalled();
  });

  // B3 — the org-unit-admin tier. Before this the roster was superuser/steward
  // only, so a department curator had no way to FIND the scholars they were
  // already authorized to edit (Amendment 4 grants them the per-scholar editor).
  it("unit Owner/Curator → admitted, and the query is SCOPE-FILTERED to their units", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "DEPT1" },
      { entityType: "center", entityId: "CTR1" },
    ]);
    // The dept→division cascade: managing a department reaches its divisions.
    mockDivisionFindMany.mockResolvedValue([{ code: "DIV1" }, { code: "DIV2" }]);

    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    expect(result.type).not.toBe(mockForbidden);

    const opts = mockLoadEditRoster.mock.calls[0][0];
    expect(opts.unitCodeScope.sort()).toEqual(["DEPT1", "DIV1", "DIV2"]);
    // UNIT_ADMIN_CENTER_PROXY is on in this env (see the vi.mock above), matching
    // prod; with it off the centers must drop out — see the next case.
    expect(opts.scopeCenterCodes).toEqual(["CTR1"]);
  });

  // The roster must never list someone the per-scholar editor would refuse.
  it("drops center scope when UNIT_ADMIN_CENTER_PROXY is off (no listed-but-403 rows)", async () => {
    mockCenterProxyEnabled.mockReturnValue(false);
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "DEPT1" },
      { entityType: "center", entityId: "CTR1" },
    ]);
    await EditScholarsPage({ searchParams: sp() });
    expect(mockLoadEditRoster.mock.calls[0][0].scopeCenterCodes).toBeUndefined();
  });

  it("a superuser is NOT scope-filtered (sees everyone, as before)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp() });
    const opts = mockLoadEditRoster.mock.calls[0][0];
    expect(opts.unitCodeScope).toBeUndefined();
    expect(opts.scopeCenterCodes).toBeUndefined();
  });

  it("narrows the org-unit filter dropdowns to the curator's own scope", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPT1" }]);
    mockDivisionFindMany.mockResolvedValue([{ code: "DIV1" }]);
    mockLoadRosterFacets.mockResolvedValue({
      departments: [{ code: "DEPT1", name: "Mine" }, { code: "DEPT9", name: "Theirs" }],
      divisions: [{ code: "DIV1", name: "Mine div" }, { code: "DIV9", name: "Theirs div" }],
      centers: [{ code: "CTR9", name: "Not mine" }],
      roleCategories: [{ value: "full_time_faculty", label: "Full-time faculty" }],
    });

    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    const roster = asEl(result.props.children);
    const facets = roster.props.facets as Record<string, unknown[]>;
    expect(facets.departments).toEqual([{ code: "DEPT1", name: "Mine" }]);
    expect(facets.divisions).toEqual([{ code: "DIV1", name: "Mine div" }]);
    expect(facets.centers).toEqual([]);
    // Person type is not unit-specific — it stays whole.
    expect(facets.roleCategories).toHaveLength(1);
  });

  it("a curator never gets the superuser 'View as' affordance", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPT1" }]);
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    expect(asEl(result.props.children).props.canImpersonate).toBe(false);
  });

  it("superuser → renders the roster from a roster query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditRoster.mockResolvedValue({
      entries: [{ cwid: "abc1", slug: "abc", name: "A", title: null, unit: null, isVisible: true }],
      total: 1,
    });
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    expect(result.type).not.toBe(mockForbidden);
    const roster = asEl(result.props.children);
    expect(roster.type).toBe(mockRoster);
    expect(roster.props.total).toBe(1);
    expect(mockLoadEditRoster).toHaveBeenCalledOnce();
  });
});

describe("/edit/scholars — query parsing", () => {
  it("parses q, status, and page into the roster query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp({ q: "  smith ", status: "hidden", page: "2" }) });
    const [opts] = mockLoadEditRoster.mock.calls[0];
    expect(opts).toMatchObject({ query: "smith", status: "hidden", limit: 50, offset: 100 });
  });

  it("defaults an unknown status to 'all' and a bad page to 0", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp({ status: "bogus", page: "-3" }) });
    const [opts] = mockLoadEditRoster.mock.calls[0];
    expect(opts.status).toBe("all");
    expect(opts.offset).toBe(0);
  });
});

// Render the real ProfilesRoster (the page tests above mock it). The per-row
// name is the link into the editor; there is no separate "Edit" link.
describe("ProfilesRoster — row name links to the editor", () => {
  // The module-level vi.mock replaces ProfilesRoster with a spy for the page
  // tests, so reach for the real implementation here.
  async function renderRoster(
    overrides: Partial<React.ComponentProps<typeof import("@/components/edit/profiles-roster").ProfilesRoster>> = {},
  ) {
    const { ProfilesRoster } = await vi.importActual<
      typeof import("@/components/edit/profiles-roster")
    >("@/components/edit/profiles-roster");
    render(
      <ProfilesRoster
        entries={[
          {
            cwid: "abc1001",
            slug: "abc",
            name: "Ada Lovelace",
            title: null,
            unit: null,
            roleCategory: null,
            isVisible: true,
          },
        ]}
        total={1}
        query=""
        status="all"
        unit=""
        roleCategory=""
        facets={{ departments: [], divisions: [], centers: [], roleCategories: [] }}
        page={0}
        pageSize={50}
        canImpersonate={false}
        viewerCwid="adm001"
        {...overrides}
      />,
    );
  }

  it("renders the scholar name as a link to /edit/scholar/<cwid> (the name is the link text)", async () => {
    await renderRoster();
    const link = screen.getByTestId("roster-name-abc1001");
    expect(link.tagName.toLowerCase()).toBe("a");
    expect(link.getAttribute("href")).toBe("/edit/scholar/abc1001");
    // Accessibility: the link's accessible name is the scholar's name.
    expect(link.textContent).toBe("Ada Lovelace");
  });

  it("no longer renders a separate Edit link", async () => {
    await renderRoster();
    expect(screen.queryByTestId("roster-edit-abc1001")).toBeNull();
  });

  it("renders the View-as button when impersonation is allowed (not the viewer's own row)", async () => {
    await renderRoster({ canImpersonate: true, viewerCwid: "adm001" });
    expect(screen.getByTestId("view-as-abc1001")).toBeTruthy();
  });

  it("hides the View-as button on the viewer's own row", async () => {
    await renderRoster({ canImpersonate: true, viewerCwid: "abc1001" });
    expect(screen.queryByTestId("view-as-abc1001")).toBeNull();
  });

  it("hides the View-as button when impersonation is not allowed", async () => {
    await renderRoster({ canImpersonate: false });
    expect(screen.queryByTestId("view-as-abc1001")).toBeNull();
  });
});
