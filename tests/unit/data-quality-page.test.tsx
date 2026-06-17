/**
 * `/edit/data-quality` route gating (docs/data-quality-dashboard-spec.md):
 * flag-off → 404, empty scope (a plain scholar) → 404, in-scope viewer → renders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSession,
  mockEnabled,
  mockScope,
  mockEmpty,
  mockRoster,
  mockFacets,
  mockNotFound,
  mockRedirect,
} = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockScope: vi.fn(),
  mockEmpty: vi.fn(),
  mockRoster: vi.fn(),
  mockFacets: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockRedirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound, redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/data-quality", () => ({
  isDataQualityDashboardEnabled: mockEnabled,
  loadDataQualityScope: mockScope,
  isEmptyScope: mockEmpty,
}));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityRoster: mockRoster,
  loadDataQualityFacets: mockFacets,
  parseDataQualityParams: vi.fn(() => ({
    q: "",
    roleCategories: [],
    units: [],
    unitValues: [],
    gap: "all",
    overviewAge: "all",
    includeHidden: true,
    page: 0,
  })),
}));
vi.mock("@/lib/auth/comms-steward", () => ({ isMethodsTabVisible: () => false }));
vi.mock("@/lib/edit/administrators", () => ({ isAdministratorsTabEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  countPendingSlugRequests: vi.fn(),
  isSlugRequestEnabled: () => false,
}));
vi.mock("@/lib/db", () => ({
  db: { read: { scholar: { findUnique: vi.fn().mockResolvedValue(null) } } },
}));
vi.mock("@/components/edit/data-quality-dashboard", () => ({ DataQualityDashboard: () => null }));
vi.mock("@/components/edit/admin-subnav", () => ({ AdminSubnav: () => null }));

import Page from "@/app/edit/data-quality/page";

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockScope.mockResolvedValue({ all: true });
  mockEmpty.mockReturnValue(false);
  mockRoster.mockResolvedValue({
    entries: [],
    total: 0,
    counts: { inScope: 0, missingHeadshot: 0, missingOverview: 0, withCoi: 0 },
  });
  mockFacets.mockResolvedValue({ roleCategories: [], departments: [], centers: [] });
});

const run = () => Page({ searchParams: Promise.resolve({}) });

describe("/edit/data-quality route gating", () => {
  it("404s when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockRoster).not.toHaveBeenCalled();
  });

  it("404s for an empty scope (a plain scholar)", async () => {
    mockScope.mockResolvedValue({ all: false, unitCodes: [], centerCodes: [] });
    mockEmpty.mockReturnValue(true);
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockRoster).not.toHaveBeenCalled();
  });

  it("renders for an in-scope viewer and loads the roster", async () => {
    const el = await run();
    expect(el).toBeTruthy();
    expect(mockRoster).toHaveBeenCalledOnce();
  });
});
