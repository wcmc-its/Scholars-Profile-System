/**
 * `app/edit/scholars/page.tsx` — the Profiles roster page (#160 UI follow-up).
 * Route-level authorization + query-wiring tests. Mocks the boundary deps and
 * uses the real `requireSuperuserGet` (so the denial log line is exercised),
 * mirroring the `/edit/scholar/[cwid]` page test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/api/edit-roster", () => ({
  loadEditRoster: mockLoadEditRoster,
  loadRosterFacets: mockLoadRosterFacets,
}));
vi.mock("@/components/edit/profiles-roster", () => ({ ProfilesRoster: mockRoster }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
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
    expect(result.type).toBe(mockRoster);
    expect(result.props.total).toBe(1);
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
