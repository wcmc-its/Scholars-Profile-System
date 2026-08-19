/**
 * `app/edit/page.tsx` — the #536 hidden-identity-class guard on the SELF
 * `/edit` surface (Finding #2 — parity with `/edit/scholar/[cwid]`).
 *
 * A hidden identity class (doctoral student / alumnus, per `lib/eligibility.ts`
 * — only `doctoral_student` and `affiliate_alumni`) has no public profile, so
 * its self-edit surface is reachable only by a superuser. The page is a Server
 * Component; we mock its boundary dependencies and assert the guard's three
 * branches:
 *
 *   (a) a genuine non-superuser self viewer with a hidden roleCategory → notFound().
 *   (b) a publicly-displayed scholar → renders the EditPage normally.
 *   (c) the real signed-in superuser → allowed through even for a hidden
 *       roleCategory, including while impersonating the hidden target via
 *       `getEffectiveCwid` (the live verdict keys on `session.cwid`, the human).
 *
 * The unrelated render wiring (rail/panel internals, slug card, console nav) is
 * out of scope — we only assert the route's branch via the JSX it returns
 * (component spy) or the thrown `notFound()` sentinel.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetSession,
  mockGetEffectiveCwid,
  mockIsSuperuser,
  mockLoadEditContext,
  mockNotFound,
  mockRedirect,
  mockEditPage,
  mockScholarsServedByProxy,
  mockLoadManageableUnits,
  mockListUnitAdminEditors,
  mockCountPendingSlugRequests,
  mockIsHonorsCurator,
  mockIsDeveloper,
  mockResolveGlobalRole,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetEffectiveCwid: vi.fn(),
  mockIsSuperuser: vi.fn(),
  mockLoadEditContext: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  // Spy on the rendered shell — assert the page reached the render branch by
  // checking the spy's invocation; the return value is irrelevant here.
  mockEditPage: vi.fn(() => null),
  mockScholarsServedByProxy: vi.fn(),
  mockLoadManageableUnits: vi.fn(),
  mockListUnitAdminEditors: vi.fn(),
  mockCountPendingSlugRequests: vi.fn(),
  mockIsHonorsCurator: vi.fn(),
  mockIsDeveloper: vi.fn(),
  mockResolveGlobalRole: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
// `getEffectiveCwid` is the impersonation seam — mocked so a test can point the
// EFFECTIVE editing cwid at a hidden target while `session.cwid` stays the human.
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveCwid: mockGetEffectiveCwid }));
// The guard re-checks the REAL signed-in user's superuser verdict (`session.cwid`).
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: mockIsSuperuser }));
vi.mock("@/lib/auth/comms-steward", () => ({
  isCommsSteward: vi.fn(async () => false),
  isMethodsTabVisible: () => false,
}));
vi.mock("@/lib/auth/global-roles", () => ({
  resolveGlobalRole: mockResolveGlobalRole,
  // Real values, not mocked-away — plain data, no I/O — so a redirect
  // assertion below catches a drifted href the same way it would in prod.
  GLOBAL_ROLE_HOME: {
    cv_generator: { href: "/edit/scholars", label: "Profiles (read-only)" },
    honors_curator: { href: "/edit/honors-queue", label: "Honors queue" },
    data_sharing_viewer: { href: "/edit/data-sharing", label: "Data sharing" },
    development: { href: "/edit/find-researchers", label: "Funding matcher" },
  },
}));
vi.mock("@/lib/api/edit-context", () => ({ loadEditContext: mockLoadEditContext }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findMany: async () => [] },
      scholarProxy: { findMany: async () => [] },
      honor: { count: async () => 0 },
    },
    write: {},
  },
}));
vi.mock("@/lib/edit/proxy-authz", () => ({ scholarsServedByProxy: mockScholarsServedByProxy }));
vi.mock("@/lib/edit/unit-scholar-authz", () => ({
  listUnitAdminEditorsForScholar: mockListUnitAdminEditors,
}));
vi.mock("@/lib/edit/administrators", () => ({
  isAdministratorsTabEnabled: () => false,
  isAdministratorsTabVisible: () => false,
  loadOwnerManagedUnitScope: async () => [],
}));
vi.mock("@/lib/edit/usage-access", () => ({ canViewUsage: async () => false }));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportableUnitsForActor: async () => [],
}));
vi.mock("@/lib/edit/coi-gap-hint", () => ({ isCoiGapHintEnabled: () => false }));
vi.mock("@/lib/edit/manual-highlights", () => ({ isManualHighlightsEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  loadLatestSlugRequest: async () => null,
  countPendingSlugRequests: mockCountPendingSlugRequests,
}));
vi.mock("@/lib/edit/manageable-units", () => ({
  loadManageableUnits: mockLoadManageableUnits,
  loadAllUnitsDirectory: async () => [],
}));
vi.mock("@/lib/auth/honors-curator", () => ({ isHonorsCurator: mockIsHonorsCurator }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: mockIsDeveloper }));
vi.mock("@/components/edit/edit-page", () => ({
  EditPage: mockEditPage,
  visibleAttrKeys: () => ["home"],
}));
vi.mock("@/components/edit/admin-subnav", () => ({ AdminSubnav: vi.fn(() => null) }));
vi.mock("@/components/edit/proxy-landing", () => ({ ProxyLanding: vi.fn(() => null) }));

import EditSelfPage from "@/app/edit/page";

/**
 * A minimal edit-context with a controllable `roleCategory`. The route reads
 * `ctx.scholar.roleCategory` for the #536 guard, the COI-gap rail counts
 * (`ctx.unmatchedPubmedCoi` / `ctx.unmatchedPubmedCoiReviewed`, #953), and
 * `ctx.highlights` for the valid-`?attr` set; everything else is shell wiring.
 */
