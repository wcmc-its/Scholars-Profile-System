/**
 * `app/edit/scholars/page.tsx` — the Profiles roster page (#160 UI follow-up;
 * merged with the former standalone Data Quality dashboard, then split again
 * so COI moved to its own page, see `lib/api/data-quality.ts` and
 * `app/edit/coi/page.tsx`). Route-level authorization + query-wiring tests.
 * Mocks the boundary deps and uses the real `requireSuperuserGet` (so the
 * denial log line is exercised) and the real `loadDataQualityScope` /
 * `isEmptyScope` (so the B3 unit-scope resolution is exercised against a
 * stubbed `db.read`), mirroring the `/edit/scholar/[cwid]` page test.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockGetEditSession,
  mockLoadDataQualityRoster,
  mockLoadDataQualityFacets,
  mockRedirect,
  mockRoster,
  mockForbidden,
  mockUnitAdminFindMany,
  mockDivisionFindMany,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadDataQualityRoster: vi.fn(),
  mockLoadDataQualityFacets: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
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
vi.mock("@/lib/api/data-quality", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api/data-quality")>();
  return {
    ...actual, // keep the real parseDataQualityParams so param threading is exercised
    loadDataQualityRoster: mockLoadDataQualityRoster,
    loadDataQualityFacets: mockLoadDataQualityFacets,
  };
});
vi.mock("@/components/edit/profiles-roster", () => ({ ProfilesRoster: mockRoster }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
// The real ProfilesRoster (rendered directly in the block below) mounts the
// client filter sidebar, which uses next/navigation's useRouter — stub it out,
// those tests target row rendering, not the filter island.
vi.mock("@/components/edit/profiles-filters", () => ({ ProfilesFilters: () => null }));
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

/** A minimal, fully-shaped `DataQualityEntry` fixture. */
const ENTRY = {
  cwid: "abc1",
  slug: "abc",
  name: "A",
  title: null,
  unit: null,
  roleCategory: null,
  isChair: false,
  isChief: false,
  leadership: null,
  leadershipTier: 3,
  isVisible: true,
  headshot: "unknown" as const,
  hasOverview: false,
  overviewUpdatedAt: null,
  overviewState: "never" as const,
  pendingCoiHigh: 0,
  pendingCoiMedium: 0,
  prominence: 1.0,
  editHref: "/edit/scholar/abc1",
};

