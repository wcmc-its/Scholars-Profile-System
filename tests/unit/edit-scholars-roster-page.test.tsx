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
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadEditRoster: vi.fn(),
  mockLoadRosterFacets: vi.fn(),
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
  db: { read: { scholar: { findUnique: vi.fn().mockResolvedValue(null) } }, write: {} },
}));

import EditScholarsPage from "@/app/edit/scholars/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

const ADMIN = { cwid: "adm001", isSuperuser: true };
const SELF = { cwid: "self01", isSuperuser: false };

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
});

describe("/edit/scholars — authorization", () => {
  it("signed-out → SAML redirect with ?return=/edit/scholars", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditScholarsPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/scholars",
    );
    expect(mockLoadEditRoster).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser → ForbiddenEditPage, no roster query", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asEl(await EditScholarsPage({ searchParams: sp() }));
    expect(result.type).toBe(mockForbidden);
    expect(mockLoadEditRoster).not.toHaveBeenCalled();
    // requireSuperuserGet emits the denial line.
    expect(console.warn).toHaveBeenCalled();
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