function fakeCtx(cwid: string, roleCategory: string | null) {
  return {
    scholar: {
      cwid,
      slug: cwid,
      preferredName: cwid,
      fullName: cwid,
      overview: "",
      roleCategory,
      slugOverride: null,
      suppression: { ownRow: null, adminRow: null },
    },
    publications: [],
    unmatchedPubmedCoi: [],
    unmatchedPubmedCoiReviewed: [],
    reporterProfileCandidates: [],
    reporterProfileConfirmed: [],
    highlights: null,
    technologies: [],
    news: [],
    datasets: [],
  };
}

function searchParams(): Promise<{ attr?: string }> {
  return Promise.resolve({});
}

type ReactElementLike = { type: unknown; props: Record<string, unknown> };

function asElement(value: unknown): ReactElementLike {
  return value as ReactElementLike;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Default: a genuine non-impersonating self viewer who is not a superuser.
  mockGetSession.mockResolvedValue({ cwid: "self01" });
  mockGetEffectiveCwid.mockImplementation((s: { cwid: string }) => s.cwid);
  mockIsSuperuser.mockResolvedValue(false);
  // Not a proxy → the null-ctx branch ends in notFound(); irrelevant when ctx is set.
  mockScholarsServedByProxy.mockResolvedValue([]);
  // Fan-out reads after the guard — keep them inert so the render branch resolves.
  mockLoadManageableUnits.mockResolvedValue({ departments: [], divisions: [], centers: [], total: 0 });
  mockListUnitAdminEditors.mockResolvedValue([]);
  mockCountPendingSlugRequests.mockResolvedValue(0);
  mockIsHonorsCurator.mockResolvedValue(false);
  mockIsDeveloper.mockResolvedValue(false);
  mockResolveGlobalRole.mockResolvedValue(null);
});

