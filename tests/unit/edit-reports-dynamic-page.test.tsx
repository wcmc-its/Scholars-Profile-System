/**
 * `app/edit/reports/[report]/page.tsx` — the routing contract of the one
 * dynamic report page (registry plan, 2026-09-20), the part no per-report
 * suite covers. Protects: no session → SSO redirect carrying the segment,
 * before any read; a NUMBER segment → a plain `redirect` (never
 * `permanentRedirect` — the slug is renameable) to the CURRENT slug with the
 * query string carried over, and no gate or loader runs; the slug resolves
 * through `report_meta` (a renamed row wins, the default slug then 404s);
 * an unknown slug → 404; the unit gate hands `resolveNumberedReportCenterCode`
 * the kinds `REPORT_NUMBERS_BY_KIND` allows for THAT report (so `?kind=core`
 * is honoured on report 3 and ignored on report 4); the "← All reports" link
 * carries `center` + `kind` for a non-center unit and is bare for the
 * person-gated report; `generateMetadata` resolves the same way.
 *
 * Collaborators are mocked at the module boundary; `report_meta` is the
 * `reportMeta.findMany` seam on the db mock so the real `loadReportMeta`
 * merges rows over defaults. Each test awaits the page and renders the tree
 * (the mocked `ReportHeader` prints its `n`, the real `Link` prints its href).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockPermanentRedirect: vi.fn((url: string) => {
    throw new Error(`__PERMANENT_REDIRECT__:${url}`);
  }),
  mockReportMetaFindMany: vi.fn(),
  mockResolveNumbered: vi.fn(),
  mockLoadReportsContext: vi.fn(),
  mockGetReportScopes: vi.fn(),
  mockListReportAccess: vi.fn(),
  mockLoadPubsReport: vi.fn(),
  mockLoadMentoredReport: vi.fn(),
  mockLoadGradYears: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: h.mockNotFound,
  redirect: h.mockRedirect,
  permanentRedirect: h.mockPermanentRedirect,
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: h.mockReportMetaFindMany } }, write: {} },
}));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportsContext: h.mockLoadReportsContext,
  resolveNumberedReportCenterCode: h.mockResolveNumbered,
  REPORT_NUMBERS_BY_KIND: {
    center: [1, 2, 3, 4, 5, 6],
    department: [3, 6],
    division: [3, 6],
    core: [3, 6],
  },
}));
vi.mock("@/lib/edit/report-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/report-access")>();
  return {
    ...actual,
    getReportScopes: h.mockGetReportScopes,
    listReportAccess: h.mockListReportAccess,
  };
});
// Every report loader at its empty state — the bodies are covered elsewhere.
vi.mock("@/lib/edit/cancer-center-publications-report", () => ({
  HIGH_IMPACT_THRESHOLD: 10,
  loadUnitPublicationsReport: h.mockLoadPubsReport,
}));
vi.mock("@/lib/edit/cancer-center-grants-report", () => ({
  loadCenterActiveGrants: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/center-collaboration/clinical-trials-report", () => ({
  loadClinicalTrialsReport: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/edit/nih-funded-publications-report", () => ({
  loadNihFundedPublicationsReport: vi.fn().mockResolvedValue({ totalPublications: 0, rows: [] }),
}));
vi.mock("@/lib/edit/mentored-publications-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/mentored-publications-report")>();
  return {
    ...actual,
    loadMentoredGradYears: h.mockLoadGradYears,
    loadMentoredPublicationsReport: h.mockLoadMentoredReport,
  };
});
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(null),
}));
// Chrome and report bodies, reduced to what the routing contract needs.
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-under-test">{children}</div>
  ),
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: () => <div data-testid="forbidden" />,
}));
vi.mock("@/components/edit/report-header", () => ({
  ReportHeader: ({ n, children }: { n: string; children?: React.ReactNode }) => (
    <>
      <h1 data-testid="report-header" data-n={n}>
        Report {n}
      </h1>
      {children}
    </>
  ),
}));
vi.mock("@/components/edit/report-access-popover", () => ({
  ReportAccessPopover: ({ mode }: { mode: string }) => (
    <span data-testid="popover" data-mode={mode} />
  ),
}));
vi.mock("@/components/edit/cancer-center-collab-report-card", () => ({
  CancerCenterCollabReportCard: () => null,
}));
vi.mock("@/components/edit/cancer-center-nci-2a-card", () => ({ Nci2aCard: () => null }));
vi.mock("@/components/edit/publications-report-table", () => ({
  PublicationsReportTable: () => null,
}));
vi.mock("@/components/edit/mentored-publications-table", () => ({
  MentoredPublicationsTable: () => null,
}));
vi.mock("@/components/edit/auto-submit-form", () => ({ AutoSubmitForm: () => null }));
vi.mock("@/components/ui/hover-tooltip", () => ({
  HoverTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/funding/expanded-grant", () => ({ LowerConfidenceBadge: () => null }));

import EditReportPage, { generateMetadata } from "@/app/edit/reports/[report]/page";
import { resolveSuspense } from "@/tests/util/resolve-suspense";

const OWNER = { cwid: "owner01", isSuperuser: false, isCommsSteward: false };
const SUPERUSER = { cwid: "adm0001", isSuperuser: true, isCommsSteward: false };

const EMPTY_PUBS = {
  totalPublications: 0,
  matchedPublications: 0,
  matchRatePct: 0,
  highImpactCount: 0,
  highImpactRatePct: 0,
  rows: [],
};

/** The page at `segment` with `query`. */
const page = (segment: string, query: Record<string, string | string[]> = {}) =>
  EditReportPage({
    params: Promise.resolve({ report: segment }),
    searchParams: Promise.resolve(query),
  }).then((t) => resolveSuspense(t));

