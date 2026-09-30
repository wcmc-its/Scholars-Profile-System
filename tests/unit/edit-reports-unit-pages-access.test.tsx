/**
 * `app/edit/reports/[report]/page.tsx`, one page × six unit-gated slugs —
 * every unit-gated report hands `ReportHeader` the access badge's props as
 * `access`, in the `"unit"` mode (the static Owner/Curator rule, no fetch).
 *
 * The wiring is one prop on one JSX line and nothing else on the page depends
 * on it, so without this file a page that DROPS the prop passes every gate:
 * `tsc` has no unused-locals check, the orphaned import is only a lint
 * warning, and `edit-reports-core-pages.test.tsx` mocks `ReportHeader` to an
 * h1 that never reads `access`. Each report is mutation-tested here on its
 * own (the registry's `gate` is per entry, so one slug passing says nothing
 * about the others): `ReportHeader` is mocked to a pass-through that renders
 * the popover marker from `access`, and the assertion reads BOTH the
 * header's `access` prop (`{ mode: "unit" }`) and the marker the render
 * produced.
 *
 * These are async Server Components, so each test awaits the page and then
 * renders the returned tree. Every loader is mocked to its empty state —
 * the report bodies are covered elsewhere; only the heading row matters here.
 * `report_meta` is an empty table (`reportMeta.findMany` on the db mock), so
 * each slug resolves through the real `loadReportMeta` defaults.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const {
  mockGetEditSession,
  mockRedirect,
  mockResolveNumbered,
  mockLoadReportsContext,
  mockPopover,
  mockReportHeader,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockResolveNumbered: vi.fn(),
  mockLoadReportsContext: vi.fn(),
  mockPopover: vi.fn(({ mode }: { mode: string }) => (
    <span data-testid="report-access-popover" data-mode={mode} />
  )),
  mockReportHeader: vi.fn(
    ({
      n,
      access,
      children,
    }: {
      n: string;
      access?: { mode: string };
      children?: React.ReactNode;
    }) => (
      <>
        <h1 data-testid="report-header">Report {n}</h1>
        {access && <span data-testid="report-access-popover" data-mode={access.mode} />}
        {children}
      </>
    ),
  ),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: vi.fn() }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: vi.fn().mockResolvedValue([]) } }, write: {} },
}));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportsContext: mockLoadReportsContext,
  resolveNumberedReportCenterCode: mockResolveNumbered,
  // The registry derives each report's `allowedKinds` from this.
  REPORT_NUMBERS_BY_KIND: { center: [1, 2, 3, 4, 5, 6], department: [3, 6], division: [3, 6], core: [3, 6] },
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(null),
}));
// Per-page report loaders, each at its empty state.
vi.mock("@/lib/edit/cancer-center-publications-report", () => ({
  HIGH_IMPACT_THRESHOLD: 10,
  loadUnitPublicationsReport: vi.fn().mockResolvedValue({
    totalPublications: 0,
    matchedPublications: 0,
    matchRatePct: 0,
    highImpactCount: 0,
    highImpactRatePct: 0,
    rows: [],
  }),
}));
vi.mock("@/lib/edit/cancer-center-grants-report", () => ({
  loadCenterActiveGrants: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/center-collaboration/clinical-trials-report", () => ({
  loadClinicalTrialsReport: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/center-collaboration/collab-report-rows", () => ({
  loadCollabReportRows: vi.fn().mockResolvedValue({ rows: [], lastRefreshedAt: null }),
}));
vi.mock("@/lib/edit/nih-funded-publications-report", () => ({
  loadNihFundedPublicationsReport: vi.fn().mockResolvedValue({ totalPublications: 0, rows: [] }),
}));
// Chrome and report bodies, reduced to what the heading row needs.
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-under-test">{children}</div>
  ),
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: () => null }));
vi.mock("@/components/edit/cancer-center-collab-report-card", () => ({
  CancerCenterCollabReportCard: () => null,
}));
vi.mock("@/lib/edit/nci-2a-report.server", () => ({
  loadNci2aReport: vi.fn().mockResolvedValue({ cycle: null, programs: [], awards: [] }),
}));
vi.mock("@/components/edit/publications-report-table", () => ({
  PublicationsReportTable: () => null,
}));
vi.mock("@/components/funding/expanded-grant", () => ({ LowerConfidenceBadge: () => null }));
vi.mock("@/components/edit/report-access-popover", () => ({ ReportAccessPopover: mockPopover }));
vi.mock("@/components/edit/report-header", () => ({ ReportHeader: mockReportHeader }));

import EditReportPage from "@/app/edit/reports/[report]/page";

const OWNER = { cwid: "owner01", isSuperuser: false, isCommsSteward: false };

/** The six unit-gated reports by their default slug (`REPORT_META_DEFAULTS`). */
const REPORTS: Array<[n: string, slug: string]> = [
  ["1", "optimize-membership"],
  ["2", "nci-table-2a"],
  ["3", "publications"],
  ["4", "grants"],
  ["5", "clinical-trials"],
  ["6", "nih-funded-pubs"],
];

const page = (slug: string) =>
  EditReportPage({ params: Promise.resolve({ report: slug }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGetEditSession.mockResolvedValue(OWNER);
  mockResolveNumbered.mockResolvedValue({ code: "meyer", kind: "center" });
  mockLoadReportsContext.mockResolvedValue({ unit: { name: "Meyer Cancer Center" } });
});

describe.each(REPORTS)("/edit/reports/%s — heading row", (n, slug) => {
  it(`hands ReportHeader n="${n}" the unit-mode access badge props as \`access\``, async () => {
    const result = await page(slug);
    render(result as React.ReactElement);

    // The prop itself: the badge props in "unit" mode — the assertion a
    // dropped `access=` or a wrong `mode` fails.
    expect(mockReportHeader).toHaveBeenCalledTimes(1);
    const props = mockReportHeader.mock.calls[0]![0];
    expect(props.n).toBe(n);
    expect(props.access).toEqual({ mode: "unit" });

    // And it actually rendered inside the page, once, with that mode.
    const root = screen.getByTestId("page-under-test");
    const marker = screen.getByTestId("report-access-popover");
    expect(root.contains(marker)).toBe(true);
    expect(marker.getAttribute("data-mode")).toBe("unit");
  });
});
