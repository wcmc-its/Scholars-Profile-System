import { describe, expect, it, vi } from "vitest";

import {
  aggregateByDepartment,
  aggregateByFaculty,
  aggregateByRepository,
  aggregateBySubtype,
  aggregateRepositoriesByTier,
  bucketDatasetLink,
  buildDataSharingCsv,
  buildDataSharingReport,
  buildSectionItemsCsv,
  buildShareRates,
  capDatasetLinkRows,
  countConcerningDeposits,
  DATA_SHARING_EXPORT_CAP,
  depositedPmidSet,
  loadDatasetLinkRows,
  loadFundingSplit,
  loadShareRateCorpus,
  mostRecentDeposits,
  pmcCoverage,
  pubAccessPmidSets,
  RECENT_ITEMS_LIMIT,
  REGISTRY_DATA_TYPE,
  SHARE_RATE_YEAR_FLOOR,
  tierPubSpectrum,
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
    // Medicine: d1 (open) + d2 (controlled). Surgery: d1 (open) only.
    expect(medicine).toEqual({
      department: "Medicine",
      datasets: 2,
      faculty: 1,
      links: 2,
      openDatasets: 1,
      controlledDatasets: 1,
      registryDatasets: 0,
    });
    expect(surgery).toEqual({
      department: "Surgery",
      datasets: 1,
      faculty: 1,
      links: 1,
      openDatasets: 1,
      controlledDatasets: 0,
      registryDatasets: 0,
    });
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
    expect(geo).toEqual({ repository: "GEO", accessModel: "open", datasets: 1, tier: "US_OPEN" });
    expect(dbgap).toEqual({ repository: "dbGaP", accessModel: "controlled", datasets: 1, tier: "US_CTRL" });
  });
});

describe("aggregateByFaculty", () => {
  it("counts distinct datasets and link volume per named individual", () => {
    const byFaculty = aggregateByFaculty(ROWS);
    const alice = byFaculty.find((f) => f.cwid === "aaa1")!;
    const bob = byFaculty.find((f) => f.cwid === "bbb2")!;
    // Alice: d1 (open) + d2 (controlled). Bob: d1 (open) only.
    expect(alice).toMatchObject({
      datasets: 2,
      links: 2,
      department: "Medicine",
      openDatasets: 1,
      controlledDatasets: 1,
    });
    expect(bob).toMatchObject({
      datasets: 1,
      links: 1,
      department: "Surgery",
      openDatasets: 1,
      controlledDatasets: 0,
    });
  });

  it("neither ROWS repository (GEO/dbGaP, both US-tier) counts as concerning or foreign-hosted", () => {
    const byFaculty = aggregateByFaculty(ROWS);
    expect(byFaculty.every((f) => f.concerningDeposits === 0 && f.foreignHostedDeposits === 0)).toBe(true);
  });
});

/** One row per tier for the tier-aggregation tests below: a CONCERN row
 *  (GSA-Human), a FOREIGN_OPEN row (Zenodo), a FOREIGN_CTRL row (EGA), a
 *  US_OPEN row (GEO), a US_CTRL row (dbGaP), and a REGISTRY row
 *  (ClinicalTrials.gov) — plus a second CONCERN row on the same cwid as the
 *  first, to exercise the deposit-INSTANCE (not distinct-dataset) counting
 *  rule. */
const TIER_ROWS: DatasetLinkRow[] = [
  {
    cwid: "aaa1",
    scholarName: "Alice A",
    scholarSlug: "alice-a",
    department: "Medicine",
    datasetId: "d1",
    repository: "GSA-Human",
    accessModel: "open",
    pmids: ["p1"],
  },
  {
    cwid: "aaa1",
    scholarName: "Alice A",
    scholarSlug: "alice-a",
    department: "Medicine",
    // A second, distinct CONCERN-tier dataset for the same scholar — Alice's
    // `concerningDeposits` must be 2 (two link rows), not 1 (one scholar).
    datasetId: "d2",
    repository: "GSA",
    accessModel: "open",
    pmids: ["p2"],
  },
  {
    cwid: "bbb2",
    scholarName: "Bob B",
    scholarSlug: "bob-b",
    department: "Surgery",
    datasetId: "d3",
    repository: "Zenodo",
    accessModel: "open",
    pmids: ["p3"],
  },
  {
    cwid: "bbb2",
    scholarName: "Bob B",
    scholarSlug: "bob-b",
    department: "Surgery",
    datasetId: "d4",
    repository: "EGA",
    accessModel: "controlled",
    pmids: ["p4"],
  },
  {
    cwid: "ccc3",
    scholarName: "Cara C",
    scholarSlug: "cara-c",
    department: "Pediatrics",
    datasetId: "d5",
    repository: "GEO",
    accessModel: "open",
    pmids: ["p5"],
  },
  {
    cwid: "ccc3",
    scholarName: "Cara C",
    scholarSlug: "cara-c",
    department: "Pediatrics",
    datasetId: "d6",
    repository: "dbGaP",
    accessModel: "controlled",
    pmids: ["p6"],
  },
  {
    cwid: "ddd4",
    scholarName: "Dan D",
    scholarSlug: "dan-d",
    department: "Neurology",
    datasetId: "d7",
    repository: "ClinicalTrials.gov",
    accessModel: "open",
    dataType: REGISTRY_DATA_TYPE,
    pmids: ["p7"],
  },
];