/** Render the awaited tree and return the "← All reports" link's href. */
function renderBackHref(tree: unknown): string | null {
  render(tree as React.ReactElement);
  return screen.getByText("← All reports").getAttribute("href");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.mockGetEditSession.mockResolvedValue(OWNER);
  h.mockReportMetaFindMany.mockResolvedValue([]);
  h.mockResolveNumbered.mockResolvedValue({ code: "meyer", kind: "center" });
  h.mockLoadReportsContext.mockResolvedValue({ unit: { name: "Meyer Cancer Center" } });
  h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
  h.mockListReportAccess.mockResolvedValue([]);
  h.mockLoadPubsReport.mockResolvedValue(EMPTY_PUBS);
  h.mockLoadGradYears.mockResolvedValue([2026, 2025]);
  h.mockLoadMentoredReport.mockResolvedValue({
    summary: [],
    detail: [],
    publications: [],
    generatedAt: new Date("2026-09-20T00:00:00Z"),
    // The loader always echoes its filters; report 7's body reads the set from them.
    filters: { scopes: ["md"], types: ["aoc"], gradYears: null, tail: 1, pubs: "mentored" },
    allPubsLoaded: null,
    droppedUnresolved: 0,
    droppedNoCwid: 0,
  });
});

describe("/edit/reports/[report] — session", () => {
  it("no session → SSO login with the segment as the return path, before any read", async () => {
    h.mockGetEditSession.mockResolvedValue(null);
    await expect(page("mentored-publications")).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/reports/mentored-publications",
    );
    await expect(page("7")).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/reports/7",
    );
    expect(h.mockReportMetaFindMany).not.toHaveBeenCalled();
    expect(h.mockResolveNumbered).not.toHaveBeenCalled();
    expect(h.mockGetReportScopes).not.toHaveBeenCalled();
  });
});

