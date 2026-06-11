/**
 * `app/edit/scholar/[cwid]/page.tsx` — route-level authorization matrix tests
 * (#356 Phase 7 C6, plan §10.1).
 *
 * The page is a Server Component. We mock the four boundary dependencies it
 * pulls in — `next/navigation` (redirect, notFound), `getEditSession`,
 * `loadEditContext`, and the `db` import (kept inert) — and assert the four
 * branches the page implements:
 *
 *   1. signed-out → SAML redirect with `?return=…`.
 *   2. signed-in non-superuser on someone else's cwid → ForbiddenEditPage +
 *      one `edit_authz_denied` log line with `reason="not_superuser_get"`.
 *   3. signed-in non-superuser on own cwid → EditPage(mode='self').
 *   4. signed-in superuser on someone else's cwid → EditPage(mode='superuser').
 *   5. signed-in + loadEditContext null → notFound().
 *
 * The render component bodies are out of scope here; we only assert the route's
 * branching choice via the JSX it returns (component name + props) or the
 * thrown sentinel from `redirect()` / `notFound()`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockGetEditSession,
  mockLoadEditContext,
  mockRedirect,
  mockNotFound,
  mockEditPage,
  mockForbiddenEditPage,
  // Amendment 4 — the unit-admin page gate reads these (resolver + banner name).
  mockScholarFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
  mockDepartmentFindUnique,
  mockDivisionFindUnique,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetEditSession: vi.fn(),
  mockLoadEditContext: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    // The real next/navigation `redirect()` throws a sentinel; mimic the
    // throw so the page handler stops, mirroring real behavior.
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  // Spy on each component — assert which branch the page handler picked by
  // checking the spy's invocation. The return value is irrelevant since we
  // don't render the result; the page handler just hands us back a React
  // element whose `type` is the spy.
  mockEditPage: vi.fn(() => null),
  mockForbiddenEditPage: vi.fn(() => null),
  mockScholarFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));
// The page resolves the login gate from the RAW session (session-server) and
// the authorization identity from the EFFECTIVE seam (effective-identity), so
// impersonation re-derives the self/superuser branch (#637).
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/edit-context", () => ({ loadEditContext: mockLoadEditContext }));
// #779 — the page now probes for a proxy grant (page-gate authz) and loads the
// scholar's proxy editors. No grants in these authorization-matrix tests.
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholarProxy: { findUnique: async () => null, findMany: async () => [] },
      // Amendment 4 — the unit-admin gate's resolver + the banner name lookup.
      scholar: { findUnique: mockScholarFindUnique },
      divisionMembership: { findMany: mockDivisionMembershipFindMany },
      division: { findMany: mockDivisionFindMany, findUnique: mockDivisionFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
      department: { findUnique: mockDepartmentFindUnique },
    },
    write: {},
  },
}));
vi.mock("@/components/edit/edit-page", () => ({
  EditPage: mockEditPage,
  // The route canonicalizes an invalid `?attr` against this set (T1.13). Mirror
  // the real per-mode visible keys; the flag arg doesn't change membership.
  visibleAttrKeys: (mode: "self" | "superuser" | "proxy" | "unit-admin") =>
    mode === "superuser"
      ? ["home", "name-title", "photo", "overview", "visibility", "funding", "appointments", "education", "profile-url"]
      : ["home", "name-title", "photo", "overview", "visibility", "publications", "funding", "appointments", "education", "profile-url"],
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: mockForbiddenEditPage,
}));

import EditScholarPage from "@/app/edit/scholar/[cwid]/page";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

const fakeCtx = (cwid: string) => ({
  scholar: { cwid, slug: cwid, preferredName: cwid, fullName: cwid, overview: "", slugOverride: null, suppression: { ownRow: null, adminRow: null } },
  publications: [],
  // The real loader always returns these (array + nullable); the page reads them
  // to derive the valid `?attr` set (#836 highlights + COI-gap visibility).
  unmatchedPubmedCoi: [],
  highlights: null,
});

function params(cwid: string): Promise<{ cwid: string }> {
  return Promise.resolve({ cwid });
}

function searchParams(attr?: string): Promise<{ attr?: string }> {
  return Promise.resolve(attr === undefined ? {} : { attr });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Raw session present by default (the SAML-login gate keys on the real human);
  // the effective session drives the authorization branch per test.
  mockGetSession.mockResolvedValue({ cwid: "raw" });
  mockGetEditSession.mockResolvedValue(null);
  mockLoadEditContext.mockResolvedValue(null);
  // Amendment 4 — default: no unit-admin access (resolver short-circuits on a
  // missing scholar row). Overridden in the unit-admin test below.
  mockScholarFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockDepartmentFindUnique.mockResolvedValue(null);
  mockDivisionFindUnique.mockResolvedValue(null);
});

type ReactElementLike = { type: unknown; props: Record<string, unknown> };

function asElement(value: unknown): ReactElementLike {
  return value as ReactElementLike;
}

describe("/edit/scholar/[cwid] — authorization matrix", () => {
  it("signed-out → SAML redirect with the requested URL as ?return=", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(EditScholarPage({ params: params("other7") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/scholar/other7",
    );
    expect(mockLoadEditContext).not.toHaveBeenCalled();
  });

  it("signed-out with a cwid that needs URL-encoding → return is encoded", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(EditScholarPage({ params: params("a/b c") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/scholar/a%2Fb%20c",
    );
  });

  it("signed-in non-superuser on another cwid → ForbiddenEditPage + audit log line", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asElement(await EditScholarPage({ params: params("other7") }));
    expect(result.type).toBe(mockForbiddenEditPage);
    expect(result.props.targetCwid).toBe("other7");
    expect(mockLoadEditContext).not.toHaveBeenCalled();
    // The log line is emitted by requireSuperuserGet (lib/edit/authz).
    expect(console.warn).toHaveBeenCalled();
    const line = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe("edit_authz_denied");
    expect(parsed.reason).toBe("not_superuser_get");
    expect(parsed.path).toBe("/edit/scholar/other7");
    expect(parsed.actor_cwid).toBe("self01");
    expect(parsed.target_cwid).toBe("other7");
  });

  it("signed-in non-superuser on own cwid → EditPage(mode='self')", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    mockLoadEditContext.mockResolvedValue(fakeCtx("self01"));
    const result = asElement(await EditScholarPage({ params: params("self01") }));
    expect(result.type).toBe(mockEditPage);
    expect(result.props.mode).toBe("self");
    const ctx = result.props.ctx as { scholar: { cwid: string } };
    expect(ctx.scholar.cwid).toBe("self01");
    // #836 — the page now requests highlights context (self or superuser); the
    // opts arg carries the flag-derived `includeHighlights` boolean.
    expect(mockLoadEditContext).toHaveBeenCalledWith(
      "self01",
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({ includeHighlights: expect.any(Boolean) }),
    );
  });

  it("signed-in superuser on another cwid → EditPage(mode='superuser')", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditContext.mockResolvedValue(fakeCtx("other7"));
    const result = asElement(await EditScholarPage({ params: params("other7") }));
    expect(result.type).toBe(mockEditPage);
    expect(result.props.mode).toBe("superuser");
    const ctx = result.props.ctx as { scholar: { cwid: string } };
    expect(ctx.scholar.cwid).toBe("other7");
  });

  it("signed-in superuser on own cwid → EditPage(mode='self') (self path wins over the superuser path)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditContext.mockResolvedValue(fakeCtx("adm001"));
    const result = asElement(await EditScholarPage({ params: params("adm001") }));
    expect(result.props.mode).toBe("self");
  });

  it("loadEditContext returns null → notFound() is called", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditContext.mockResolvedValue(null);
    await expect(EditScholarPage({ params: params("missing") })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("present-but-invalid ?attr → server redirect to the bare route (T1.13)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditContext.mockResolvedValue(fakeCtx("other7"));
    await expect(
      EditScholarPage({ params: params("other7"), searchParams: searchParams("bogus") }),
    ).rejects.toThrow("__REDIRECT__:/edit/scholar/other7");
    expect(mockEditPage).not.toHaveBeenCalled();
  });

  it("a valid ?attr renders normally (no redirect)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditContext.mockResolvedValue(fakeCtx("other7"));
    const result = asElement(
      await EditScholarPage({ params: params("other7"), searchParams: searchParams("funding") }),
    );
    expect(result.type).toBe(mockEditPage);
    expect(result.props.attr).toBe("funding");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("a self-only ?attr (publications) on the superuser surface redirects (mode-aware valid set)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadEditContext.mockResolvedValue(fakeCtx("other7"));
    await expect(
      EditScholarPage({ params: params("other7"), searchParams: searchParams("publications") }),
    ).rejects.toThrow("__REDIRECT__:/edit/scholar/other7");
  });

  it("mid-session deauth (SPEC edge 15) — superuser→non-superuser on subsequent GET → ForbiddenEditPage", async () => {
    // A scholar removed from the group between requests is exactly the case
    // requireSuperuserGet is designed to catch — the GET-time re-check fires
    // and the 403 page renders.
    mockGetEditSession.mockResolvedValue(SELF); // no longer a superuser
    const result = asElement(await EditScholarPage({ params: params("other7") }));
    expect(result.type).toBe(mockForbiddenEditPage);
  });

  // Amendment 4 — org-unit administrator as profile editor.
  it("signed-in unit admin (non-impersonating) on a managed scholar → EditPage(mode='unit-admin') + 'via {unit}' banner", async () => {
    // Non-impersonating: raw === effective, so the unit-admin gate runs (a #637
    // overlay would make raw.cwid !== session.cwid and skip it, IS-1).
    mockGetSession.mockResolvedValue({ cwid: "uadm01" });
    mockGetEditSession.mockResolvedValue({ cwid: "uadm01", isSuperuser: false });
    mockLoadEditContext.mockResolvedValue(fakeCtx("sch001"));
    // sch001 ∈ DEPT-MED; uadm01 holds a curator row over it.
    mockScholarFindUnique.mockResolvedValue({ deptCode: "DEPT-MED", divCode: null, deletedAt: null });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "DEPT-MED", role: "curator" },
    ]);
    mockDepartmentFindUnique.mockResolvedValue({ name: "Medicine" });

    const result = asElement(await EditScholarPage({ params: params("sch001") }));
    expect(result.type).toBe(mockEditPage);
    expect(result.props.mode).toBe("unit-admin");
    expect(result.props.unitAdminBanner).toEqual({ unitKind: "department", unitName: "Medicine" });
    expect(mockForbiddenEditPage).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser with NO unit role (non-impersonating) on another cwid → ForbiddenEditPage", async () => {
    // The unit-admin gate runs but the resolver finds no grant ⇒ the page must
    // still fall through to the superuser re-check and 403 (no over-grant).
    mockGetSession.mockResolvedValue({ cwid: "uadm01" });
    mockGetEditSession.mockResolvedValue({ cwid: "uadm01", isSuperuser: false });
    // default mocks: scholar.findUnique → null ⇒ resolver null ⇒ no unit-admin.
    const result = asElement(await EditScholarPage({ params: params("sch001") }));
    expect(result.type).toBe(mockForbiddenEditPage);
    expect(mockEditPage).not.toHaveBeenCalled();
  });
});