describe("aggregateRepositoriesByTier", () => {
  it("groups aggregateByRepository's output by tier, summing datasets and listing repository names", () => {
    const byRepo = aggregateByRepository(TIER_ROWS);
    const byTier = aggregateRepositoriesByTier(byRepo);

    const concern = byTier.find((t) => t.tier === "CONCERN")!;
    expect(concern.datasets).toBe(2); // GSA-Human (1) + GSA (1)
    expect(concern.repositories.sort()).toEqual(["GSA", "GSA-Human"]);

    const foreignOpen = byTier.find((t) => t.tier === "FOREIGN_OPEN")!;
    expect(foreignOpen).toEqual({ tier: "FOREIGN_OPEN", datasets: 1, repositories: ["Zenodo"] });

    const foreignCtrl = byTier.find((t) => t.tier === "FOREIGN_CTRL")!;
    expect(foreignCtrl).toEqual({ tier: "FOREIGN_CTRL", datasets: 1, repositories: ["EGA"] });
  });

  it("sorts by catalog.py's tier priority order (CONCERN first, REGISTRY last)", () => {
    const byTier = aggregateRepositoriesByTier(aggregateByRepository(TIER_ROWS));
    expect(byTier.map((t) => t.tier)).toEqual([
      "CONCERN",
      "FOREIGN_OPEN",
      "FOREIGN_CTRL",
      "US_OPEN",
      "US_CTRL",
      "REGISTRY",
    ]);
  });

  it("zero-pads: a tier with no data still gets a row — 'Country of concern 0' is a statement, not an absence", () => {
    // Only US-tier repositories in the input; CONCERN (and every other tier)
    // must still appear, zero-filled, so the dashboard can SAY zero.
    const byTier = aggregateRepositoriesByTier(aggregateByRepository(ROWS));
    expect(byTier.map((t) => t.tier)).toEqual([
      "CONCERN",
      "FOREIGN_OPEN",
      "FOREIGN_CTRL",
      "US_OPEN",
      "US_CTRL",
      "REGISTRY",
    ]);
    expect(byTier.find((t) => t.tier === "CONCERN")).toEqual({
      tier: "CONCERN",
      datasets: 0,
      repositories: [],
    });
    expect(byTier.find((t) => t.tier === "US_OPEN")).toEqual({
      tier: "US_OPEN",
      datasets: 1,
      repositories: ["GEO"],
    });
  });

  it("empty input still emits every real tier zero-filled (and no UNKNOWN)", () => {
    expect(aggregateRepositoriesByTier([])).toEqual([
      { tier: "CONCERN", datasets: 0, repositories: [] },
      { tier: "FOREIGN_OPEN", datasets: 0, repositories: [] },
      { tier: "FOREIGN_CTRL", datasets: 0, repositories: [] },
      { tier: "US_OPEN", datasets: 0, repositories: [] },
      { tier: "US_CTRL", datasets: 0, repositories: [] },
      { tier: "REGISTRY", datasets: 0, repositories: [] },
    ]);
  });

  it("includes UNKNOWN only when a row actually carries it — no permanent 'Unclassified 0' row", () => {
    const withUnknown = aggregateRepositoriesByTier([
      { repository: "Some Future Repo", accessModel: null, datasets: 3, tier: "UNKNOWN" },
    ]);
    expect(withUnknown.find((t) => t.tier === "UNKNOWN")).toEqual({
      tier: "UNKNOWN",
      datasets: 3,
      repositories: ["Some Future Repo"],
    });
    // UNKNOWN sorts last, after REGISTRY, when present.
    expect(withUnknown[withUnknown.length - 1].tier).toBe("UNKNOWN");
  });
});

describe("tierPubSpectrum", () => {
  it("counts distinct pubs per tier, including registry (unlike pubAccessPmidSets)", () => {
    const spectrum = tierPubSpectrum(TIER_ROWS);
    const byTier = new Map(spectrum.map((s) => [s.tier, s.pubs]));
    expect(byTier.get("CONCERN")).toBe(2); // p1, p2
    expect(byTier.get("FOREIGN_OPEN")).toBe(1); // p3
    expect(byTier.get("FOREIGN_CTRL")).toBe(1); // p4
    expect(byTier.get("US_OPEN")).toBe(1); // p5
    expect(byTier.get("US_CTRL")).toBe(1); // p6
    expect(byTier.get("REGISTRY")).toBe(1); // p7 — registry rows count here
  });

  it("a pmid deposited in repositories of two different tiers lands in both tier buckets", () => {
    const rows: DatasetLinkRow[] = [
      { cwid: "s1", scholarName: "S", scholarSlug: "s", department: null, datasetId: "d1", repository: "GSA-Human", accessModel: "open", pmids: ["p1"] },
      { cwid: "s1", scholarName: "S", scholarSlug: "s", department: null, datasetId: "d2", repository: "GEO", accessModel: "open", pmids: ["p1"] },
    ];
    const byTier = new Map(tierPubSpectrum(rows).map((s) => [s.tier, s.pubs]));
    expect(byTier.get("CONCERN")).toBe(1);
    expect(byTier.get("US_OPEN")).toBe(1);
  });

  it("skips rows with no pmids — every tier still present, all zero (padding)", () => {
    const rows: DatasetLinkRow[] = [
      { cwid: "s1", scholarName: "S", scholarSlug: "s", department: null, datasetId: "d1", repository: "GSA-Human", accessModel: "open" },
    ];
    // The no-pmids row contributes nothing — but zero-padding still emits
    // every real tier, so the spectrum legend can render "0"s.
    expect(tierPubSpectrum(rows)).toEqual([
      { tier: "CONCERN", pubs: 0 },
      { tier: "FOREIGN_OPEN", pubs: 0 },
      { tier: "FOREIGN_CTRL", pubs: 0 },
      { tier: "US_OPEN", pubs: 0 },
      { tier: "US_CTRL", pubs: 0 },
      { tier: "REGISTRY", pubs: 0 },
    ]);
  });

  it("zero-pads tiers with no pubs and omits UNKNOWN unless a row carries it", () => {
    // One US_OPEN pub only — the other five real tiers appear zero-filled
    // ("Country of concern 0" must be a visible statement), UNKNOWN doesn't.
    const spectrum = tierPubSpectrum([
      { cwid: "s1", scholarName: "S", scholarSlug: "s", department: null, datasetId: "d1", repository: "GEO", accessModel: "open", pmids: ["p1"] },
    ]);
    expect(spectrum.map((s) => s.tier)).toEqual([
      "CONCERN",
      "FOREIGN_OPEN",
      "FOREIGN_CTRL",
      "US_OPEN",
      "US_CTRL",
      "REGISTRY",
    ]);
    expect(spectrum.find((s) => s.tier === "CONCERN")).toEqual({ tier: "CONCERN", pubs: 0 });
    expect(spectrum.find((s) => s.tier === "US_OPEN")).toEqual({ tier: "US_OPEN", pubs: 1 });

    // An unmapped repository → UNKNOWN appears, last.
    const withUnknown = tierPubSpectrum([
      { cwid: "s1", scholarName: "S", scholarSlug: "s", department: null, datasetId: "d2", repository: "Some Future Repo", accessModel: null, pmids: ["p9"] },
    ]);
    expect(withUnknown[withUnknown.length - 1]).toEqual({ tier: "UNKNOWN", pubs: 1 });
  });

  it("empty input still emits every real tier zero-filled (padding, not an empty array)", () => {
    expect(tierPubSpectrum([])).toEqual([
      { tier: "CONCERN", pubs: 0 },
      { tier: "FOREIGN_OPEN", pubs: 0 },
      { tier: "FOREIGN_CTRL", pubs: 0 },
      { tier: "US_OPEN", pubs: 0 },
      { tier: "US_CTRL", pubs: 0 },
      { tier: "REGISTRY", pubs: 0 },
    ]);
  });
});