const COUNTS = { inScope: 0, missingHeadshot: 0, missingOverview: 0, withCoi: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockLoadDataQualityRoster.mockResolvedValue({ entries: [], total: 0, counts: COUNTS });
  mockLoadDataQualityFacets.mockResolvedValue({ roleCategories: [], departments: [], centers: [] });
  // Default: the viewer holds no unit grants → empty scope → Forbidden unless
  // they are a superuser / comms_steward.
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe("/edit/scholars — authorization", () => {
  it("signed-out → SAML redirect with ?return=/edit/scholars", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditScholarsPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/scholars",
    );
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser with an empty scope → ForbiddenEditPage inside ConsoleShell, no roster query", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    // B8 — the denial branch is wrapped in the same ConsoleShell the success
    // path uses, so the top-level element is the shell and ForbiddenEditPage
    // is its child, not the return value itself.
    expect(asEl(result.props.children).type).toBe(mockForbidden);
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
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

    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    const scope = opts.scope as { all: boolean; unitCodes: string[]; centerCodes: string[] };
    expect(scope.all).toBe(false);
    expect(scope.unitCodes.sort()).toEqual(["DEPT1", "DIV1", "DIV2"]);
    expect(scope.centerCodes).toEqual(["CTR1"]);
  });

  it("a superuser is NOT scope-filtered (sees everyone, as before)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp() });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.scope).toEqual({ all: true });
  });

  it("narrows the org-unit filter dropdowns to the curator's own scope", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPT1" }]);
    mockDivisionFindMany.mockResolvedValue([{ code: "DIV1" }]);
    mockLoadDataQualityFacets.mockResolvedValue({
      roleCategories: [{ value: "full_time_faculty", label: "Full-time faculty", count: 5 }],
      departments: [
        {
          value: "dept:DEPT1",
          label: "Mine",
          count: 3,
          divisions: [{ value: "div:DIV1", label: "Mine div (Mine)", count: 2 }],
        },
        {
          value: "dept:DEPT9",
          label: "Theirs",
          count: 4,
          divisions: [{ value: "div:DIV9", label: "Theirs div (Theirs)", count: 1 }],
        },
      ],
      centers: [{ value: "center:CTR9", label: "Not mine", count: 1 }],
    });

    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    const roster = asEl(result.props.children);
    const facets = roster.props.facets as {
      departments: Array<{ value: string; divisions: unknown[] }>;
      centers: unknown[];
      roleCategories: unknown[];
    };
    expect(facets.departments).toEqual([
      {
        value: "dept:DEPT1",
        label: "Mine",
        count: 3,
        divisions: [{ value: "div:DIV1", label: "Mine div (Mine)", count: 2 }],
      },
    ]);
    expect(facets.centers).toEqual([]);
    // Person type is not unit-specific — it stays whole.
    expect(facets.roleCategories).toHaveLength(1);
  });

  // Real bug this pins (found while writing this suite): the page filters
  // `departments` down to `{...d, divisions: d.divisions.filter(inScope)}.filter(d
  // => inScope(d) || d.divisions.length > 0)` — so a division-only curator's
  // PARENT department is never itself in `scope.unitCodes`, but it must still
  // survive the filter, carrying only their one in-scope division, or their
  // division would have nowhere to nest in the facet UI.
  it("a division-only curator's parent department survives the facet filter, carrying only their division", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "division", entityId: "DIV1" }]);
    mockLoadDataQualityFacets.mockResolvedValue({
      roleCategories: [],
      departments: [
        {
          value: "dept:DEPT1",
          label: "Parent Dept",
          count: 5,
          divisions: [
            { value: "div:DIV1", label: "Mine (Parent Dept)", count: 2 },
            { value: "div:DIV2", label: "Not mine (Parent Dept)", count: 3 },
          ],
        },
        { value: "dept:DEPT9", label: "Unrelated Dept", count: 1, divisions: [] },
      ],
      centers: [],
    });

    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    const roster = asEl(result.props.children);
    const facets = roster.props.facets as {
      departments: Array<{ value: string; divisions: Array<{ value: string }> }>;
    };

    expect(facets.departments).toHaveLength(1);
    expect(facets.departments[0].value).toBe("dept:DEPT1");
    expect(facets.departments[0].divisions).toEqual([
      { value: "div:DIV1", label: "Mine (Parent Dept)", count: 2 },
    ]);
  });

  it("a curator never gets the superuser 'View as' affordance", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPT1" }]);
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    expect(asEl(result.props.children).props.canImpersonate).toBe(false);
  });

  it("superuser → renders the roster from a roster query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadDataQualityRoster.mockResolvedValue({
      entries: [ENTRY],
      total: 1,
      counts: { ...COUNTS, inScope: 1 },
    });
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    expect(result.type).not.toBe(mockForbidden);
    const roster = asEl(result.props.children);
    expect(roster.type).toBe(mockRoster);
    expect(roster.props.total).toBe(1);
    expect(mockLoadDataQualityRoster).toHaveBeenCalledOnce();
  });

  // Every viewer who reaches the page sees Status — it's not gated at all.
  it("passes isVisible through to a row regardless of role", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPT1" }]);
    mockLoadDataQualityRoster.mockResolvedValue({
      entries: [
        { ...ENTRY, cwid: "vis1", isVisible: true },
        { ...ENTRY, cwid: "hid1", isVisible: false },
      ],
      total: 2,
      counts: { ...COUNTS, inScope: 2 },
    });
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    const roster = asEl(result.props.children);
    const entries = roster.props.entries as Array<{ cwid: string; isVisible: boolean }>;
    expect(entries.find((e) => e.cwid === "vis1")?.isVisible).toBe(true);
    expect(entries.find((e) => e.cwid === "hid1")?.isVisible).toBe(false);
  });

  it("no longer passes a canSeeCoi prop to ProfilesRoster at all — COI is gone from this page", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    const roster = asEl(result.props.children);
    expect(roster.props.canSeeCoi).toBeUndefined();
  });
});