describe("/edit/reports/[report] — number → slug", () => {
  it("a number 307s to the CURRENT slug with the query string carried, via redirect (never permanentRedirect), and no gate or loader runs", async () => {
    await expect(page("7", { years: "2025" })).rejects.toThrow(
      "__REDIRECT__:/edit/reports/mentored-publications?years=2025",
    );
    expect(h.mockRedirect).toHaveBeenCalledWith("/edit/reports/mentored-publications?years=2025");
    expect(h.mockPermanentRedirect).not.toHaveBeenCalled();
    expect(h.mockGetReportScopes).not.toHaveBeenCalled();
    expect(h.mockResolveNumbered).not.toHaveBeenCalled();
    expect(h.mockLoadMentoredReport).not.toHaveBeenCalled();
    expect(h.mockLoadPubsReport).not.toHaveBeenCalled();

    // A unit report: `center` + `kind` ride along; no query → no `?`.
    await expect(page("3", { center: "14", kind: "core" })).rejects.toThrow(
      "__REDIRECT__:/edit/reports/publications?center=14&kind=core",
    );
    await expect(page("4")).rejects.toThrow("__REDIRECT__:/edit/reports/grants");
    expect(h.mockResolveNumbered).not.toHaveBeenCalled();
  });

  it("a renamed slug: the number follows the report_meta row, not the default", async () => {
    h.mockReportMetaFindMany.mockResolvedValue([
      { reportKey: "3", slug: "papers", name: "Papers", summary: "s", descriptionHtml: null },
    ]);
    await expect(page("3")).rejects.toThrow("__REDIRECT__:/edit/reports/papers");
  });
});

describe("/edit/reports/[report] — slug resolution", () => {
  it("a report_meta row renaming report 3 to 'papers': 'papers' resolves to report 3; the old default 'publications' → 404", async () => {
    h.mockReportMetaFindMany.mockResolvedValue([
      { reportKey: "3", slug: "papers", name: "Papers", summary: "s", descriptionHtml: null },
    ]);
    const result = await page("papers", { center: "meyer" });
    render(result as React.ReactElement);
    expect(screen.getByTestId("report-header").getAttribute("data-n")).toBe("3");
    expect(h.mockLoadPubsReport).toHaveBeenCalledWith("center", "meyer");

    cleanup();
    await expect(page("publications", { center: "meyer" })).rejects.toThrow("__NOT_FOUND__");
    expect(h.mockNotFound).toHaveBeenCalledTimes(1);
    // The 404 fires before any gate.
    expect(h.mockResolveNumbered).toHaveBeenCalledTimes(1);
  });

  it("an unknown slug → 404, before any gate", async () => {
    await expect(page("no-such-report")).rejects.toThrow("__NOT_FOUND__");
    expect(h.mockResolveNumbered).not.toHaveBeenCalled();
    expect(h.mockGetReportScopes).not.toHaveBeenCalled();
  });

  it("every default slug resolves to its report", async () => {
    const expected: Array<[slug: string, n: string]> = [
      ["optimize-membership", "1"],
      ["nci-table-2a", "2"],
      ["publications", "3"],
      ["grants", "4"],
      ["clinical-trials", "5"],
      ["nih-funded-pubs", "6"],
      ["mentored-publications", "7"],
    ];
    for (const [slug, n] of expected) {
      cleanup();
      render((await page(slug)) as React.ReactElement);
      expect(screen.getByTestId("report-header").getAttribute("data-n")).toBe(n);
    }
  });
});