describe("countConcerningDeposits", () => {
  it("counts deposit INSTANCES (rows), not distinct datasets — CONCERN and FOREIGN_* both count toward concerningDeposits", () => {
    const totals = countConcerningDeposits(TIER_ROWS);
    // CONCERN: 2 rows (d1, d2). FOREIGN_OPEN: 1 (d3). FOREIGN_CTRL: 1 (d4).
    // US_OPEN/US_CTRL/REGISTRY don't count.
    expect(totals.concerningDeposits).toBe(4);
  });

  it("foreignHostedDeposits excludes CONCERN — it's its own bucket, not 'foreign-hosted' in this taxonomy", () => {
    const totals = countConcerningDeposits(TIER_ROWS);
    // Only the two FOREIGN_* rows (d3 Zenodo, d4 EGA) — the two CONCERN rows
    // (d1, d2) do NOT also count here.
    expect(totals.foreignHostedDeposits).toBe(2);
  });

  it("a single scholar with two CONCERN-tier link rows counts 2, not 1 (deposit-instance grain)", () => {
    const rows = TIER_ROWS.filter((r) => r.cwid === "aaa1");
    expect(countConcerningDeposits(rows)).toEqual({ concerningDeposits: 2, foreignHostedDeposits: 0 });
  });

  it("US_OPEN/US_CTRL/REGISTRY rows never count toward either total", () => {
    const rows = TIER_ROWS.filter((r) => ["GEO", "dbGaP", "ClinicalTrials.gov"].includes(r.repository));
    expect(countConcerningDeposits(rows)).toEqual({ concerningDeposits: 0, foreignHostedDeposits: 0 });
  });

  it("empty input produces zeros", () => {
    expect(countConcerningDeposits([])).toEqual({ concerningDeposits: 0, foreignHostedDeposits: 0 });
  });
});

describe("aggregateByFaculty — concerning / foreign-hosted (risk tier)", () => {
  it("wires countConcerningDeposits' per-row rule into the per-faculty row, at deposit-instance grain", () => {
    const byFaculty = aggregateByFaculty(TIER_ROWS);
    const alice = byFaculty.find((f) => f.cwid === "aaa1")!; // 2 CONCERN rows
    const bob = byFaculty.find((f) => f.cwid === "bbb2")!; // 1 FOREIGN_OPEN + 1 FOREIGN_CTRL
    const cara = byFaculty.find((f) => f.cwid === "ccc3")!; // US_OPEN + US_CTRL only
    const dan = byFaculty.find((f) => f.cwid === "ddd4")!; // REGISTRY only

    expect(alice).toMatchObject({ concerningDeposits: 2, foreignHostedDeposits: 0 });
    expect(bob).toMatchObject({ concerningDeposits: 2, foreignHostedDeposits: 2 });
    expect(cara).toMatchObject({ concerningDeposits: 0, foreignHostedDeposits: 0 });
    expect(dan).toMatchObject({ concerningDeposits: 0, foreignHostedDeposits: 0 });
  });
});

describe("buildDataSharingReport — risk tier (this PR)", () => {
  it("wires byRepositoryTier, pubsByTier, and overall.concerningDepositInstances", () => {
    const report = buildDataSharingReport(TIER_ROWS);
    expect(report.overall.concerningDepositInstances).toBe(4); // same total as countConcerningDeposits
    expect(report.byRepositoryTier.find((t) => t.tier === "CONCERN")?.datasets).toBe(2);
    expect(report.pubsByTier.find((t) => t.tier === "CONCERN")?.pubs).toBe(2);

    const alice = report.byFaculty.find((f) => f.cwid === "aaa1")!;
    expect(alice).toMatchObject({ concerningDeposits: 2, foreignHostedDeposits: 0 });
  });
});

/** One row per sub-type, plus a second row on the same (genomic, WGS/WES)
 *  sub-type as the first row, to exercise the deposit-INSTANCE (row) count —
 *  not distinct-dataset — counting rule; a row that lists two sub-types (the
 *  Neurology row: genomic + geolocation), to exercise "counts once toward
 *  EACH sub-type it lists"; a row with no `sensitiveSubtypes` at all (the
 *  Surgery row), to exercise the skip path; and a row with a malformed
 *  (no-colon) token mixed into an otherwise-valid one, to exercise the
 *  per-token skip. */
const SUBTYPE_ROWS: DatasetLinkRow[] = [
  {
    cwid: "aaa1",
    scholarName: "Alice A",
    scholarSlug: "alice-a",
    department: "Medicine",
    datasetId: "d1",
    repository: "dbGaP",
    accessModel: "controlled",
    sensitiveSubtypes: "genomic:WGS/WES",
  },
  {
    cwid: "bbb2",
    scholarName: "Bob B",
    scholarSlug: "bob-b",
    department: "Medicine",
    datasetId: "d2",
    repository: "dbGaP",
    accessModel: "controlled",
    sensitiveSubtypes: "genomic:WGS/WES",
  },
  {
    cwid: "ccc3",
    scholarName: "Cara C",
    scholarSlug: "cara-c",
    department: "Neurology",
    datasetId: "d3",
    repository: "GEO",
    accessModel: "open",
    sensitiveSubtypes: "genomic:single-cell|geolocation:GPS trace",
  },
  {
    cwid: "ddd4",
    scholarName: "Dan D",
    scholarSlug: "dan-d",
    department: "Surgery",
    datasetId: "d4",
    repository: "Zenodo",
    accessModel: "open",
    sensitiveSubtypes: null,
  },
  {
    cwid: "eee5",
    scholarName: "Eve E",
    scholarSlug: "eve-e",
    department: "Medicine",
    datasetId: "d5",
    repository: "dbGaP",
    accessModel: "controlled",
    sensitiveSubtypes: "malformed-no-colon|health:clinical",
  },
];

