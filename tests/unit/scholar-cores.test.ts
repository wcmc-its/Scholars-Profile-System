/**
 * Pure aggregation for the "Cores used" profile chips (lib/api/scholar-cores).
 * The DB loader is thin and integration-covered; this exercises the grouping,
 * the effective-confirmed CoreClaim merge, and the ordering only.
 */
import { describe, expect, it } from "vitest";
import { groupScholarCores } from "@/lib/api/scholar-cores";

type Row = Parameters<typeof groupScholarCores>[0][number];

function row(over: Partial<Row> = {}): Row {
  return {
    pmid: "1",
    coreId: "2",
    coreName: "Biomedical Imaging",
    etlStatus: "confirmed",
    claim: null,
    ...over,
  };
}

describe("groupScholarCores", () => {
  it("counts distinct publications per core, including engine-confirmed and claimed", () => {
    const out = groupScholarCores([
      row({ pmid: "1", coreId: "2", etlStatus: "confirmed" }),
      row({ pmid: "2", coreId: "2", etlStatus: "candidate", claim: "claimed" }),
      row({ pmid: "3", coreId: "5", coreName: "Flow Cytometry", etlStatus: "confirmed" }),
    ]);
    expect(out).toEqual([
      { coreId: "2", name: "Biomedical Imaging", pubCount: 2 },
      { coreId: "5", name: "Flow Cytometry", pubCount: 1 },
    ]);
  });

  it("excludes open candidates, below_threshold, and rejected claims", () => {
    const out = groupScholarCores([
      row({ pmid: "1", etlStatus: "candidate", claim: null }),
      row({ pmid: "2", etlStatus: "below_threshold", claim: null }),
      row({ pmid: "3", etlStatus: "confirmed", claim: "rejected" }),
    ]);
    expect(out).toEqual([]);
  });

  it("counts a publication once per core even if a row is duplicated", () => {
    const out = groupScholarCores([
      row({ pmid: "1", coreId: "2" }),
      row({ pmid: "1", coreId: "2" }),
    ]);
    expect(out).toEqual([{ coreId: "2", name: "Biomedical Imaging", pubCount: 1 }]);
  });

  it("sorts by pubCount desc, then name asc", () => {
    const out = groupScholarCores([
      row({ pmid: "1", coreId: "9", coreName: "Zebrafish" }),
      row({ pmid: "2", coreId: "3", coreName: "Genomics" }),
      row({ pmid: "3", coreId: "3", coreName: "Genomics" }),
      row({ pmid: "4", coreId: "1", coreName: "Antibody" }),
    ]);
    // Genomics (2) leads; Antibody and Zebrafish tie at 1 → name ascending.
    expect(out.map((c) => c.name)).toEqual(["Genomics", "Antibody", "Zebrafish"]);
  });
});
