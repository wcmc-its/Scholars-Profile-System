import { describe, expect, it, vi } from "vitest";

import {
  aggregateByDepartment,
  aggregateByFaculty,
  aggregateByRepository,
  buildDataSharingCsv,
  buildDataSharingReport,
  capDatasetLinkRows,
  DATA_SHARING_EXPORT_CAP,
  loadDatasetLinkRows,
  type DataSharingReportClient,
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

describe("buildDataSharingCsv", () => {
  it("emits the header row and one row per link, in column order", () => {
    const csv = buildDataSharingCsv([
      {
        cwid: "aaa1",
        scholarName: "Alice, A",
        scholarSlug: "alice-a",
        department: "Medicine",
        datasetId: "d1",
        repository: "GEO",
        accessModel: "open",
        title: "A dataset, with a comma in the title",
        accessionOrDoi: "GSE12345",
        resourceType: "Dataset",
        dataType: "genomic",
        depositYear: 2025,
        provenance: "databank",
        confidence: "high",
      },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "repository,accession_or_doi,title,resource_type,data_type,access_model,deposit_year,provenance,confidence,department,faculty_name,cwid",
    );
    expect(lines[1]).toBe(
      'GEO,GSE12345,"A dataset, with a comma in the title",Dataset,genomic,open,2025,databank,high,Medicine,"Alice, A",aaa1',
    );
  });

  it("renders a missing department (and other null/absent optional fields) as empty cells", () => {
    const csv = buildDataSharingCsv([
      {
        cwid: "bbb2",
        scholarName: "Bob B",
        scholarSlug: "bob-b",
        department: null,
        datasetId: "d2",
        repository: "dbGaP",
        accessModel: null,
        title: null,
        accessionOrDoi: undefined,
        resourceType: null,
        dataType: null,
        depositYear: null,
        provenance: undefined,
        confidence: null,
      },
    ]);
    const line = csv.trimEnd().split("\r\n")[1];
    expect(line).toBe("dbGaP,,,,,,,,,,Bob B,bbb2");
  });
});

describe("capDatasetLinkRows", () => {
  const row = (i: number): DatasetLinkRow => ({
    cwid: `s${i}`,
    scholarName: `S${i}`,
    scholarSlug: `s${i}`,
    department: null,
    datasetId: `d${i}`,
    repository: "GEO",
    accessModel: null,
  });

  it("passes rows through untruncated when under the cap", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i));
    const out = capDatasetLinkRows(rows);
    expect(out.rows).toHaveLength(10);
    expect(out.total).toBe(10);
    expect(out.truncated).toBe(false);
  });

  it("slices to DATA_SHARING_EXPORT_CAP and reports truncated when over the cap", () => {
    const rows = Array.from({ length: DATA_SHARING_EXPORT_CAP + 1 }, (_, i) => row(i));
    const out = capDatasetLinkRows(rows);
    expect(out.rows).toHaveLength(DATA_SHARING_EXPORT_CAP);
    expect(out.total).toBe(DATA_SHARING_EXPORT_CAP + 1);
    expect(out.truncated).toBe(true);
    expect(out.rows[0].cwid).toBe("s0");
    expect(out.rows[DATA_SHARING_EXPORT_CAP - 1].cwid).toBe(`s${DATA_SHARING_EXPORT_CAP - 1}`);
  });
});

describe("loadDatasetLinkRows", () => {
  /** Three links across two datasets, one whole-dataset suppression and one
   *  per-contributor suppression — the two branches `loadDatasetLinkRows`
   *  actually filters on (`darkIds` / `hiddenContributorsById`), previously
   *  untested anywhere in the repo. This is the same query this PR's bulk CSV
   *  export reuses directly, so a suppression regression here would leak into
   *  the export, not just the on-screen rollup. */
  function makeClient(suppressionRows: { entityId: string; contributorCwid: string | null }[]): DataSharingReportClient {
    const links = [
      {
        cwid: "aaa1",
        datasetId: "d1",
        scholar: { preferredName: "Alice A", fullName: "Alice A", slug: "alice-a", primaryDepartment: "Medicine" },
        dataset: {
          repository: "GEO",
          accessModel: "open",
          title: "d1 title",
          accessionOrDoi: "GSE1",
          resourceType: null,
          dataType: null,
          depositYear: 2024,
          provenance: "fulltext-scan",
          confidence: "high",
        },
      },
      {
        cwid: "bbb2",
        datasetId: "d1",
        scholar: { preferredName: "Bob B", fullName: "Bob B", slug: "bob-b", primaryDepartment: "Surgery" },
        dataset: {
          repository: "GEO",
          accessModel: "open",
          title: "d1 title",
          accessionOrDoi: "GSE1",
          resourceType: null,
          dataType: null,
          depositYear: 2024,
          provenance: "fulltext-scan",
          confidence: "high",
        },
      },
      {
        cwid: "aaa1",
        datasetId: "d2",
        scholar: { preferredName: "Alice A", fullName: "Alice A", slug: "alice-a", primaryDepartment: "Medicine" },
        dataset: {
          repository: "dbGaP",
          accessModel: "controlled",
          title: "d2 title",
          accessionOrDoi: "phs2",
          resourceType: null,
          dataType: null,
          depositYear: 2022,
          provenance: "databank",
          confidence: null,
        },
      },
    ];
    return {
      personDatasetDeposit: { findMany: vi.fn().mockResolvedValue(links) },
      suppression: { findMany: vi.fn().mockResolvedValue(suppressionRows) },
    } as unknown as DataSharingReportClient;
  }

  it("drops every link to a whole-dataset ('not mine, remove all') suppression", async () => {
    const client = makeClient([{ entityId: "d2", contributorCwid: null }]);
    const rows = await loadDatasetLinkRows(client);
    expect(rows.map((r) => r.datasetId)).toEqual(["d1", "d1"]);
  });

  it("drops only the suppressed contributor's link, keeping co-authors' links to the same dataset", async () => {
    const client = makeClient([{ entityId: "d1", contributorCwid: "bbb2" }]);
    const rows = await loadDatasetLinkRows(client);
    expect(rows.map((r) => `${r.datasetId}:${r.cwid}`)).toEqual(["d1:aaa1", "d2:aaa1"]);
  });

  it("returns every link unfiltered when there are no active suppressions", async () => {
    const client = makeClient([]);
    const rows = await loadDatasetLinkRows(client);
    expect(rows).toHaveLength(3);
  });
});