describe("aggregateBySubtype", () => {
  it("counts deposit INSTANCES (rows) per sub-type, not distinct datasets", () => {
    const bySubtype = aggregateBySubtype(SUBTYPE_ROWS);
    const wgs = bySubtype.find((s) => s.subtype === "WGS/WES")!;
    expect(wgs).toEqual({ category: "genomic", subtype: "WGS/WES", count: 2 });
  });

  it("counts a row with multiple sub-types once toward EACH sub-type", () => {
    const bySubtype = aggregateBySubtype(SUBTYPE_ROWS);
    expect(bySubtype).toContainEqual({ category: "genomic", subtype: "single-cell", count: 1 });
    expect(bySubtype).toContainEqual({ category: "geolocation", subtype: "GPS trace", count: 1 });
  });

  it("skips a null sensitiveSubtypes row without crashing", () => {
    const bySubtype = aggregateBySubtype(SUBTYPE_ROWS);
    const total = bySubtype.reduce((sum, s) => sum + s.count, 0);
    // 2 (WGS/WES) + 1 (single-cell) + 1 (GPS trace) + 1 (clinical) = 5 —
    // the Surgery row (null) contributes nothing, and the malformed
    // "malformed-no-colon" token on the Eve row is skipped, not counted.
    expect(total).toBe(5);
  });

  it("skips a malformed (no-colon) token but keeps the well-formed one on the same row", () => {
    const bySubtype = aggregateBySubtype(SUBTYPE_ROWS);
    expect(bySubtype).toContainEqual({ category: "health", subtype: "clinical", count: 1 });
    expect(bySubtype.some((s) => s.subtype === "malformed-no-colon")).toBe(false);
  });

  it("sorts by category ascending, then count descending within category", () => {
    const bySubtype = aggregateBySubtype(SUBTYPE_ROWS);
    const categories = bySubtype.map((s) => s.category);
    const sortedCategories = [...categories].sort();
    expect(categories).toEqual(sortedCategories);
    const genomicRows = bySubtype.filter((s) => s.category === "genomic");
    expect(genomicRows[0]).toEqual({ category: "genomic", subtype: "WGS/WES", count: 2 });
  });

  it("returns an empty array for rows with no sensitiveSubtypes data", () => {
    expect(aggregateBySubtype(ROWS)).toEqual([]);
  });
});

const RECENT_ROWS: DatasetLinkRow[] = [
  { cwid: "a", scholarName: "A", scholarSlug: "a", department: null, datasetId: "d-2022", repository: "Zenodo", accessModel: "open", depositYear: 2022 },
  { cwid: "b", scholarName: "B", scholarSlug: "b", department: null, datasetId: "d-2024-late", repository: "GEO", accessModel: "open", depositYear: 2024 },
  { cwid: "c", scholarName: "C", scholarSlug: "c", department: null, datasetId: "d-2024-early", repository: "dbGaP", accessModel: "controlled", depositYear: 2024 },
  { cwid: "d", scholarName: "D", scholarSlug: "d", department: null, datasetId: "d-unknown", repository: "figshare", accessModel: "open", depositYear: undefined },
  { cwid: "e", scholarName: "E", scholarSlug: "e", department: null, datasetId: "d-2023", repository: "Zenodo", accessModel: "open", depositYear: 2023 },
];

describe("mostRecentDeposits", () => {
  it("sorts by depositYear descending", () => {
    const recent = mostRecentDeposits(RECENT_ROWS);
    expect(recent.map((r) => r.datasetId)).toEqual([
      "d-2024-early", // tiebreak below — both 2024
      "d-2024-late",
      "d-2023",
      "d-2022",
      "d-unknown", // no depositYear sorts LAST, not first
    ]);
  });

  it("breaks a same-year tie deterministically by datasetId, not DB return order", () => {
    const recent = mostRecentDeposits(RECENT_ROWS);
    const year2024 = recent.filter((r) => r.depositYear === 2024).map((r) => r.datasetId);
    // "d-2024-early" < "d-2024-late" lexically — same order regardless of
    // which one appeared first in the input array.
    expect(year2024).toEqual(["d-2024-early", "d-2024-late"]);
  });

  it("caps to the given limit, keeping the most recent", () => {
    const recent = mostRecentDeposits(RECENT_ROWS, 2);
    expect(recent.map((r) => r.datasetId)).toEqual(["d-2024-early", "d-2024-late"]);
  });

  it("defaults the limit to RECENT_ITEMS_LIMIT", () => {
    const rows = Array.from({ length: RECENT_ITEMS_LIMIT + 10 }, (_, i) => ({
      cwid: `c${i}`,
      scholarName: `C${i}`,
      scholarSlug: `c${i}`,
      department: null,
      datasetId: `d${i}`,
      repository: "Zenodo",
      accessModel: "open",
      depositYear: 2000 + i,
    }));
    expect(mostRecentDeposits(rows)).toHaveLength(RECENT_ITEMS_LIMIT);
  });

  it("does not mutate the input array", () => {
    const copy = [...RECENT_ROWS];
    mostRecentDeposits(RECENT_ROWS);
    expect(RECENT_ROWS).toEqual(copy);
  });

  it("returns [] for an empty input", () => {
    expect(mostRecentDeposits([])).toEqual([]);
  });
});

describe("buildDataSharingReport — granular sub-types (this PR)", () => {
  it("wires bySubtype from aggregateBySubtype", () => {
    const report = buildDataSharingReport(SUBTYPE_ROWS);
    expect(report.bySubtype).toEqual(aggregateBySubtype(SUBTYPE_ROWS));
    expect(report.bySubtype).toContainEqual({ category: "genomic", subtype: "WGS/WES", count: 2 });
  });
});

describe("buildDataSharingReport — recent activity", () => {
  it("wires recentItems from mostRecentDeposits", () => {
    const report = buildDataSharingReport(RECENT_ROWS);
    expect(report.recentItems).toEqual(mostRecentDeposits(RECENT_ROWS));
  });
});

