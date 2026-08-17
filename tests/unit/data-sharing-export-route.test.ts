/**
 * GET /edit/data-sharing/export — CSV download route gating + headers.
 * Mirrors `tests/unit/data-quality-export-route.test.ts`'s structure, plus
 * the query-param/filter machinery this dashboard now has (2026-08-16,
 * GitHub #2470): `parseDataSharingParams`, `applyReportFilters`,
 * `applyNihFilter`, and `loadFundingSplit` are all mocked below so each
 * describe block can assert exactly what the route wires where, without
 * re-testing those functions' own logic (covered in
 * `tests/unit/data-sharing-report.test.ts` and
 * `tests/unit/data-sharing-dashboard-params.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSession,
  mockEnabled,
  mockCanView,
  mockLoadRows,
  mockCap,
  mockCsv,
  mockLoadReport,
  mockSectionCsv,
  mockSectionItemsCsv,
  mockBuildMethodsDoc,
  mockMethodsMarkdown,
  mockParseDataSharingParams,
  mockApplyReportFilters,
  mockApplyNihFilter,
  mockLoadFundingSplit,
} = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockCanView: vi.fn(),
  mockLoadRows: vi.fn(),
  mockCap: vi.fn(),
  mockCsv: vi.fn(),
  mockLoadReport: vi.fn(),
  mockSectionCsv: vi.fn(),
  mockSectionItemsCsv: vi.fn(),
  mockBuildMethodsDoc: vi.fn(),
  mockMethodsMarkdown: vi.fn(),
  mockParseDataSharingParams: vi.fn(),
  mockApplyReportFilters: vi.fn(),
  mockApplyNihFilter: vi.fn(),
  mockLoadFundingSplit: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/data-sharing-dashboard", () => ({
  isDataSharingDashboardEnabled: mockEnabled,
  canViewDataSharingDashboard: mockCanView,
  parseDataSharingParams: mockParseDataSharingParams,
}));
vi.mock("@/lib/api/data-sharing-report", () => ({
  loadDatasetLinkRows: mockLoadRows,
  capDatasetLinkRows: mockCap,
  buildDataSharingCsv: mockCsv,
  loadDataSharingReport: mockLoadReport,
  buildSectionCsv: mockSectionCsv,
  buildSectionItemsCsv: mockSectionItemsCsv,
  applyReportFilters: mockApplyReportFilters,
  applyNihFilter: mockApplyNihFilter,
  loadFundingSplit: mockLoadFundingSplit,
  CSV_SECTIONS: ["tiers", "repositories", "departments", "faculty", "subtypes"],
  SHARE_RATE_YEAR_FLOOR: 2020,
}));
vi.mock("@/lib/edit/data-sharing-methods-doc", () => ({
  buildMethodsDoc: mockBuildMethodsDoc,
  methodsMarkdown: mockMethodsMarkdown,
}));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/edit/data-sharing/export/route";

/** Export-route Request — bare = item-level default; pass "?section=…" for a
 *  per-table CSV. (GET's Request param is required: Next's route typegen
 *  rejects an optional one.) */
const exportRequest = (query = "") =>
  new Request(`http://sps.test/edit/data-sharing/export${query}`);

/** The "no filter active" shape `parseDataSharingParams` returns on an empty
 *  query: every describe block below that doesn't care about filtering
 *  defaults to this, via `beforeEach`. */
const NO_FILTERS = { yearFrom: undefined, yearTo: undefined, tiers: undefined, nihFunded: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockCanView.mockReturnValue(true);
  mockLoadRows.mockResolvedValue([{ cwid: "fac1" }]);
  mockCap.mockReturnValue({ rows: [{ cwid: "fac1" }], total: 1, truncated: false });
  mockCsv.mockReturnValue("repository,cwid\r\nGEO,fac1\r\n");
  // Defaults matching "no filter active": parseDataSharingParams reports no
  // filter, applyReportFilters/applyNihFilter pass their rows through
  // untouched (the real functions' own behavior with no filter set), and
  // loadFundingSplit is never expected to be called unless a test's filters
  // set nihFunded.
  mockParseDataSharingParams.mockReturnValue({ filters: NO_FILTERS });
  mockApplyReportFilters.mockImplementation((rows: unknown) => rows);
  mockApplyNihFilter.mockImplementation((rows: unknown) => rows);
  mockLoadFundingSplit.mockResolvedValue({ nihFundedPubs: 0, notNihFundedPubs: 0 });
});

