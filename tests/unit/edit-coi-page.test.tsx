/**
 * `app/edit/coi/page.tsx` — the COI (conflict-of-interest) dashboard.
 * Superuser-only AND behind `EDIT_DATA_QUALITY_DASHBOARD`, with NO
 * comms_steward / unit-admin escape hatch at all (unlike `/edit/scholars`) —
 * a non-superuser 404s regardless of any unit grants, and scope is always
 * `{ all: true }` (`loadDataQualityScope` is never even called).
 *
 * Mirrors `tests/unit/edit-scholars-roster-page.test.tsx`'s structure and
 * mocking idiom — same `getEffectiveEditSession`/`loadDataQualityRoster`/
 * `loadDataQualityFacets` mocks, same real-`ConsoleShell`-as-unevaluated-JSX
 * inspection technique (no `render()` needed for the authorization/wiring
 * assertions).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockLoadDataQualityRoster,
  mockLoadDataQualityFacets,
  mockRedirect,
  mockNotFound,
  mockEnabled,
  mockScope,
  mockRoster,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadDataQualityRoster: vi.fn(),
  mockLoadDataQualityFacets: vi.fn(),
  mockScope: vi.fn(),
  mockEnabled: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRoster: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
}));
vi.mock("@/lib/api/data-quality", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api/data-quality")>();
  return {
    ...actual, // keep the real parseDataQualityParams so param threading is exercised
    loadDataQualityRoster: mockLoadDataQualityRoster,
    loadDataQualityFacets: mockLoadDataQualityFacets,
  };
});
// `loadDataQualityScope` is mocked here purely so we can assert it's NEVER
// called from this page — unlike `/edit/scholars`, there's no unit-scoped
// variant of the COI dashboard to resolve.
vi.mock("@/lib/edit/data-quality", () => ({
  isDataQualityDashboardEnabled: mockEnabled,
  loadDataQualityScope: mockScope,
}));
vi.mock("@/components/edit/coi-roster", () => ({ CoiRoster: mockRoster }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import EditCoiPage from "@/app/edit/coi/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "stw001", isSuperuser: false, isCommsSteward: true };
const CURATOR = { cwid: "cur001", isSuperuser: false, isCommsSteward: false };
const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };

const COUNTS = { inScope: 0, missingHeadshot: 0, missingOverview: 0, withCoi: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadDataQualityRoster.mockResolvedValue({ entries: [], total: 0, counts: COUNTS });
  mockLoadDataQualityFacets.mockResolvedValue({ roleCategories: [], departments: [], centers: [] });
  mockEnabled.mockReturnValue(true);
});

describe("/edit/coi — authorization", () => {
  it("signed-out → SAML redirect with ?return=/edit/coi", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditCoiPage({ searchParams: sp() })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/coi",
    );
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
  });

  it("comms_steward → 404 (notFound), even with the flag on", async () => {
    mockGetEditSession.mockResolvedValue(STEWARD);
    await expect(EditCoiPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
  });

  // No grant-based access here at all — unlike Profiles, a unit Owner/Curator
  // never earns this tab no matter what they administer.
  it("unit Owner/Curator → 404 (notFound), regardless of any unit grants, even with the flag on", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    await expect(EditCoiPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
  });

  it("a plain scholar (self) → 404 (notFound), even with the flag on", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    await expect(EditCoiPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
  });

  it("superuser + flag OFF → 404 (notFound) — a dark deployment never reveals the route exists", async () => {
    mockEnabled.mockReturnValue(false);
    mockGetEditSession.mockResolvedValue(ADMIN);
    await expect(EditCoiPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockLoadDataQualityRoster).not.toHaveBeenCalled();
  });

  it("superuser + flag ON → renders, scope is always { all: true }, loadDataQualityScope is never called", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const result = asEl(await EditCoiPage({ searchParams: sp() }));
    expect(result.props.active).toBe("coi");
    expect(mockLoadDataQualityRoster).toHaveBeenCalledOnce();
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.scope).toEqual({ all: true });
    expect(mockScope).not.toHaveBeenCalled();
  });

  it('renders with active="coi" passed to ConsoleShell', async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const result = asEl(await EditCoiPage({ searchParams: sp() }));
    expect(result.props.active).toBe("coi");
    const roster = asEl(result.props.children);
    expect(roster.type).toBe(mockRoster);
  });
});

describe("/edit/coi — gap sanitization", () => {
  it("passes ?gap=has-coi straight through", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditCoiPage({ searchParams: sp({ gap: "has-coi" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("has-coi");
  });

  it("silently sanitizes a Profiles-only gap value (?gap=no-headshot) down to 'all'", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditCoiPage({ searchParams: sp({ gap: "no-headshot" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("all");
  });

  it("silently sanitizes the other Profiles-only gap value (?gap=no-overview) down to 'all' too", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditCoiPage({ searchParams: sp({ gap: "no-overview" }) });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("all");
  });

  it("defaults to 'all' with no gap param", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await EditCoiPage({ searchParams: sp() });
    const [opts] = mockLoadDataQualityRoster.mock.calls[0];
    expect(opts.gap).toBe("all");
  });
});