describe("buildDataSharingReport", () => {
  it("overall counts are the true distinct totals, immune to the department double-count", () => {
    const report = buildDataSharingReport(ROWS);
    // `shareRateDenominator`/`shareRateNumerator` are always present on
    // `overall` (required, not optional) — zeroed here since ROWS is passed
    // with no `corpusRows` argument (the default-`[]` backward-compat path).
    // `openPubs`/`controlledPubs` are 0 here too — none of ROWS carries a
    // `pmids` field. `nihFundedPubs`/`notNihFundedPubs` are zeroed since no
    // `fundingSplit` argument was supplied either (same backward-compat path).
    // `concerningDepositInstances` is 0 too — ROWS is GEO (US_OPEN) + dbGaP
    // (US_CTRL) only, neither a concerning tier.
    // `pmcCoveredPubs`/`pmcDepositedPubs` are 0 for the same no-corpus reason
    // as the share-rate fields (PMC coverage is a corpus-side stat).
    expect(report.overall).toEqual({
      datasets: 2,
      faculty: 2,
      links: 3,
      shareRateDenominator: 0,
      shareRateNumerator: 0,
      pmcCoveredPubs: 0,
      pmcDepositedPubs: 0,
      openPubs: 0,
      controlledPubs: 0,
      nihFundedPubs: 0,
      notNihFundedPubs: 0,
      concerningDepositInstances: 0,
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
      pmcCoveredPubs: 0,
      pmcDepositedPubs: 0,
      openPubs: 0,
      controlledPubs: 0,
      nihFundedPubs: 0,
      notNihFundedPubs: 0,
      concerningDepositInstances: 0,
    });
    expect(report.byDepartment).toEqual([]);
    expect(report.byRepository).toEqual([]);
    // The tier aggregates zero-pad even on an empty report — "Country of
    // concern 0" stays a visible statement (see the padding tests above).
    expect(report.byRepositoryTier.map((t) => [t.tier, t.datasets])).toEqual([
      ["CONCERN", 0],
      ["FOREIGN_OPEN", 0],
      ["FOREIGN_CTRL", 0],
      ["US_OPEN", 0],
      ["US_CTRL", 0],
      ["REGISTRY", 0],
    ]);
    expect(report.pubsByTier.every((t) => t.pubs === 0)).toBe(true);
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

  it("skips registry-type rows — a registration is not a dataset deposit (v3 review finding)", () => {
    // "p1" appears ONLY on a ClinicalTrials.gov registration row: it must not
    // read as deposited (before the fix, a registration-only pub inflated the
    // share-rate numerator and pmcDepositedPubs while the methods prose
    // claimed registrations were excluded). "p2" sits on both the registry
    // row and a real GEO row — the real row still counts it.
    const set = depositedPmidSet([
      row({
        datasetId: "d1",
        repository: "ClinicalTrials.gov",
        accessModel: "open",
        dataType: REGISTRY_DATA_TYPE,
        pmids: ["p1", "p2"],
      }),
      row({ datasetId: "d2", pmids: ["p2"] }),
    ]);
    expect(set).toEqual(new Set(["p2"]));
  });
});

describe("bucketDatasetLink", () => {
  it("returns 'registry' for a REGISTRY_DATA_TYPE row regardless of accessModel", () => {
    expect(bucketDatasetLink({ dataType: REGISTRY_DATA_TYPE, accessModel: "open" })).toBe("registry");
    expect(bucketDatasetLink({ dataType: REGISTRY_DATA_TYPE, accessModel: null })).toBe("registry");
  });

  it("returns 'open' or 'controlled' for a non-registry row, keyed on accessModel", () => {
    expect(bucketDatasetLink({ dataType: "genomic", accessModel: "open" })).toBe("open");
    expect(bucketDatasetLink({ dataType: null, accessModel: "controlled" })).toBe("controlled");
  });

  it("returns null for a non-registry row with no recorded access model (the real ambiguous case — the Synapse fix)", () => {
    expect(bucketDatasetLink({ dataType: "genomic", accessModel: null })).toBeNull();
  });
});

describe("pubAccessPmidSets", () => {
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

  it("splits pmids into an open set and a controlled set", () => {
    const { openPmids, controlledPmids } = pubAccessPmidSets([
      row({ datasetId: "d1", accessModel: "open", pmids: ["p1"] }),
      row({ datasetId: "d2", accessModel: "controlled", pmids: ["p2"] }),
    ]);
    expect(openPmids).toEqual(new Set(["p1"]));
    expect(controlledPmids).toEqual(new Set(["p2"]));
  });

  it("excludes registry-type rows entirely, even when accessModel would otherwise resolve to open", () => {
    const { openPmids, controlledPmids } = pubAccessPmidSets([
      row({ dataType: REGISTRY_DATA_TYPE, accessModel: "open", pmids: ["p9"] }),
    ]);
    expect(openPmids.size).toBe(0);
    expect(controlledPmids.size).toBe(0);
  });

  it("a pmid with both an open deposit and a controlled deposit lands in both sets — real, not reconciled away", () => {
    const { openPmids, controlledPmids } = pubAccessPmidSets([
      row({ datasetId: "d1", accessModel: "open", pmids: ["p1"] }),
      row({ datasetId: "d2", accessModel: "controlled", pmids: ["p1"] }),
    ]);
    expect(openPmids.has("p1")).toBe(true);
    expect(controlledPmids.has("p1")).toBe(true);
  });

  it("a null accessModel on a non-registry row lands in neither set", () => {
    const { openPmids, controlledPmids } = pubAccessPmidSets([row({ accessModel: null, pmids: ["p1"] })]);
    expect(openPmids.size).toBe(0);
    expect(controlledPmids.size).toBe(0);
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
      tier: "US_OPEN",
    });
    expect(report.byRepository.find((r) => r.repository === "dbGaP")).toEqual({
      repository: "dbGaP",
      accessModel: "controlled",
      datasets: 1,
      tier: "US_CTRL",
    });
    // Rate fields present (required on `overall`, optional-but-populated on
    // the rollup rows) but zeroed — no corpus was supplied.
    expect(report.overall.shareRateDenominator).toBe(0);
    expect(report.overall.shareRateNumerator).toBe(0);
    expect(report.byDepartment.every((d) => d.shareRateDenominator === 0 && d.shareRateNumerator === 0)).toBe(true);
    expect(report.byFaculty.every((f) => f.shareRateDenominator === 0 && f.shareRateNumerator === 0)).toBe(true);
  });
});

