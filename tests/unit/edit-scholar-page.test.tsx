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
  mockScholarProxyFindUnique,
  mockProxyScholarFindUnique,
  mockUnitAdminFindFirst,
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
  // #779 — the page-gate proxy probe (scholarProxy.findUnique) and the three-leg
  // D3 conflict re-check's scholar.findUnique + unitAdmin.findFirst legs. The
  // page supplies its own isSuperuserFn closure (() => session.isSuperuser), so
  // the superuser leg needs no separate mock here.
  mockScholarProxyFindUnique: vi.fn(),
  mockProxyScholarFindUnique: vi.fn(),
  mockUnitAdminFindFirst: vi.fn(),
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
// #779 — the page probes for a proxy grant (page-gate authz), runs the D3
// conflict re-check, and loads the scholar's proxy editors. The default-no-grant
// authorization-matrix tests leave scholarProxy.findUnique → null; the proxy
// tests at the end override it. `findMany` backs the "Proxy editors" panel
// (self/superuser modes only).
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: mockProxyScholarFindUnique },
      unitAdmin: { findFirst: mockUnitAdminFindFirst },
      scholarProxy: { findUnique: mockScholarProxyFindUnique, findMany: async () => [] },
    },
    write: {},
  },
}));
vi.mock("@/components/edit/edit-page", () => ({
  EditPage: mockEditPage,
  // The route canonicalizes an invalid `?attr` against this set (T1.13). Mirror
  // the real per-mode visible keys; the flag arg doesn't change membership.
  visibleAttrKeys: (mode: "self" | "superuser") =>
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
  // #779 — default: no proxy grant + a clean conflict re-check. Proxy tests override.
  mockScholarProxyFindUnique.mockResolvedValue(null);
  mockProxyScholarFindUnique.mockResolvedValue(null);
  mockUnitAdminFindFirst.mockResolvedValue(null);
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
    expect(mockLoadEditContext).toHaveBeenCalledWith("self01", expect.anything());
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

  // ─── #779 — scholar-assigned proxy editor page gate (scholar-proxy-spec.md
  // § "Must fix" #12). A granted, conflict-free proxy reaches EXACTLY their
  // granted scholar's edit surface in `mode='proxy'`; a since-conflicted proxy
  // is denied; and a proxy is still subject to the #536 hidden-class 404 (IS-9).
  // The probe keys on the RAW identity, only when NOT impersonating. ───
  describe("scholar-assigned proxy page gate (#779)", () => {
    // A non-impersonating proxy: raw.cwid === effective.cwid === proxy01.
    function actingAsProxy() {
      mockGetSession.mockResolvedValue({ cwid: "proxy01" });
      mockGetEditSession.mockResolvedValue({ cwid: "proxy01", isSuperuser: false });
    }

    it("a granted, conflict-free proxy → EditPage(mode='proxy'), no proxy-editors panel", async () => {
      actingAsProxy();
      mockScholarProxyFindUnique.mockImplementation(
        async ({
          where,
        }: {
          where: { scholarCwid_proxyCwid: { scholarCwid: string; proxyCwid: string } };
        }) => {
          const { scholarCwid, proxyCwid } = where.scholarCwid_proxyCwid;
          return scholarCwid === "schA" && proxyCwid === "proxy01" ? { scholarCwid } : null;
        },
      );
      mockLoadEditContext.mockResolvedValue(fakeCtx("schA"));
      const result = asElement(await EditScholarPage({ params: params("schA") }));
      expect(result.type).toBe(mockEditPage);
      expect(result.props.mode).toBe("proxy");
      // a proxy can never manage the designee list — the panel is absent in proxy mode
      expect(result.props.proxyEditors).toBeNull();
    });

    it("a proxy of schA visiting schB (no grant) → ForbiddenEditPage (composite-PK binding)", async () => {
      actingAsProxy();
      // grant exists for schA only; the page asks for (schB, proxy01) → miss
      mockScholarProxyFindUnique.mockImplementation(
        async ({
          where,
        }: {
          where: { scholarCwid_proxyCwid: { scholarCwid: string; proxyCwid: string } };
        }) => (where.scholarCwid_proxyCwid.scholarCwid === "schA" ? { scholarCwid: "schA" } : null),
      );
      const result = asElement(await EditScholarPage({ params: params("schB") }));
      expect(result.type).toBe(mockForbiddenEditPage);
      expect(mockLoadEditContext).not.toHaveBeenCalled();
    });

    it("a granted proxy who has since become a scholar → ForbiddenEditPage (conflict re-check at GET)", async () => {
      actingAsProxy();
      mockScholarProxyFindUnique.mockResolvedValue({ scholarCwid: "schA" }); // grant present
      mockProxyScholarFindUnique.mockResolvedValue({ deletedAt: null }); // proxy01 is now an active scholar
      const result = asElement(await EditScholarPage({ params: params("schA") }));
      expect(result.type).toBe(mockForbiddenEditPage);
      expect(mockLoadEditContext).not.toHaveBeenCalled();
    });

    it("a hidden-class scholar (doctoral_student) → notFound() even for a granted proxy (IS-9)", async () => {
      actingAsProxy();
      mockScholarProxyFindUnique.mockResolvedValue({ scholarCwid: "schA" }); // grant present, clean conflict
      const ctx = fakeCtx("schA");
      mockLoadEditContext.mockResolvedValue({
        ...ctx,
        scholar: { ...ctx.scholar, roleCategory: "doctoral_student" },
      });
      await expect(EditScholarPage({ params: params("schA") })).rejects.toThrow("__NOT_FOUND__");
    });
  });
});