describe("/edit/data-sharing/export gating", () => {
  it("404s when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(exportRequest());
    expect(res.status).toBe(404);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(exportRequest());
    expect(res.status).toBe(401);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("404s for a viewer who fails the view gate (not superuser/comms_steward)", async () => {
    mockCanView.mockReturnValue(false);
    const res = await GET(exportRequest());
    expect(res.status).toBe(404);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("returns a CSV attachment for an in-scope viewer", async () => {
    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="data-sharing-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("repository,cwid\r\nGEO,fac1\r\n");
    expect(mockCap).toHaveBeenCalledWith([{ cwid: "fac1" }]);
    expect(mockCsv).toHaveBeenCalledWith([{ cwid: "fac1" }]);
  });

  it("logs one export_data_sharing audit line with row/total/truncated counts", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockCap.mockReturnValue({ rows: [{ cwid: "fac1" }], total: 5001, truncated: true });
    await GET(exportRequest());
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "export_data_sharing",
      cwid: "edt1",
      rows: 1,
      total: 5001,
      truncated: true,
    });
    expect(typeof logged.ts).toBe("string");
  });

  it("?section=faculty serves the section CSV via loadDataSharingReport, not the item path", async () => {
    mockLoadReport.mockResolvedValue({ byFaculty: [] });
    mockSectionCsv.mockReturnValue("faculty_name,cwid\r\n");
    const res = await GET(exportRequest("?section=faculty"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="data-sharing-faculty-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(mockSectionCsv).toHaveBeenCalledWith({ byFaculty: [] }, "faculty");
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("400s an unknown section without touching the DB", async () => {
    const res = await GET(exportRequest("?section=nope"));
    expect(res.status).toBe(400);
    expect(mockLoadReport).not.toHaveBeenCalled();
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("section export still respects the gates (flag off → 404)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(exportRequest("?section=faculty"));
    expect(res.status).toBe(404);
    expect(mockLoadReport).not.toHaveBeenCalled();
  });
});

describe("/edit/data-sharing/export?section=methods (v3)", () => {
  it("serves the Methods document as a markdown attachment, built from the loaded report", async () => {
    const report = { overall: {}, byRepository: [], byDepartment: [], dataAsOf: new Date("2026-08-01T00:00:00Z") };
    const doc = { sections: [], paragraph: "para" };
    mockLoadReport.mockResolvedValue(report);
    mockBuildMethodsDoc.mockReturnValue(doc);
    mockMethodsMarkdown.mockReturnValue("# Data sharing — methods\n");

    const res = await GET(exportRequest("?section=methods"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="data-sharing-methods-\d{4}-\d{2}-\d{2}\.md"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("# Data sharing — methods\n");
    // Built from the loaded report with the year floor threaded through, and
    // rendered with the report's own dataAsOf.
    expect(mockBuildMethodsDoc).toHaveBeenCalledWith(report, { shareRateYearFloor: 2020 });
    expect(mockMethodsMarkdown).toHaveBeenCalledWith(doc, report.dataAsOf);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("logs one export_data_sharing line with section: methods", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadReport.mockResolvedValue({ dataAsOf: null });
    mockBuildMethodsDoc.mockReturnValue({ sections: [], paragraph: "" });
    mockMethodsMarkdown.mockReturnValue("md");
    await GET(exportRequest("?section=methods"));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      event: "export_data_sharing",
      cwid: "edt1",
      section: "methods",
    });
  });

  it("methods export still respects the gates (flag off → 404)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(exportRequest("?section=methods"));
    expect(res.status).toBe(404);
    expect(mockLoadReport).not.toHaveBeenCalled();
  });

  it("does NOT apply the active filter, since it's the methodology document, not a filtered slice of the data (2026-08-16, GitHub #2470)", async () => {
    mockParseDataSharingParams.mockReturnValue({ filters: { ...NO_FILTERS, yearFrom: 2021 } });
    mockLoadReport.mockResolvedValue({ dataAsOf: null });
    mockBuildMethodsDoc.mockReturnValue({ sections: [], paragraph: "" });
    mockMethodsMarkdown.mockReturnValue("md");
    await GET(exportRequest("?section=methods&yearFrom=2021"));
    // Called with only the client, no filters arg: unlike every other
    // loadDataSharingReport call site this route now has.
    expect(mockLoadReport).toHaveBeenCalledWith({});
  });
});

describe("/edit/data-sharing/export?grain=items (v3)", () => {
  it("?section=repositories&grain=items serves the item-level section CSV via loadDatasetLinkRows", async () => {
    mockSectionItemsCsv.mockReturnValue("repository,cwid\r\nGEO,fac1\r\n");
    const res = await GET(exportRequest("?section=repositories&grain=items"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="data-sharing-repositories-items-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(await res.text()).toBe("repository,cwid\r\nGEO,fac1\r\n");
    expect(mockSectionItemsCsv).toHaveBeenCalledWith([{ cwid: "fac1" }], "repositories", {
      department: undefined,
      cwid: undefined,
      repository: undefined,
      category: undefined,
      subtype: undefined,
    });
    // The item grain reads link rows, not the aggregate report.
    expect(mockLoadReport).not.toHaveBeenCalled();
  });

  it("?section=departments&grain=items&department=X passes the per-row drill-down filter through", async () => {
    mockSectionItemsCsv.mockReturnValue("csv");
    await GET(exportRequest("?section=departments&grain=items&department=Neurology"));
    expect(mockSectionItemsCsv).toHaveBeenCalledWith(
      [{ cwid: "fac1" }],
      "departments",
      expect.objectContaining({ department: "Neurology" }),
    );
  });

  it("logs one export_data_sharing line with section + grain: items", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockSectionItemsCsv.mockReturnValue("csv");
    await GET(exportRequest("?section=faculty&grain=items"));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      event: "export_data_sharing",
      section: "faculty",
      grain: "items",
    });
  });

  it("400s a grain value other than 'items' without touching the DB", async () => {
    const res = await GET(exportRequest("?section=repositories&grain=nope"));
    expect(res.status).toBe(400);
    expect(mockLoadRows).not.toHaveBeenCalled();
    expect(mockLoadReport).not.toHaveBeenCalled();
  });

  it("400s grain=items with section=tiers (no items grain for the tier table)", async () => {
    const res = await GET(exportRequest("?section=tiers&grain=items"));
    expect(res.status).toBe(400);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("400s grain=items with no section at all", async () => {
    const res = await GET(exportRequest("?grain=items"));
    expect(res.status).toBe(400);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });

  it("item-grain export still respects the gates (flag off → 404)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(exportRequest("?section=repositories&grain=items"));
    expect(res.status).toBe(404);
    expect(mockLoadRows).not.toHaveBeenCalled();
  });
});

describe("/edit/data-sharing/export: filters apply to all three export paths (2026-08-16, GitHub #2470)", () => {
  it("aggregate ?section=<X> path: the parsed filters are passed through to loadDataSharingReport", async () => {
    const filters = { ...NO_FILTERS, yearFrom: 2021 };
    mockParseDataSharingParams.mockReturnValue({ filters });
    mockLoadReport.mockResolvedValue({ byFaculty: [] });
    mockSectionCsv.mockReturnValue("csv");
    await GET(exportRequest("?section=faculty&yearFrom=2021"));
    expect(mockLoadReport).toHaveBeenCalledWith({}, filters);
  });

  it("?section=<X>&grain=items path: applyReportFilters runs on the unfiltered link rows, and the NIH grant join is skipped when nihFunded isn't set", async () => {
    const filters = { ...NO_FILTERS, yearFrom: 2021 };
    mockParseDataSharingParams.mockReturnValue({ filters });
    mockApplyReportFilters.mockReturnValue([{ cwid: "filtered1" }]);
    mockSectionItemsCsv.mockReturnValue("csv");
    await GET(exportRequest("?section=repositories&grain=items&yearFrom=2021"));
    expect(mockApplyReportFilters).toHaveBeenCalledWith([{ cwid: "fac1" }], filters);
    expect(mockLoadFundingSplit).not.toHaveBeenCalled();
    expect(mockSectionItemsCsv).toHaveBeenCalledWith([{ cwid: "filtered1" }], "repositories", expect.any(Object));
  });

  it("?section=<X>&grain=items path: when nihFunded is set, also runs loadFundingSplit on the UNFILTERED rows and applies applyNihFilter", async () => {
    const filters = { ...NO_FILTERS, nihFunded: true };
    mockParseDataSharingParams.mockReturnValue({ filters });
    mockApplyReportFilters.mockReturnValue([{ cwid: "fac1" }]); // no year/tier narrowing this time
    const nihByPmid = new Map([["p1", true]]);
    mockLoadFundingSplit.mockResolvedValue({ nihFundedPubs: 1, notNihFundedPubs: 0, nihByPmid });
    mockApplyNihFilter.mockReturnValue([{ cwid: "nih-only" }]);
    mockSectionItemsCsv.mockReturnValue("csv");
    await GET(exportRequest("?section=faculty&grain=items&nihFunded=true"));
    // loadFundingSplit reads the UNFILTERED link rows (same population
    // reasoning part 1 uses for loadDataSharingReport), not the
    // year/tier-filtered set.
    expect(mockLoadFundingSplit).toHaveBeenCalledWith({}, [{ cwid: "fac1" }]);
    expect(mockApplyNihFilter).toHaveBeenCalledWith([{ cwid: "fac1" }], true, nihByPmid);
    expect(mockSectionItemsCsv).toHaveBeenCalledWith([{ cwid: "nih-only" }], "faculty", expect.any(Object));
  });

  it("bare item-level export (no section): applies the active filter before capping", async () => {
    const filters = { ...NO_FILTERS, yearFrom: 2020 };
    mockParseDataSharingParams.mockReturnValue({ filters });
    mockApplyReportFilters.mockReturnValue([{ cwid: "filtered1" }]);
    mockCap.mockReturnValue({ rows: [{ cwid: "filtered1" }], total: 1, truncated: false });
    await GET(exportRequest("?yearFrom=2020"));
    expect(mockApplyReportFilters).toHaveBeenCalledWith([{ cwid: "fac1" }], filters);
    expect(mockCap).toHaveBeenCalledWith([{ cwid: "filtered1" }]);
  });

  it("bare item-level export: runs the NIH grant join only when nihFunded is set", async () => {
    const filters = { ...NO_FILTERS, nihFunded: false };
    mockParseDataSharingParams.mockReturnValue({ filters });
    mockApplyReportFilters.mockReturnValue([{ cwid: "fac1" }]);
    mockLoadFundingSplit.mockResolvedValue({ nihFundedPubs: 0, notNihFundedPubs: 1, nihByPmid: new Map() });
    mockApplyNihFilter.mockReturnValue([{ cwid: "not-nih" }]);
    await GET(exportRequest("?nihFunded=false"));
    expect(mockLoadFundingSplit).toHaveBeenCalledWith({}, [{ cwid: "fac1" }]);
    expect(mockApplyNihFilter).toHaveBeenCalledWith([{ cwid: "fac1" }], false, new Map());
    expect(mockCap).toHaveBeenCalledWith([{ cwid: "not-nih" }]);
  });

  it("really parses filters from the request's own query string, not just the mocked wiring (searchParamsToRecord + parseDataSharingParams, unmocked)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/edit/data-sharing-dashboard")>(
      "@/lib/edit/data-sharing-dashboard",
    );
    mockParseDataSharingParams.mockImplementation(actual.parseDataSharingParams);
    mockLoadReport.mockResolvedValue({ byDepartment: [] });
    mockSectionCsv.mockReturnValue("csv");
    // A repeated `tier=` param is the multi-value case Object.fromEntries
    // would silently collapse to one: this is exactly what
    // searchParamsToRecord exists to get right.
    await GET(exportRequest("?section=departments&yearFrom=2021&tier=US_OPEN&tier=CONCERN&nihFunded=true"));
    expect(mockLoadReport).toHaveBeenCalledWith(
      {},
      { yearFrom: 2021, yearTo: undefined, tiers: ["US_OPEN", "CONCERN"], nihFunded: true },
    );
  });
});
