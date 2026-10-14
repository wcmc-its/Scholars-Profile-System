/**
 * `loadReportAccessPopoverProps`: report 7's grant select (and its rows'
 * labels) carry the unit scope options after the program ones; the other
 * row-granted reports carry their own options and never read the unit list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockFacets: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/report-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/report-access")>();
  return { ...actual, listReportAccess: h.mockList };
});
vi.mock("@/lib/edit/directory-names", () => ({
  fillDirectoryNames: async <T,>(rows: T[]) => rows,
}));
vi.mock("@/lib/api/data-quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/data-quality")>();
  return { ...actual, loadDataQualityFacets: h.mockFacets };
});

import { loadReportAccessPopoverProps } from "@/lib/edit/report-access-popover-props";
import { MENTORED_PUBS_SCOPE_OPTIONS, WHOLE_REPORT_SCOPE_OPTIONS } from "@/lib/edit/report-access";

const SU = { isSuperuser: true, isCommsSteward: false, isContentEditor: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.mockList.mockResolvedValue([]);
  h.mockFacets.mockResolvedValue({
    roleCategories: [],
    departments: [
      { value: "dept:N100", label: "Medicine", count: 900, divisions: [{ value: "div:D1", label: "Medicine — Cardiology", count: 80 }] },
    ],
    centers: [
      { value: "center:MCC", label: "Meyer Cancer Center", count: 300 },
      { value: "center:EMPTY", label: "Empty Center", count: 0 },
    ],
    institutions: [],
  });
});

describe("loadReportAccessPopoverProps — scope options", () => {
  it("report 7: the program options, then every center (memberless too), department and division, labelled by kind", async () => {
    const props = await loadReportAccessPopoverProps("mentored-publications", SU);
    expect(props.scopeOptions).toEqual([
      ...MENTORED_PUBS_SCOPE_OPTIONS,
      ["center:MCC", "Center: Meyer Cancer Center"],
      ["center:EMPTY", "Center: Empty Center"],
      ["dept:N100", "Department: Medicine"],
      ["div:D1", "Division: Medicine — Cardiology"],
    ]);
  });

  it("reports 8 and 9: the whole-report option alone, no unit list read", async () => {
    for (const key of ["article-count", "high-impact-publications"]) {
      expect((await loadReportAccessPopoverProps(key, SU)).scopeOptions).toEqual(WHOLE_REPORT_SCOPE_OPTIONS);
    }
    expect(h.mockFacets).not.toHaveBeenCalled();
  });
});
