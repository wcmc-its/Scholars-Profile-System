/**
 * Pure selection for the public per-core page (lib/api/cores
 * selectCorePublications). The DB load is thin; this exercises the
 * effective-confirmed CoreClaim merge and the year-desc, pmid-desc ordering.
 */
import { describe, expect, it } from "vitest";
import { getCoreList, selectCorePublications } from "@/lib/api/cores";

type Row = Parameters<typeof selectCorePublications>[0][number];

const row = (over: Partial<Row> = {}): Row => ({
  pmid: "1",
  status: "confirmed",
  title: "T",
  journal: "J",
  year: 2021,
  citationCount: 0,
  doi: null,
  pubmedUrl: null,
  ...over,
});

describe("selectCorePublications", () => {
  it("keeps confirmed + claimed, drops open candidate + rejected, sorts year desc then pmid desc", () => {
    const out = selectCorePublications(
      [
        row({ pmid: "10", status: "confirmed", year: 2020 }),
        row({ pmid: "20", status: "candidate", year: 2023 }), // claimed → in
        row({ pmid: "30", status: "candidate", year: 2024 }), // open candidate → out
        row({ pmid: "40", status: "confirmed", year: 2020 }), // rejected → out
        row({ pmid: "50", status: "confirmed", year: 2020 }), // in; ties 2020 with pmid 10
      ],
      (pmid) => (pmid === "20" ? "claimed" : pmid === "40" ? "rejected" : null),
    );
    expect(out.map((p) => p.pmid)).toEqual(["20", "50", "10"]);
  });

  it("returns an empty array when nothing is effective-confirmed", () => {
    const out = selectCorePublications(
      [row({ pmid: "1", status: "candidate" }), row({ pmid: "2", status: "below_threshold" })],
      () => null,
    );
    expect(out).toEqual([]);
  });
});

describe("getCoreList", () => {
  // Minimal injected reader: the two reads getCoreList performs.
  const reader = (
    cores: Array<{ id: string; name: string; facility: string | null }>,
    confirmedCoreIds: string[],
  ) =>
    ({
      core: { findMany: async () => cores },
      publicationCore: { findMany: async () => confirmedCoreIds.map((coreId) => ({ coreId })) },
    }) as unknown as Parameters<typeof getCoreList>[0];

  it("sorts by numeric id (not string) and flags cores with confirmed publications", async () => {
    const out = await getCoreList(
      reader(
        [
          { id: "10", name: "Microscopy", facility: "Microscopy Core" },
          { id: "2", name: "Imaging", facility: "CBIC" },
          { id: "1", name: "Bioinformatics", facility: null },
        ],
        ["2"], // only core 2 has confirmed pubs
      ),
    );
    expect(out.map((c) => c.id)).toEqual(["1", "2", "10"]); // numeric, not "1","10","2"
    expect(out.map((c) => c.hasConfirmedPublications)).toEqual([false, true, false]);
  });
});
