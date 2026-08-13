import { describe, expect, it, vi } from "vitest";

import {
  aggregateByDepartment,
  aggregateByFaculty,
  aggregateByRepository,
  buildDataSharingCsv,
  buildDataSharingReport,
  buildShareRates,
  capDatasetLinkRows,
  DATA_SHARING_EXPORT_CAP,
  depositedPmidSet,
  loadDatasetLinkRows,
  loadShareRateCorpus,
  SHARE_RATE_YEAR_FLOOR,
  type DataSharingReportClient,
  type DatasetLinkRow,
  type ShareRateCorpusRow,
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
    // `shareRateDenominator`/`shareRateNumerator` are always present on
    // `overall` (required, not optional) — zeroed here since ROWS is passed
    // with no `corpusRows` argument (the default-`[]` backward-compat path).
    expect(report.overall).toEqual({
      datasets: 2,
      faculty: 2,
      links: 3,
      shareRateDenominator: 0,
      shareRateNumerator: 0,
    });
  });

  it("empty input produces an empty, not-undefined, report", () => {
    const report = buildDataSharingReport([]);
    expect(report.overall).toEqual({
      datasets: 0,
      faculty: 0,
      links: 0,
      shareRateDenominator: 0,
      shareRateNumerator: 0,
    });
    expect(report.byDepartment).toEqual([]);
    expect(report.byRepository).toEqual([]);
    expect(report.byFaculty).toEqual([]);
  });
});

describe("depositedPmidSet", () => {
  const row = (overrides: Partial<DatasetLinkRow>): DatasetLinkRow => ({
    cwid: "s1",
    scholarName: "S",
    scholarSlug: "s",
    department: null,
    datasetId: "d1",
    repository: "GEO",
    accessModel: null,
    ...overrides,
  });

  it("flattens pmids across rows into one set", () => {
    const set = depositedPmidSet([row({ pmids: ["p1", "p2"] }), row({ pmids: ["p3"] })]);
    expect(set).toEqual(new Set(["p1", "p2", "p3"]));
  });

  it("dedups the same pmid appearing on multiple rows", () => {
    const set = depositedPmidSet([row({ pmids: ["p1", "p2"] }), row({ pmids: ["p2", "p3"] })]);
    expect(set).toEqual(new Set(["p1", "p2", "p3"]));
  });

  it("skips rows with no pmids field or an empty pmids array", () => {
    const set = depositedPmidSet([row({ pmids: undefined }), row({ pmids: [] }), row({ pmids: ["p1"] })]);
    expect(set).toEqual(new Set(["p1"]));
  });

  it("counts a pmid regardless of which cwid's link row carries it — no position/cwid filtering (regression)", () => {
    // Publication "p1" is first-authored by Faculty A (a fact that lives in
    // the corpus, not modeled here), but its dataset deposit's
    // PersonDatasetDeposit row is attributed to Faculty B, a middle author on
    // the same pub. `depositedPmidSet` must still surface "p1" as deposited —
    // filtering by this row's cwid/position would wrongly mark Faculty A's
    // paper as having no deposit.
    const set = depositedPmidSet([row({ cwid: "faculty-b", datasetId: "d9", pmids: ["p1"] })]);
    expect(set.has("p1")).toBe(true);
  });
});