describe("buildDataSharingReport — access split & funding lens (v2)", () => {
  // d1 (open, Medicine), d2 (controlled, Surgery), d3 (registry, Neurology —
  // a ClinicalTrials.gov row whose accessModel is 'open' but must NOT count
  // as an open dataset/pub, the exact case `bucketDatasetLink` guards).
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
      cwid: "bbb2",
      scholarName: "Bob B",
      scholarSlug: "bob-b",
      department: "Surgery",
      datasetId: "d2",
      repository: "dbGaP",
      accessModel: "controlled",
      pmids: ["p2"],
    },
    {
      cwid: "ccc3",
      scholarName: "Cara C",
      scholarSlug: "cara-c",
      department: "Neurology",
      datasetId: "d3",
      repository: "ClinicalTrials.gov",
      accessModel: "open",
      dataType: REGISTRY_DATA_TYPE,
      pmids: ["p3"],
    },
  ];

  it("computes overall openPubs/controlledPubs from pmids, excluding registry-type rows", () => {
    const report = buildDataSharingReport(LINK_ROWS);
    expect(report.overall.openPubs).toBe(1); // p1 only — p3 excluded (registry)
    expect(report.overall.controlledPubs).toBe(1); // p2
  });

  it("computes byDepartment open/controlled/registry dataset counts", () => {
    const report = buildDataSharingReport(LINK_ROWS);
    const medicine = report.byDepartment.find((d) => d.department === "Medicine")!;
    const surgery = report.byDepartment.find((d) => d.department === "Surgery")!;
    const neurology = report.byDepartment.find((d) => d.department === "Neurology")!;
    expect(medicine).toMatchObject({ openDatasets: 1, controlledDatasets: 0, registryDatasets: 0 });
    expect(surgery).toMatchObject({ openDatasets: 0, controlledDatasets: 1, registryDatasets: 0 });
    expect(neurology).toMatchObject({ openDatasets: 0, controlledDatasets: 0, registryDatasets: 1 });
  });

  it("computes byFaculty open/controlled dataset counts, with no registry column", () => {
    const report = buildDataSharingReport(LINK_ROWS);
    const cara = report.byFaculty.find((f) => f.cwid === "ccc3")!;
    // Cara's only dataset is the registry row — she has a dataset but it
    // lands in neither the open nor controlled bucket.
    expect(cara).toMatchObject({ datasets: 1, openDatasets: 0, controlledDatasets: 0 });
    expect(cara).not.toHaveProperty("registryDatasets");
  });

  it("excludes a registration-only pub from the share-rate numerator and pmcDepositedPubs (v3 review finding)", () => {
    // p3's only detected signal is the ClinicalTrials.gov registration row —
    // it stays in the DENOMINATOR (it is a real corpus pub) but must not
    // count as deposited, in either the overall rate or the PMC-covered rate.
    const corpus: ShareRateCorpusRow[] = [
      { pmid: "p1", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p2", cwid: "bbb2", department: "Surgery", inPmc: true },
      { pmid: "p3", cwid: "ccc3", department: "Neurology", inPmc: true },
    ];
    const report = buildDataSharingReport(LINK_ROWS, corpus);
    expect(report.overall.shareRateDenominator).toBe(3);
    expect(report.overall.shareRateNumerator).toBe(2); // p1, p2 — never p3
    expect(report.overall.pmcCoveredPubs).toBe(3);
    expect(report.overall.pmcDepositedPubs).toBe(2);
    const neurology = report.byDepartment.find((d) => d.department === "Neurology")!;
    expect(neurology.shareRateDenominator).toBe(1);
    expect(neurology.shareRateNumerator).toBe(0);
  });

  it("defaults nihFundedPubs/notNihFundedPubs to 0 when no fundingSplit argument is supplied (backward compat)", () => {
    const report = buildDataSharingReport(LINK_ROWS);
    expect(report.overall.nihFundedPubs).toBe(0);
    expect(report.overall.notNihFundedPubs).toBe(0);
  });

  it("merges a supplied fundingSplit onto overall, untouched", () => {
    const report = buildDataSharingReport(LINK_ROWS, [], { nihFundedPubs: 3, notNihFundedPubs: 5 });
    expect(report.overall.nihFundedPubs).toBe(3);
    expect(report.overall.notNihFundedPubs).toBe(5);
  });
});

describe("loadFundingSplit", () => {
  // Same three-row shape as the block above: d1/p1 open, d2/p2 controlled,
  // d3/p3 registry (must never reach the funding query).
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
      cwid: "bbb2",
      scholarName: "Bob B",
      scholarSlug: "bob-b",
      department: "Surgery",
      datasetId: "d2",
      repository: "dbGaP",
      accessModel: "controlled",
      pmids: ["p2"],
    },
    {
      cwid: "ccc3",
      scholarName: "Cara C",
      scholarSlug: "cara-c",
      department: "Neurology",
      datasetId: "d3",
      repository: "ClinicalTrials.gov",
      accessModel: "open",
      dataType: REGISTRY_DATA_TYPE,
      pmids: ["p3"],
    },
  ];

  it("queries grantPublication scoped to the non-registry deposited pmids only", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { pmid: "p1", grant: { nihIc: "NCI" } },
      { pmid: "p2", grant: { nihIc: null } },
    ]);
    const client = { grantPublication: { findMany } } as unknown as DataSharingReportClient;

    const split = await loadFundingSplit(client, LINK_ROWS);

    expect(findMany).toHaveBeenCalledTimes(1);
    const call = findMany.mock.calls[0][0];
    expect([...call.where.pmid.in].sort()).toEqual(["p1", "p2"]); // p3 excluded — registry-only pmid
    expect(split).toEqual({ nihFundedPubs: 1, notNihFundedPubs: 1 });
  });

  it("counts a pmid as NIH-funded if ANY of its grantPublication rows has a non-null nihIc", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { pmid: "p1", grant: { nihIc: null } },
      { pmid: "p1", grant: { nihIc: "NHLBI" } },
    ]);
    const client = { grantPublication: { findMany } } as unknown as DataSharingReportClient;

    const split = await loadFundingSplit(client, [LINK_ROWS[0]]);
    expect(split).toEqual({ nihFundedPubs: 1, notNihFundedPubs: 0 });
  });

  it("a deposited pmid with no matching grantPublication rows counts as not-NIH-funded", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { grantPublication: { findMany } } as unknown as DataSharingReportClient;

    const split = await loadFundingSplit(client, [LINK_ROWS[0]]);
    expect(split).toEqual({ nihFundedPubs: 0, notNihFundedPubs: 1 });
  });

  it("skips the DB round-trip entirely when the non-registry deposited pmid population is empty", async () => {
    const findMany = vi.fn();
    const client = { grantPublication: { findMany } } as unknown as DataSharingReportClient;

    // LINK_ROWS[2] is the registry-only row — its pmid never reaches the query.
    const split = await loadFundingSplit(client, [LINK_ROWS[2]]);
    expect(findMany).not.toHaveBeenCalled();
    expect(split).toEqual({ nihFundedPubs: 0, notNihFundedPubs: 0 });
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
        sensitiveCats: "genomic",
        sensitiveSubtypes: "genomic:WGS/WES",
        depositYear: 2025,
        provenance: "databank",
        confidence: "high",
        pmids: ["11111111", "22222222"],
      },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "repository,accession_or_doi,dataset_url,title,resource_type,data_type,sensitive_cats,sensitive_subtypes,access_model,deposit_year,provenance,confidence,department,faculty_name,cwid,pmids",
    );
    // dataset_url is the profile page's own per-accession deep link
    // (resolveDatasetUrl) — GEO resolves through the acc.cgi query template.
    expect(lines[1]).toBe(
      'GEO,GSE12345,https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE12345,"A dataset, with a comma in the title",Dataset,genomic,genomic,genomic:WGS/WES,open,2025,databank,high,Medicine,"Alice, A",aaa1,11111111; 22222222',
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
        sensitiveCats: null,
        sensitiveSubtypes: null,
        depositYear: null,
        provenance: undefined,
        confidence: null,
      },
    ]);
    const line = csv.trimEnd().split("\r\n")[1];
    // No accessionOrDoi → dataset_url is empty too, not a homepage fallback.
    expect(line).toBe("dbGaP,,,,,,,,,,,,,Bob B,bbb2,");
  });

  it("resolves dataset_url per accession: DOI → doi.org, unmapped repository → empty", () => {
    const base = {
      cwid: "aaa1",
      scholarName: "Alice A",
      scholarSlug: "alice-a",
      department: null,
      datasetId: "d1",
      accessModel: null,
    };
    const csv = buildDataSharingCsv([
      // A DOI-keyed row resolves via the DOI pattern regardless of repository.
      { ...base, repository: "Dryad", accessionOrDoi: "10.5061/dryad.abc123" },
      // A repository with no accession resolver (and a non-DOI accession) → "".
      { ...base, datasetId: "d2", repository: "Some Future Repo", accessionOrDoi: "XYZ-1" },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[1].split(",")[2]).toBe("https://doi.org/10.5061/dryad.abc123");
    expect(lines[2].split(",")[2]).toBe("");
  });
});

