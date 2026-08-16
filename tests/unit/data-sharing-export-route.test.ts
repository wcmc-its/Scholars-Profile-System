/**
 * GET /edit/data-sharing/export — CSV download route gating + headers.
 * Mirrors `tests/unit/data-quality-export-route.test.ts`'s structure, minus
 * the query-param/scope machinery this dashboard doesn't have.
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
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/edit/data-sharing-dashboard", () => ({
  isDataSharingDashboardEnabled: mockEnabled,
  canViewDataSharingDashboard: mockCanView,
}));
vi.mock("@/lib/api/data-sharing-report", () => ({
  loadDatasetLinkRows: mockLoadRows,
  capDatasetLinkRows: mockCap,
  buildDataSharingCsv: mockCsv,
  loadDataSharingReport: mockLoadReport,
  buildSectionCsv: mockSectionCsv,
  buildSectionItemsCsv: mockSectionItemsCsv,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockCanView.mockReturnValue(true);
  mockLoadRows.mockResolvedValue([{ cwid: "fac1" }]);
  mockCap.mockReturnValue({ rows: [{ cwid: "fac1" }], total: 1, truncated: false });
  mockCsv.mockReturnValue("repository,cwid\r\nGEO,fac1\r\n");
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
    expect(mockSectionItemsCsv).toHaveBeenCalledWith([{ cwid: "fac1" }], "repositories");
    // The item grain reads link rows, not the aggregate report.
    expect(mockLoadReport).not.toHaveBeenCalled();
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