describe("buildShareRates", () => {
  const CORPUS: ShareRateCorpusRow[] = [
    { pmid: "p1", cwid: "aaa1", department: "Medicine" },
    { pmid: "p2", cwid: "aaa1", department: "Medicine" },
    { pmid: "p3", cwid: "bbb2", department: "Surgery" },
    // p4: WCM first/last authors in two different departments — the exact
    // multi-department shape `aggregateByDepartment`'s comment warns about.
    // Must count in both department (and faculty) buckets without inflating
    // `overall`'s distinct total.
    { pmid: "p4", cwid: "aaa1", department: "Medicine" },
    { pmid: "p4", cwid: "bbb2", department: "Surgery" },
    { pmid: "p5", cwid: "ccc3", department: "Pediatrics" },
  ];
  // p1 and p3 have a detected deposit; p2, p4, p5 don't.
  const DEPOSITED = new Set(["p1", "p3"]);

  it("computes overall denominator/numerator on distinct pmids, not row count", () => {
    const rates = buildShareRates(CORPUS, DEPOSITED);
    expect(rates.overall).toEqual({ denominatorPubs: 5, numeratorPubs: 2 });
  });

  it("computes per-department totals, including the multi-department double-count", () => {
    const rates = buildShareRates(CORPUS, DEPOSITED);
    expect(rates.byDepartment.get("Medicine")).toEqual({ denominatorPubs: 3, numeratorPubs: 1 });
    expect(rates.byDepartment.get("Surgery")).toEqual({ denominatorPubs: 2, numeratorPubs: 1 });
  });

  it("computes per-faculty totals", () => {
    const rates = buildShareRates(CORPUS, DEPOSITED);
    expect(rates.byFaculty.get("aaa1")).toEqual({ denominatorPubs: 3, numeratorPubs: 1 });
    expect(rates.byFaculty.get("bbb2")).toEqual({ denominatorPubs: 2, numeratorPubs: 1 });
  });

  it("gives numerator 0 for a bucket whose pmids have no matching deposit", () => {
    const rates = buildShareRates(CORPUS, DEPOSITED);
    expect(rates.byDepartment.get("Pediatrics")).toEqual({ denominatorPubs: 1, numeratorPubs: 0 });
  });

  it("a multi-department pub inflates the summed department denominators past the overall total (the same denominator trap as datasets)", () => {
    const rates = buildShareRates(CORPUS, DEPOSITED);
    const summedDeptDenominators = [...rates.byDepartment.values()].reduce((sum, t) => sum + t.denominatorPubs, 0);
    // Medicine(3) + Surgery(2) + Pediatrics(1) = 6, overshoots the true
    // distinct total of 5 — p4 is legitimately double-counted across
    // departments.
    expect(summedDeptDenominators).toBe(6);
    expect(rates.overall.denominatorPubs).toBe(5);
  });

  it("groups a missing department under the same fallback label aggregateByDepartment uses", () => {
    const rates = buildShareRates([{ pmid: "p9", cwid: "z1", department: null }], new Set<string>());
    expect(rates.byDepartment.get("Unknown / no department on file")).toEqual({
      denominatorPubs: 1,
      numeratorPubs: 0,
    });
  });

  it("empty corpus produces a zeroed overall and empty maps", () => {
    const rates = buildShareRates([], new Set());
    expect(rates.overall).toEqual({ denominatorPubs: 0, numeratorPubs: 0 });
    expect(rates.byDepartment.size).toBe(0);
    expect(rates.byFaculty.size).toBe(0);
  });
});