describe("buildSectionItemsCsv", () => {
  /** Two repositories × two faculty (names deliberately out of input order)
   *  plus a null-department row — enough to see each section's ordering. */
  const ITEM_ROWS: DatasetLinkRow[] = [
    {
      cwid: "bbb2",
      scholarName: "Bob B",
      scholarSlug: "bob-b",
      department: "Surgery",
      datasetId: "d2",
      repository: "GEO",
      accessModel: "open",
    },
    {
      cwid: "aaa1",
      scholarName: "Alice A",
      scholarSlug: "alice-a",
      department: "Medicine",
      datasetId: "d1",
      repository: "dbGaP",
      accessModel: "controlled",
    },
    {
      cwid: "aaa1",
      scholarName: "Alice A",
      scholarSlug: "alice-a",
      department: "Medicine",
      datasetId: "d3",
      repository: "GEO",
      accessModel: "open",
    },
    {
      cwid: "zzz9",
      scholarName: "Zed Z",
      scholarSlug: "zed-z",
      department: null,
      datasetId: "d4",
      repository: "Zenodo",
      accessModel: "open",
    },
  ];

  const HEADER =
    "repository,accession_or_doi,dataset_url,title,resource_type,data_type,sensitive_cats,sensitive_subtypes,access_model,deposit_year,provenance,confidence,department,faculty_name,cwid,pmids";

  it("returns null for the tiers section — the repositories grain is the tier drill-down", () => {
    expect(buildSectionItemsCsv(ITEM_ROWS, "tiers")).toBeNull();
  });

  it("repositories: every row, same columns as the default export, sorted repository then faculty name", () => {
    const lines = buildSectionItemsCsv(ITEM_ROWS, "repositories")!.trimEnd().split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["dbGaP", "GEO", "GEO", "Zenodo"]);
    // Within GEO: Alice before Bob.
    expect(lines[2]).toContain("Alice A");
    expect(lines[3]).toContain("Bob B");
  });

  it("departments: sorted by department with the null department LAST (serialized as empty), then faculty name", () => {
    const lines = buildSectionItemsCsv(ITEM_ROWS, "departments")!.trimEnd().split("\r\n");
    expect(lines[0]).toBe(HEADER);
    const depts = lines.slice(1).map((l) => l.split(",")[12]);
    expect(depts).toEqual(["Medicine", "Medicine", "Surgery", ""]);
    expect(lines[4]).toContain("Zed Z"); // the null-department row, last
  });

  it("faculty: sorted by faculty name then repository", () => {
    const lines = buildSectionItemsCsv(ITEM_ROWS, "faculty")!.trimEnd().split("\r\n");
    const nameRepo = lines.slice(1).map((l) => {
      const cells = l.split(",");
      return `${cells[13]}:${cells[0]}`;
    });
    // Locale collation orders by base letter, so dbGaP < GEO despite case.
    expect(nameRepo).toEqual(["Alice A:dbGaP", "Alice A:GEO", "Bob B:GEO", "Zed Z:Zenodo"]);
  });

  it("subtypes: EXPLODED — one row per (link row, parsed sub-type) pair, leading category/subtype columns, no-subtype rows omitted", () => {
    // SUBTYPE_ROWS (above): d1+d2 genomic:WGS/WES, d3 genomic:single-cell +
    // geolocation:GPS trace, d4 null (omitted), d5 malformed + health:clinical
    // — 5 exploded rows, the malformed token skipped exactly as
    // aggregateBySubtype skips it.
    const lines = buildSectionItemsCsv(SUBTYPE_ROWS, "subtypes")!.trimEnd().split("\r\n");
    expect(lines[0]).toBe(`category,subtype,${HEADER}`);
    const leading = lines.slice(1).map((l) => {
      const cells = l.split(",");
      return `${cells[0]}|${cells[1]}|${cells[2]}`;
    });
    // Sorted category ("genomic" < "geolocation" — 'n' < 'o'), then subtype,
    // then repository; the d3 row appears once per sub-type it lists.
    expect(leading).toEqual([
      "genomic|single-cell|GEO",
      "genomic|WGS/WES|dbGaP",
      "genomic|WGS/WES|dbGaP",
      "geolocation|GPS trace|GEO",
      "health|clinical|dbGaP",
    ]);
    // No row for Dan D (null sensitiveSubtypes); the malformed token never
    // becomes a category/subtype (though the raw sensitive_subtypes source
    // column on Eve's row still carries it verbatim — that's the source
    // value, exported as-is).
    expect(lines.join("\n")).not.toContain("Dan D");
    expect(lines.slice(1).some((l) => l.startsWith("malformed-no-colon,"))).toBe(false);
  });

  it("caps output rows at DATA_SHARING_EXPORT_CAP", () => {
    const rows: DatasetLinkRow[] = Array.from({ length: DATA_SHARING_EXPORT_CAP + 1 }, (_, i) => ({
      cwid: `s${i}`,
      scholarName: `S${i}`,
      scholarSlug: `s${i}`,
      department: null,
      datasetId: `d${i}`,
      repository: "GEO",
      accessModel: "open",
    }));
    const lines = buildSectionItemsCsv(rows, "repositories")!.trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + DATA_SHARING_EXPORT_CAP);
  });

  it("caps subtypes AFTER exploding — the cap bounds the file, not the input rows", () => {
    // 2,501 input rows × 2 sub-types each = 5,002 exploded rows → capped to
    // DATA_SHARING_EXPORT_CAP even though the INPUT is well under the cap.
    const rows: DatasetLinkRow[] = Array.from({ length: DATA_SHARING_EXPORT_CAP / 2 + 1 }, (_, i) => ({
      cwid: `s${i}`,
      scholarName: `S${i}`,
      scholarSlug: `s${i}`,
      department: null,
      datasetId: `d${i}`,
      repository: "dbGaP",
      accessModel: "controlled",
      sensitiveSubtypes: "genomic:WGS/WES|health:clinical",
    }));
    const lines = buildSectionItemsCsv(rows, "subtypes")!.trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + DATA_SHARING_EXPORT_CAP);
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
  it("queries publicationAuthor with first-OR-last, confirmed, non-null cwid, the year floor, and the publication-type scope", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { publicationAuthor: { findMany } } as unknown as DataSharingReportClient;

    await loadShareRateCorpus(client);

    expect(findMany).toHaveBeenCalledTimes(1);
    const call = findMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([{ isFirst: true }, { isLast: true }]);
    expect(call.where.isConfirmed).toBe(true);
    expect(call.where.cwid).toEqual({ not: null });
    expect(call.where.publication.year.gte).toBe(SHARE_RATE_YEAR_FLOOR);
    // 2026-08-15: denominator scoped to the same types the deposit-scan pipeline
    // covers (extract_databanks.py / preprint_extend.py) — see the handoff.
    expect(call.where.publication.publicationType).toEqual({
      in: ["Academic Article", "Preprint"],
    });
    // PMC coverage (v3): the select must reach through the publication
    // relation for pmcid — dropping this silently zeroes pmcCoveredPubs.
    expect(call.select.publication).toEqual({ select: { pmcid: true } });
  });

  it("maps rows to pmid/cwid/department/inPmc, defaulting a missing department to null", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { pmid: "p1", cwid: "aaa1", scholar: { primaryDepartment: "Medicine" }, publication: { pmcid: "PMC111" } },
      { pmid: "p2", cwid: "bbb2", scholar: { primaryDepartment: null }, publication: { pmcid: null } },
      { pmid: "p3", cwid: "ccc3", scholar: null, publication: null },
    ]);
    const client = { publicationAuthor: { findMany } } as unknown as DataSharingReportClient;

    const rows = await loadShareRateCorpus(client);

    // `inPmc` is simply "pmcid non-null" — p3's missing publication relation
    // degrades to false, not a crash.
    expect(rows).toEqual([
      { pmid: "p1", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p2", cwid: "bbb2", department: null, inPmc: false },
      { pmid: "p3", cwid: "ccc3", department: null, inPmc: false },
    ]);
  });
});

