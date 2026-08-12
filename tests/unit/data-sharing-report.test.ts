import { describe, expect, it } from "vitest";

import {
  aggregateByDepartment,
  aggregateByFaculty,
  aggregateByRepository,
  buildDataSharingReport,
  type DatasetLinkRow,
} from "@/lib/api/data-sharing-report";

/** Two datasets, one deposited by co-authors in two different departments —
 *  the exact multi-department shape `aggregateByDepartment`'s own comment
 *  warns about. */
const ROWS: DatasetLinkRow[] = [
  {
    cwid: "aaa1",
    scholarName: "Alice A",
    scholarSlug: "alice-a",
    department: "Medicine",
    datasetId: "d1",
    repository: "GEO",
    accessModel: "open",
  },
  {
    cwid: "bbb2",
    scholarName: "Bob B",
    scholarSlug: "bob-b",
    department: "Surgery",
    // same dataset as above — co-authored across departments.
    datasetId: "d1",
    repository: "GEO",
    accessModel: "open",
  },
  {
    cwid: "aaa1",
    scholarName: "Alice A",
    scholarSlug: "alice-a",
    department: "Medicine",
    datasetId: "d2",
    repository: "dbGaP",
    accessModel: "controlled",
  },
];

describe("aggregateByDepartment", () => {
  it("counts distinct datasets and faculty per department — not link rows", () => {
    const rollup = aggregateByDepartment(ROWS);
    const medicine = rollup.find((r) => r.department === "Medicine")!;
    const surgery = rollup.find((r) => r.department === "Surgery")!;
    expect(medicine).toEqual({ department: "Medicine", datasets: 2, faculty: 1, links: 2 });
    expect(surgery).toEqual({ department: "Surgery", datasets: 1, faculty: 1, links: 1 });
  });

  it("department dataset counts can legitimately exceed the overall total (THE denominator trap)", () => {
    const rollup = aggregateByDepartment(ROWS);
    const summedDatasets = rollup.reduce((sum, r) => sum + r.datasets, 0);
    const overallDatasets = new Set(ROWS.map((r) => r.datasetId)).size;
    // d1 is co-authored across Medicine + Surgery, so it's counted in both —
    // summing the department column (3) overshoots the true total (2). A
    // dashboard that sums this column and calls it "the total" is wrong; this
    // test exists so that mistake fails loudly instead of shipping quietly.
    expect(summedDatasets).toBeGreaterThan(overallDatasets);
    expect(summedDatasets).toBe(3);
    expect(overallDatasets).toBe(2);
  });

  it("groups a missing department under an explicit label, never silently drops the row", () => {
    const rollup = aggregateByDepartment([
      { ...ROWS[0], department: null },
    ]);
    expect(rollup).toHaveLength(1);
    expect(rollup[0].department).toBe("Unknown / no department on file");
    expect(rollup[0].datasets).toBe(1);
  });
});

describe("aggregateByRepository", () => {
  it("counts distinct datasets per repository and carries the access model", () => {
    const byRepo = aggregateByRepository(ROWS);
    const geo = byRepo.find((r) => r.repository === "GEO")!;
    const dbgap = byRepo.find((r) => r.repository === "dbGaP")!;
    // GEO's d1 has two link rows (Alice + Bob) but is ONE dataset.
    expect(geo).toEqual({ repository: "GEO", accessModel: "open", datasets: 1 });
    expect(dbgap).toEqual({ repository: "dbGaP", accessModel: "controlled", datasets: 1 });
  });
});

describe("aggregateByFaculty", () => {
  it("counts distinct datasets and link volume per named individual", () => {
    const byFaculty = aggregateByFaculty(ROWS);
    const alice = byFaculty.find((f) => f.cwid === "aaa1")!;
    const bob = byFaculty.find((f) => f.cwid === "bbb2")!;
    expect(alice).toMatchObject({ datasets: 2, links: 2, department: "Medicine" });
    expect(bob).toMatchObject({ datasets: 1, links: 1, department: "Surgery" });
  });
});

describe("buildDataSharingReport", () => {
  it("overall counts are the true distinct totals, immune to the department double-count", () => {
    const report = buildDataSharingReport(ROWS);
    expect(report.overall).toEqual({ datasets: 2, faculty: 2, links: 3 });
  });

  it("empty input produces an empty, not-undefined, report", () => {
    const report = buildDataSharingReport([]);
    expect(report.overall).toEqual({ datasets: 0, faculty: 0, links: 0 });
    expect(report.byDepartment).toEqual([]);
    expect(report.byRepository).toEqual([]);
    expect(report.byFaculty).toEqual([]);
  });
});
