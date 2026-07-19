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
import { describe, expect, it, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/api/edit-context", () => ({ loadEditContext: mockLoadEditContext }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findMany: async () => [] },
      scholarProxy: { findMany: async () => [] },
    },
    write: {},
  },
}));
vi.mock("@/lib/edit/proxy-authz", () => ({ scholarsServedByProxy: mockScholarsServedByProxy }));
vi.mock("@/lib/edit/unit-scholar-authz", () => ({
  listUnitAdminEditorsForScholar: mockListUnitAdminEditors,
}));
vi.mock("@/lib/edit/administrators", () => ({ isAdministratorsTabEnabled: () => false }));
vi.mock("@/lib/edit/coi-gap-hint", () => ({ isCoiGapHintEnabled: () => false }));
vi.mock("@/lib/edit/manual-highlights", () => ({ isManualHighlightsEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  loadLatestSlugRequest: async () => null,
  countPendingSlugRequests: mockCountPendingSlugRequests,
}));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: mockLoadManageableUnits }));
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
  mockLoadManageableUnits.mockResolvedValue({ departments: [], divisions: [], centers: [] });
  mockListUnitAdminEditors.mockResolvedValue([]);
  mockCountPendingSlugRequests.mockResolvedValue(0);
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