describe("/edit/reports/[report] — the unit gate's kinds", () => {
  it("report 4 (center-only): ?kind=core is ignored — allowedKinds ['center'], requestedKind undefined", async () => {
    await page("grants", { center: "X", kind: "core" });
    expect(h.mockResolveNumbered).toHaveBeenCalledWith(OWNER, expect.anything(), "X", {
      allowedKinds: ["center"],
      requestedKind: undefined,
    });
    expect(h.mockLoadReportsContext).toHaveBeenCalledWith(
      "meyer",
      OWNER,
      expect.anything(),
      "center",
    );
  });

  it("report 3 (all four kinds): ?kind=core is honoured — allowedKinds from REPORT_NUMBERS_BY_KIND, requestedKind 'core'", async () => {
    h.mockResolveNumbered.mockResolvedValue({ code: "14", kind: "core" });
    h.mockLoadReportsContext.mockResolvedValue({ unit: { name: "Biomedical Imaging" } });
    await page("publications", { center: "14", kind: "core" });
    expect(h.mockResolveNumbered).toHaveBeenCalledWith(OWNER, expect.anything(), "14", {
      allowedKinds: ["center", "department", "division", "core"],
      requestedKind: "core",
    });
    expect(h.mockLoadReportsContext).toHaveBeenCalledWith("14", OWNER, expect.anything(), "core");
    expect(h.mockLoadPubsReport).toHaveBeenCalledWith("core", "14");
  });

  it("a denied actor gets the 403 page with the unit popover never rendered, and no loader runs", async () => {
    h.mockLoadReportsContext.mockResolvedValue(null);
    render((await page("publications", { center: "meyer" })) as React.ReactElement);
    expect(screen.getByTestId("forbidden")).toBeTruthy();
    expect(screen.queryByTestId("report-header")).toBeNull();
    expect(h.mockLoadPubsReport).not.toHaveBeenCalled();
  });
});

describe("/edit/reports/[report] — the person gate", () => {
  it("an empty scope set → 404 before any data read; a holder gets the person popover and the report", async () => {
    h.mockGetReportScopes.mockResolvedValue(new Set());
    await expect(page("mentored-publications")).rejects.toThrow("__NOT_FOUND__");
    expect(h.mockListReportAccess).not.toHaveBeenCalled();
    expect(h.mockLoadMentoredReport).not.toHaveBeenCalled();

    h.mockGetReportScopes.mockResolvedValue(new Set(["md"]));
    render((await page("mentored-publications")) as React.ReactElement);
    expect(h.mockGetReportScopes).toHaveBeenLastCalledWith(OWNER, "mentored-publications");
    expect(h.mockListReportAccess).toHaveBeenCalledWith("mentored-publications");
    expect(h.mockLoadMentoredReport).toHaveBeenCalledTimes(1);
    expect(h.mockResolveNumbered).not.toHaveBeenCalled();
  });
});

describe("/edit/reports/[report] — the back link", () => {
  it("a division report: center AND kind; a center report: center only; report 7: bare", async () => {
    h.mockResolveNumbered.mockResolvedValue({ code: "n001", kind: "division" });
    h.mockLoadReportsContext.mockResolvedValue({ unit: { name: "Cardiology" } });
    expect(renderBackHref(await page("publications", { center: "n001", kind: "division" }))).toBe(
      "/edit/reports?center=n001&kind=division",
    );

    cleanup();
    h.mockResolveNumbered.mockResolvedValue({ code: "meyer", kind: "center" });
    expect(renderBackHref(await page("grants", { center: "meyer" }))).toBe(
      "/edit/reports?center=meyer",
    );

    cleanup();
    h.mockGetEditSession.mockResolvedValue(SUPERUSER);
    expect(renderBackHref(await page("mentored-publications"))).toBe("/edit/reports");
  });
});

describe("/edit/reports/[report] — generateMetadata", () => {
  it("resolves a slug or a number to the report's title; anything else gets the console's generic noindex title", async () => {
    h.mockReportMetaFindMany.mockResolvedValue([
      { reportKey: "3", slug: "papers", name: "Papers", summary: "s", descriptionHtml: null },
    ]);
    const meta = (segment: string) =>
      generateMetadata({ params: Promise.resolve({ report: segment }) });
    expect(await meta("papers")).toEqual({
      title: "Papers — Scholars Console",
      robots: { index: false, follow: false },
    });
    expect(await meta("3")).toEqual({
      title: "Papers — Scholars Console",
      robots: { index: false, follow: false },
    });
    expect(await meta("mentored-publications")).toEqual({
      title: "Mentored publications — Scholars Console",
      robots: { index: false, follow: false },
    });
    expect(await meta("publications")).toEqual({
      title: "Reports — Scholars Console",
      robots: { index: false, follow: false },
    });
  });
});