describe("/edit (self) — global-role landing (#2482, widened 2026-08-19)", () => {
  it.each([
    ["cv_generator", "/edit/scholars"],
    ["honors_curator", "/edit/honors-queue"],
    ["data_sharing_viewer", "/edit/data-sharing"],
    ["development", "/edit/find-researchers"],
  ] as const)("no self-profile + %s → redirect to %s", async (role, home) => {
    mockLoadEditContext.mockResolvedValue(null);
    mockResolveGlobalRole.mockResolvedValue(role);
    await expect(EditSelfPage({ searchParams: searchParams() })).rejects.toThrow(
      `__REDIRECT__:${home}`,
    );
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("no global role, no self-profile, no proxy grants → notFound() (unchanged)", async () => {
    mockLoadEditContext.mockResolvedValue(null);
    await expect(EditSelfPage({ searchParams: searchParams() })).rejects.toThrow("__NOT_FOUND__");
  });
});

describe("/edit (self) — #536 hidden-identity-class guard", () => {
  it("(a) a genuine non-superuser self viewer with a doctoral_student ctx → notFound()", async () => {
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", "doctoral_student"));
    await expect(EditSelfPage({ searchParams: searchParams() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockEditPage).not.toHaveBeenCalled();
    // The guard fires on the REAL signed-in user's verdict, not the effective cwid.
    expect(mockIsSuperuser).toHaveBeenCalledWith("self01");
  });

  it("(a') the other hidden class (affiliate_alumni) also 404s for a non-superuser", async () => {
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", "affiliate_alumni"));
    await expect(EditSelfPage({ searchParams: searchParams() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockEditPage).not.toHaveBeenCalled();
  });

  it("(b) a publicly-displayed scholar (full_time_faculty) → renders the EditPage normally", async () => {
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", "full_time_faculty"));
    const result = asElement(await EditSelfPage({ searchParams: searchParams() }));
    expect(result.type).toBe(mockEditPage);
    expect(result.props.mode).toBe("self");
    expect((result.props.ctx as ReturnType<typeof fakeCtx>).scholar.cwid).toBe("self01");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("(b') a null/unknown roleCategory fails open (publicly displayed) → renders normally", async () => {
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", null));
    const result = asElement(await EditSelfPage({ searchParams: searchParams() }));
    expect(result.type).toBe(mockEditPage);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("(c) the real signed-in superuser is allowed through even for a hidden roleCategory (while impersonating)", async () => {
    // The human is the superuser `adm001`; the "View as" overlay points the
    // EFFECTIVE editing cwid at the hidden doctoral student `phd007`, so the
    // page loads phd007's context. The guard must key on `session.cwid` (adm001,
    // a superuser) — not the effective cwid — and let the editor render.
    mockGetSession.mockResolvedValue({ cwid: "adm001" });
    mockGetEffectiveCwid.mockReturnValue("phd007");
    mockIsSuperuser.mockResolvedValue(true);
    mockLoadEditContext.mockResolvedValue(fakeCtx("phd007", "doctoral_student"));

    const result = asElement(await EditSelfPage({ searchParams: searchParams() }));
    expect(result.type).toBe(mockEditPage);
    expect(mockNotFound).not.toHaveBeenCalled();
    // The superuser re-check ran against the real human, not the hidden target.
    expect(mockIsSuperuser).toHaveBeenCalledWith("adm001");
  });
});

describe("/edit (self) — loadConsoleTabs migration (Gaps 1 / 1b)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("Gap 1 — a pure honors_curator (no other console signal) still gets the console nav", async () => {
    // `isHonorsQueueTabVisible` (which `loadConsoleTabs`'s `honors` predicate
    // delegates to) is ALSO flag-gated — the surface must actually be live for
    // there to be anything to show.
    vi.stubEnv("HONORS_APPROVAL_QUEUE", "on");
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", "full_time_faculty"));
    mockIsHonorsCurator.mockResolvedValue(true);
    const result = asElement(await EditSelfPage({ searchParams: searchParams() }));
    // canBrowseProfiles=false, commsSteward=false, hasUnitGrants=false (empty
    // manageableUnits), developer=false — only honorsCurator is true, and
    // `loadConsoleTabs`'s own `honors` predicate is the ONLY thing deciding
    // whether the strip renders at all now (no separate showConsoleNav gate
    // left to forget a role in).
    expect(result.props.consoleNav).toBeTruthy();
  });

  it("Gap 1b — a pure development-role viewer gets viewerIsDeveloper threaded into AdminSubnav", async () => {
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", "full_time_faculty"));
    mockIsDeveloper.mockResolvedValue(true);
    const result = asElement(await EditSelfPage({ searchParams: searchParams() }));
    const consoleNav = asElement(result.props.consoleNav);
    expect(consoleNav.props.viewerIsDeveloper).toBe(true);
  });

  it("a plain scholar (no roles) still gets no console nav — the migration doesn't over-widen", async () => {
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01", "full_time_faculty"));
    const result = asElement(await EditSelfPage({ searchParams: searchParams() }));
    expect(result.props.consoleNav).toBeUndefined();
  });
});
