/**
 * `app/edit/reports/[report]/page.tsx` at the `publications` (report 3) and
 * `nih-funded-pubs` (report 6) slugs — the `?center=<coreId>&kind=core` route
 * added by the core-reports widening (2026-09-06).
 *
 * Scoped to what the widening added: `?kind=core` is accepted and threaded
 * through to BOTH the authz gate and the report loader, a denied actor gets the
 * visible 403 rather than the report, and the copy stops claiming "member"
 * anything for a core. The reports' center/department/division paths are
 * unchanged and keep their existing coverage.
 *
 * These are async Server Components, so each test awaits the page and then
 * renders the returned tree — the bodies' local `ReportSummary` / copy
 * branches only run if something actually renders them. `report_meta` is an
 * empty table (`reportMeta.findMany` on the db mock), so each slug resolves
 * through the real `loadReportMeta` defaults.
 *
 * Also the core reports page header (2026-09-29): a core's report opens under
 * `CoreReportsHeader` (h1 "{core} reports", the "Viewing" picker over the
 * viewer's cores A–Z, one tab per core report) in place of "← All reports",
 * and a center/department report renders exactly as before.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const {
  mockGetEditSession,
  mockRedirect,
  mockResolveNumbered,
  mockLoadReportsContext,
  mockLoadPubsReport,
  mockLoadNihReport,
  mockForbidden,
  mockPubsTable,
  mockLoadUnits,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockResolveNumbered: vi.fn(),
  mockLoadReportsContext: vi.fn(),
  mockLoadPubsReport: vi.fn(),
  mockLoadNihReport: vi.fn(),
  mockForbidden: vi.fn(() => null),
  mockPubsTable: vi.fn(() => null),
  mockLoadUnits: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportsContext: mockLoadReportsContext,
  resolveNumberedReportCenterCode: mockResolveNumbered,
  loadReportableUnitsForActor: mockLoadUnits,
  // The registry derives each report's `allowedKinds` from this; the core
  // header's tabs read `core`.
  REPORT_NUMBERS_BY_KIND: {
    center: [1, 2, 3, 4, 5, 6],
    department: [3, 6],
    division: [3, 6],
    core: [3, 6, 11, 12, 13],
  },
}));
vi.mock("@/lib/edit/cancer-center-publications-report", () => ({
  HIGH_IMPACT_THRESHOLD: 10,
  loadUnitPublicationsReport: mockLoadPubsReport,
}));
vi.mock("@/lib/edit/nih-funded-publications-report", () => ({
  loadNihFundedPublicationsReport: mockLoadNihReport,
}));
vi.mock("@/components/edit/console-shell", () => ({
  // A single testid wrapper so a test can read the whole page's text.
  ConsoleShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-under-test">{children}</div>
  ),
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
// `ReportHeader` is an async Server Component (reads `report_meta`); a sync
// stand-in keeps `render()` viable and still surfaces the page's subtitle.
vi.mock("@/components/edit/report-header", () => ({
  ReportHeader: ({
    n,
    children,
    underCoreHeader,
  }: {
    n: string;
    children?: React.ReactNode;
    underCoreHeader?: boolean;
  }) => (
    <>
      <h2 data-testid="report-header" data-under-core={String(Boolean(underCoreHeader))}>
        Report {n}
      </h2>
      {children}
    </>
  ),
}));
vi.mock("@/components/edit/publications-report-table", () => ({
  PublicationsReportTable: mockPubsTable,
}));
vi.mock("@/components/funding/expanded-grant", () => ({ LowerConfidenceBadge: () => null }));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: vi.fn().mockResolvedValue([]) } }, write: {} },
}));

import EditReportPage from "@/app/edit/reports/[report]/page";
import { resolveSuspense } from "@/tests/util/resolve-suspense";

/** The dynamic page at one report's slug — the same call shape the six
 *  numbered pages used to take, plus the segment. */
const pageAt =
  (slug: string) =>
  ({ searchParams }: { searchParams: Promise<Record<string, string>> }) =>
    EditReportPage({ params: Promise.resolve({ report: slug }), searchParams }).then((t) => resolveSuspense(t));
const EditReportsPublicationsPage = pageAt("publications");
const EditReportsNihFundedPublicationsPage = pageAt("nih-funded-pubs");

const OWNER = { cwid: "owner01", isSuperuser: false, isCommsSteward: false };
const OUTSIDER = { cwid: "nobody1", isSuperuser: false, isCommsSteward: false };
const CORE_CTX = { unit: { name: "Biomedical Imaging" } };

const EMPTY_PUBS = {
  totalPublications: 0,
  matchedPublications: 0,
  matchRatePct: 0,
  highImpactCount: 0,
  highImpactRatePct: 0,
  rows: [],
};