describe("pmcCoverage", () => {
  it("counts distinct PMC-covered corpus pmids and the deposited subset", () => {
    const corpus: ShareRateCorpusRow[] = [
      { pmid: "p1", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p2", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p3", cwid: "bbb2", department: "Surgery", inPmc: false },
    ];
    // p1 deposited and in PMC; p2 in PMC, no deposit; p3 deposited but NOT in
    // PMC — it counts toward neither field (the full-text arm never saw it).
    const totals = pmcCoverage(corpus, new Set(["p1", "p3"]));
    expect(totals).toEqual({ pmcCoveredPubs: 2, pmcDepositedPubs: 1 });
  });

  it("dedups a pmid with both a first- and a last-author corpus row (same distinct-pmid grain as buildShareRates.overall)", () => {
    const corpus: ShareRateCorpusRow[] = [
      { pmid: "p1", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p1", cwid: "bbb2", department: "Surgery", inPmc: true },
    ];
    expect(pmcCoverage(corpus, new Set(["p1"]))).toEqual({ pmcCoveredPubs: 1, pmcDepositedPubs: 1 });
  });

  it("treats a pre-PMC fixture row with no inPmc field as not-in-PMC (backward compat)", () => {
    const corpus: ShareRateCorpusRow[] = [{ pmid: "p1", cwid: "aaa1", department: null }];
    expect(pmcCoverage(corpus, new Set(["p1"]))).toEqual({ pmcCoveredPubs: 0, pmcDepositedPubs: 0 });
  });

  it("empty corpus produces zeros", () => {
    expect(pmcCoverage([], new Set(["p1"]))).toEqual({ pmcCoveredPubs: 0, pmcDepositedPubs: 0 });
  });
});

describe("buildDataSharingReport — PMC coverage (v3)", () => {
  it("wires overall.pmcCoveredPubs/pmcDepositedPubs from the corpus + deposited-pmid set", () => {
    const linkRows: DatasetLinkRow[] = [
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
    ];
    const corpus: ShareRateCorpusRow[] = [
      { pmid: "p1", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p2", cwid: "aaa1", department: "Medicine", inPmc: true },
      { pmid: "p3", cwid: "aaa1", department: "Medicine", inPmc: false },
    ];
    const report = buildDataSharingReport(linkRows, corpus);
    expect(report.overall.pmcCoveredPubs).toBe(2); // p1, p2
    expect(report.overall.pmcDepositedPubs).toBe(1); // p1 only
    // Unchanged share-rate fields still count the full corpus, not the PMC
    // subset — the two denominators coexist on purpose.
    expect(report.overall.shareRateDenominator).toBe(3);
    expect(report.overall.shareRateNumerator).toBe(1);
  });
});