describe("/edit/scholars — gap sanitization (COI never leaks into Profiles)", () => {
  // The key security-relevant assertion: not just no COI column rendered — the
  // query itself is narrowed server-side, so a crafted `?gap=has-coi` can't leak
  // COI presence through which rows come back, for ANY viewer of this page.
  it("forces gap to 'all' server-side despite ?gap=has-coi, for a superuser", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp({ gap: "has-coi" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("all");
  });

  it("forces gap to 'all' server-side despite ?gap=has-coi, for a non-superuser unit Owner/Curator", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([{ entityType: "department", entityId: "DEPT1" }]);
    await EditScholarsPage({ searchParams: sp({ gap: "has-coi" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("all");
  });

  it("passes a Profiles-native gap value (no-headshot) straight through", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp({ gap: "no-headshot" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("no-headshot");
  });

  it("passes the other Profiles-native gap value (no-overview) straight through too", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp({ gap: "no-overview" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("no-overview");
  });
});

describe("/edit/scholars — query parsing", () => {
  it("parses q, type, unit, gap, overviewAge, and page into the roster query", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({
      searchParams: sp({
        q: "  smith ",
        type: "postdoc",
        unit: "dept:MED",
        gap: "no-headshot",
        overviewAge: "lt1yr",
        page: "2",
      }),
    });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts).toMatchObject({
      query: "smith",
      roleCategories: ["postdoc"],
      units: [{ kind: "department", code: "MED" }],
      gap: "no-headshot",
      overviewAge: "lt1yr",
      limit: 100, // PAGE_SIZE
      offset: 200, // page 2 * PAGE_SIZE
    });
  });

  it("defaults a bad page to 0", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditScholarsPage({ searchParams: sp({ page: "-3" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
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
            isChair: false,
            isChief: false,
            leadership: null,
            leadershipTier: 3,
            isVisible: true,
            headshot: "present",
            hasOverview: true,
            overviewUpdatedAt: "2026-01-01T00:00:00.000Z",
            overviewState: "lt1yr",
            pendingCoiHigh: 0,
            pendingCoiMedium: 0,
            prominence: 1.2,
            editHref: "/edit/scholar/abc1001",
          },
        ]}
        total={1}
        counts={{ ...COUNTS, inScope: 1 }}
        facets={{ roleCategories: [], departments: [], centers: [] }}
        roleCategories={[]}
        units={[]}
        q=""
        gap="all"
        overviewAge="all"
        includeHidden={true}
        page={0}
        pageSize={100}
        canImpersonate={false}
        viewerCwid="adm001"
        {...overrides}
      />,
    );
  }

  it("renders the scholar name as a link to editHref (the name is the link text)", async () => {
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

  it("renders the Status chip reflecting isVisible, for every viewer (not gated at all)", async () => {
    await renderRoster({
      entries: [
        {
          cwid: "abc1001",
          slug: "abc",
          name: "Ada Lovelace",
          title: null,
          unit: null,
          roleCategory: null,
          isChair: false,
          isChief: false,
          leadership: null,
          leadershipTier: 3,
          isVisible: false,
          headshot: "present",
          hasOverview: true,
          overviewUpdatedAt: "2026-01-01T00:00:00.000Z",
          overviewState: "lt1yr",
          pendingCoiHigh: 0,
          pendingCoiMedium: 0,
          prominence: 1.2,
          editHref: "/edit/scholar/abc1001",
        },
      ],
    });
    const row = screen.getByTestId("roster-row-abc1001");
    expect(row.textContent).toContain("Hidden");
  });

  it("never renders a COI column or cell — COI lives on /edit/coi now", async () => {
    await renderRoster();
    const table = screen.getByRole("table");
    expect(table.textContent).not.toContain("COI");
  });
});