/** Render the awaited page tree and return its visible text. */
function renderText(tree: unknown): string {
  render(tree as React.ReactElement);
  return screen.getByTestId("page-under-test").textContent ?? "";
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue(OWNER);
  mockResolveNumbered.mockResolvedValue({ code: "14", kind: "core" });
  mockLoadReportsContext.mockResolvedValue(CORE_CTX);
  mockLoadPubsReport.mockResolvedValue(EMPTY_PUBS);
  mockLoadNihReport.mockResolvedValue({ totalPublications: 0, rows: [] });
  mockLoadUnits.mockResolvedValue([
    { code: "14", kind: "core", name: "Biomedical Imaging", centerType: null },
    { code: "3", kind: "core", name: "Zeta Flow Cytometry", centerType: null },
    { code: "9", kind: "core", name: "Acme Genomics", centerType: null },
  ]);
});

describe("/edit/reports/publications (3) — ?kind=core", () => {
  it("accepts kind=core and threads it into BOTH the authz gate and the report loader", async () => {
    await EditReportsPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    // `core` must be in the allowed set AND parsed off the query string —
    // dropping either would silently resolve the core id as a CENTER.
    expect(mockResolveNumbered).toHaveBeenCalledWith(
      OWNER,
      expect.anything(),
      "14",
      expect.objectContaining({
        allowedKinds: ["center", "department", "division", "core"],
        requestedKind: "core",
      }),
    );
    expect(mockLoadReportsContext).toHaveBeenCalledWith("14", OWNER, expect.anything(), "core");
    expect(mockLoadPubsReport).toHaveBeenCalledWith("core", "14");
  });

  it("an unrecognized ?kind= is still ignored (falls back to the resolver's center default)", async () => {
    await EditReportsPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "cores" }),
    });
    expect(mockResolveNumbered).toHaveBeenCalledWith(
      OWNER,
      expect.anything(),
      "14",
      expect.objectContaining({ requestedKind: undefined }),
    );
  });

  it("a denied actor gets the 403 page and the report is never loaded", async () => {
    mockGetEditSession.mockResolvedValue(OUTSIDER);
    mockLoadReportsContext.mockResolvedValue(null);
    const result = await EditReportsPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    const text = renderText(result);
    // Rendered, so the 403 component actually ran — not just present in a tree.
    expect(mockForbidden).toHaveBeenCalled();
    expect(mockLoadPubsReport).not.toHaveBeenCalled();
    expect(text).not.toContain("Biomedical Imaging");
  });

  it("a core with confirmed usages renders the table; the subtitle says USAGE, not author", async () => {
    mockLoadPubsReport.mockResolvedValue({
      totalPublications: 2,
      matchedPublications: 2,
      matchRatePct: 100,
      highImpactCount: 1,
      highImpactRatePct: 50,
      rows: [{ pmid: "111" }, { pmid: "222" }],
    });
    const result = await EditReportsPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    const text = renderText(result);
    expect(mockPubsTable).toHaveBeenCalled();
    expect(text).toContain("confirmed use of Biomedical Imaging");
    expect(text).not.toContain("author");
  });

  it("the empty state for a core reads as no confirmed USE, never 'no confirmed member author'", async () => {
    // 13 of 14 staging cores carry zero unit_admin rows, and 6 of 14 have zero
    // confirmed usages, so this state is expected — it must explain itself
    // truthfully rather than blame a member roster a core does not have.
    const result = await EditReportsPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    const text = renderText(result);
    expect(text).toContain("No publications with a confirmed use of this core were found.");
    expect(text).not.toContain("member author");
    expect(mockPubsTable).not.toHaveBeenCalled();
  });

  it("a center is unaffected — member copy, member kind", async () => {
    mockResolveNumbered.mockResolvedValue({ code: "meyer", kind: "center" });
    mockLoadReportsContext.mockResolvedValue({ unit: { name: "Meyer Cancer Center" } });
    const result = await EditReportsPublicationsPage({ searchParams: Promise.resolve({}) });
    expect(mockLoadPubsReport).toHaveBeenCalledWith("center", "meyer");
    expect(renderText(result)).toContain("No publications with a confirmed member author were found.");
  });
});