describe("buildDataSharingReport — share rate (second argument)", () => {
  const LINK_ROWS: DatasetLinkRow[] = [
    {
      cwid: "aaa1",
      scholarName: "Alice A",
      scholarSlug: "alice-a",
      department: "Medicine",
      datasetId: "d1",
      repository: "GEO",
      accessModel: "open",
      pmids: ["p1"],
    },
    {
      // Same dataset as above, link row for a co-author in a different
      // department — its own `pmids` is empty; "p1" is still deposited
      // because the OTHER row for the same dataset carries it (mirrors
      // `depositedPmidSet`'s no-cwid-filtering regression above).
      cwid: "bbb2",
      scholarName: "Bob B",
      scholarSlug: "bob-b",
      department: "Surgery",
      datasetId: "d1",
      repository: "GEO",
      accessModel: "open",
      pmids: [],
    },
  ];

  const CORPUS_ROWS: ShareRateCorpusRow[] = [
    { pmid: "p1", cwid: "aaa1", department: "Medicine" },
    { pmid: "p2", cwid: "aaa1", department: "Medicine" },
    { pmid: "p3", cwid: "bbb2", department: "Surgery" },
  ];

  it("merges rate fields onto overall / byDepartment / byFaculty", () => {
    const report = buildDataSharingReport(LINK_ROWS, CORPUS_ROWS);

    // p1 is deposited (LINK_ROWS carries it); p2 and p3 are not.
    expect(report.overall.shareRateDenominator).toBe(3);
    expect(report.overall.shareRateNumerator).toBe(1);

    const medicine = report.byDepartment.find((d) => d.department === "Medicine")!;
    expect(medicine.shareRateDenominator).toBe(2); // p1, p2
    expect(medicine.shareRateNumerator).toBe(1); // p1

    const surgery = report.byDepartment.find((d) => d.department === "Surgery")!;
    expect(surgery.shareRateDenominator).toBe(1); // p3
    expect(surgery.shareRateNumerator).toBe(0);

    const alice = report.byFaculty.find((f) => f.cwid === "aaa1")!;
    expect(alice.shareRateDenominator).toBe(2);
    expect(alice.shareRateNumerator).toBe(1);

    const bob = report.byFaculty.find((f) => f.cwid === "bbb2")!;
    expect(bob.shareRateDenominator).toBe(1);
    expect(bob.shareRateNumerator).toBe(0);
  });

  it("defaults a deposit-side row's rate fields to {0,0} when it has no matching corpus entry", () => {
    const report = buildDataSharingReport(
      [
        {
          cwid: "zzz9",
          scholarName: "Zed Z",
          scholarSlug: "zed-z",
          department: "Radiology",
          datasetId: "d9",
          repository: "GEO",
          accessModel: "open",
          pmids: ["p1"],
        },
      ],
      [], // no corpus rows at all
    );
    const radiology = report.byDepartment.find((d) => d.department === "Radiology")!;
    expect(radiology.shareRateDenominator).toBe(0);
    expect(radiology.shareRateNumerator).toBe(0);
    const zed = report.byFaculty.find((f) => f.cwid === "zzz9")!;
    expect(zed.shareRateDenominator).toBe(0);
    expect(zed.shareRateNumerator).toBe(0);
  });

  it("includes a department with real denominator data but zero deposits, not silently omitted (adversarial-review finding)", () => {
    const report = buildDataSharingReport(LINK_ROWS, [
      ...CORPUS_ROWS,
      // Neurology has confirmed first/last pubs since the floor but never
      // appears in LINK_ROWS (deposit-side) at all — before the fix, this
      // department vanished from `byDepartment` entirely instead of showing
      // "0/2 (0%)", hiding it from the exact CTSA use case (spotting
      // zero-sharing units) the metric exists for.
      { pmid: "p4", cwid: "ccc3", department: "Neurology" },
      { pmid: "p5", cwid: "ccc3", department: "Neurology" },
    ]);
    const neurology = report.byDepartment.find((d) => d.department === "Neurology");
    expect(neurology).toBeDefined();
    expect(neurology).toMatchObject({
      datasets: 0,
      faculty: 0,
      links: 0,
      shareRateDenominator: 2,
      shareRateNumerator: 0,
    });
    // overall total is unaffected by the union (still counts every distinct
    // corpus pmid exactly once, regardless of which departments contribute).
    expect(report.overall.shareRateDenominator).toBe(5); // p1..p5
  });

  it("backward compatible: calling with only rows produces the same non-rate fields as before, rate fields defaulted to zero", () => {
    const report = buildDataSharingReport(ROWS);
    // Non-rate fields identical to pre-share-rate behavior.
    expect(report.overall).toMatchObject({ datasets: 2, faculty: 2, links: 3 });
    expect(report.byRepository.find((r) => r.repository === "GEO")).toEqual({
      repository: "GEO",
      accessModel: "open",
      datasets: 1,
    });
    expect(report.byRepository.find((r) => r.repository === "dbGaP")).toEqual({
      repository: "dbGaP",
      accessModel: "controlled",
      datasets: 1,
    });
    // Rate fields present (required on `overall`, optional-but-populated on
    // the rollup rows) but zeroed — no corpus was supplied.
    expect(report.overall.shareRateDenominator).toBe(0);
    expect(report.overall.shareRateNumerator).toBe(0);
    expect(report.byDepartment.every((d) => d.shareRateDenominator === 0 && d.shareRateNumerator === 0)).toBe(true);
    expect(report.byFaculty.every((f) => f.shareRateDenominator === 0 && f.shareRateNumerator === 0)).toBe(true);
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

describe("loadShareRateCorpus", () => {
  /** The query shape itself had zero test coverage anywhere in the repo
   *  (adversarial-review finding) — every other test in this file passes
   *  `corpusRows` in as a plain array literal, so a broken `where` clause
   *  here (OR flipped to AND, `isConfirmed` dropped, the year floor dropped)
   *  would pass all of them unnoticed. This asserts the actual Prisma call
   *  args, not just a canned resolved value. */
  it("queries publicationAuthor with first-OR-last, confirmed, non-null cwid, and the year floor", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { publicationAuthor: { findMany } } as unknown as DataSharingReportClient;

    await loadShareRateCorpus(client);

    expect(findMany).toHaveBeenCalledTimes(1);
    const call = findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([{ isFirst: true }, { isLast: true }]);
    expect(call.where.isConfirmed).toBe(true);
    expect(call.where.cwid).toEqual({ not: null });
    expect(call.where.publication.year.gte).toBe(SHARE_RATE_YEAR_FLOOR);
  });

  it("maps rows to pmid/cwid/department, defaulting a missing department to null", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { pmid: "p1", cwid: "aaa1", scholar: { primaryDepartment: "Medicine" } },
      { pmid: "p2", cwid: "bbb2", scholar: { primaryDepartment: null } },
      { pmid: "p3", cwid: "ccc3", scholar: null },
    ]);
    const client = { publicationAuthor: { findMany } } as unknown as DataSharingReportClient;

    const rows = await loadShareRateCorpus(client);

    expect(rows).toEqual([
      { pmid: "p1", cwid: "aaa1", department: "Medicine" },
      { pmid: "p2", cwid: "bbb2", department: null },
      { pmid: "p3", cwid: "ccc3", department: null },
    ]);
  });
});