describe("/edit/reports/nih-funded-pubs (6) — ?kind=core", () => {
  it("accepts kind=core and threads it into BOTH the authz gate and the report loader", async () => {
    await EditReportsNihFundedPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    expect(mockResolveNumbered).toHaveBeenCalledWith(
      OWNER,
      expect.anything(),
      "14",
      expect.objectContaining({
        allowedKinds: ["center", "department", "division", "core"],
        requestedKind: "core",
      }),
    );
    expect(mockLoadReportsContext).toHaveBeenCalledWith("14", OWNER, expect.anything(), "core");
    expect(mockLoadNihReport).toHaveBeenCalledWith("core", "14");
  });

  it("a denied actor gets the 403 page and the report is never loaded", async () => {
    mockGetEditSession.mockResolvedValue(OUTSIDER);
    mockLoadReportsContext.mockResolvedValue(null);
    const result = await EditReportsNihFundedPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    renderText(result);
    expect(mockForbidden).toHaveBeenCalled();
    expect(mockLoadNihReport).not.toHaveBeenCalled();
  });

  it("the empty state for a core names confirmed usages, not a member author", async () => {
    const result = await EditReportsNihFundedPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    const text = renderText(result);
    expect(text).toContain("No NIH-funded publications were found among this core's confirmed usages.");
    expect(text).not.toContain("member author");
  });

  it("a center keeps its member copy", async () => {
    mockResolveNumbered.mockResolvedValue({ code: "meyer", kind: "center" });
    mockLoadReportsContext.mockResolvedValue({ unit: { name: "Meyer Cancer Center" } });
    const result = await EditReportsNihFundedPublicationsPage({ searchParams: Promise.resolve({}) });
    expect(mockLoadNihReport).toHaveBeenCalledWith("center", "meyer");
    expect(renderText(result)).toContain(
      "No NIH-funded publications were found for a confirmed member author.",
    );
  });
});

describe("core reports page header", () => {
  it("kind=core → the shared header: '{core} reports', the viewer's cores A–Z, a tab per core report", async () => {
    const result = await EditReportsNihFundedPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core", foo: "bar" }),
    });
    render(result as React.ReactElement);
    const page = within(screen.getByTestId("page-under-test"));
    const header = within(page.getByTestId("core-reports-header"));
    expect(mockLoadUnits).toHaveBeenCalledWith(OWNER, expect.anything(), ["core"]);
    expect(header.getByRole("heading", { level: 1 }).textContent).toBe(
      "Biomedical Imaging reports",
    );
    const select = header.getByTestId("core-reports-core-select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual([
      "Acme Genomics",
      "Biomedical Imaging",
      "Zeta Flow Cytometry",
    ]);
    expect(select.value).toBe("14");
    const tabs = within(header.getByTestId("core-reports-tabs")).getAllByRole("link");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      "/edit/reports/publications?center=14&kind=core",
      "/edit/reports/nih-funded-pubs?center=14&kind=core",
      "/edit/reports/core-users?center=14&kind=core",
      "/edit/reports/core-output-over-time?center=14&kind=core",
      "/edit/reports/core-grants?center=14&kind=core",
    ]);
    expect(header.getByTestId("core-reports-tab-6").getAttribute("aria-current")).toBe("page");
    // The shared header replaces "← All reports" and the report's own h1.
    expect(page.queryByText(/All reports/)).toBeNull();
    expect(page.getByTestId("report-header").getAttribute("data-under-core")).toBe("true");
    // The body is untouched.
    expect(page.getByTestId("nih-pubs-report-empty")).toBeTruthy();
  });

  it("a viewer with one core gets no picker", async () => {
    mockLoadUnits.mockResolvedValue([
      { code: "14", kind: "core", name: "Biomedical Imaging", centerType: null },
    ]);
    const result = await EditReportsPublicationsPage({
      searchParams: Promise.resolve({ center: "14", kind: "core" }),
    });
    render(result as React.ReactElement);
    const page = within(screen.getByTestId("page-under-test"));
    expect(page.getByTestId("core-reports-header")).toBeTruthy();
    expect(page.queryByTestId("core-reports-core-select")).toBeNull();
  });

  it.each([
    ["center", { code: "meyer", kind: "center" }, {}, "/edit/reports?center=meyer"],
    [
      "department",
      { code: "N1280", kind: "department" },
      { center: "N1280", kind: "department" },
      "/edit/reports?center=N1280&kind=department",
    ],
  ])(
    "a %s report is unchanged: '← All reports', its own h1, no core header",
    async (_k, unit, sp, back) => {
      mockResolveNumbered.mockResolvedValue(unit);
      mockLoadReportsContext.mockResolvedValue({ unit: { name: "Test Unit" } });
      const result = await EditReportsPublicationsPage({ searchParams: Promise.resolve(sp) });
      render(result as React.ReactElement);
      const page = within(screen.getByTestId("page-under-test"));
      expect(page.queryByTestId("core-reports-header")).toBeNull();
      expect(mockLoadUnits).not.toHaveBeenCalled();
      expect(page.getByText(/All reports/).getAttribute("href")).toBe(back);
      expect(page.getByTestId("report-header").getAttribute("data-under-core")).toBe("false");
    },
  );
});
