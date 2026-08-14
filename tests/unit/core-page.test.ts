/**
 * Pure selection for the public per-core page (lib/api/cores
 * selectCorePublications). The DB load is thin; this exercises the
 * effective-confirmed CoreClaim merge and the year-desc, pmid-desc ordering.
 */
import { describe, expect, it } from "vitest";
import { getCoreList, getCorePage, selectCorePublications } from "@/lib/api/cores";

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
  // Minimal injected reader: the three reads getCoreList performs.
  const reader = (
    cores: Array<{ id: string; name: string; facility: string | null }>,
    confirmedPairs: Array<{ coreId: string; pmid: string }>,
    activeClaims: Array<{ coreId: string; pmid: string; status: "claimed" | "rejected" }> = [],
  ) =>
    ({
      core: { findMany: async () => cores },
      publicationCore: { findMany: async () => confirmedPairs },
      coreClaim: { findMany: async () => activeClaims },
    }) as unknown as Parameters<typeof getCoreList>[0];

  it("sorts by numeric id (not string) and flags cores with confirmed publications", async () => {
    const out = await getCoreList(
      reader(
        [
          { id: "10", name: "Microscopy", facility: "Microscopy Core" },
          { id: "2", name: "Imaging", facility: "CBIC" },
          { id: "1", name: "Bioinformatics", facility: null },
        ],
        [{ coreId: "2", pmid: "111" }], // only core 2 has an engine-confirmed pair
      ),
    );
    expect(out.map((c) => c.id)).toEqual(["1", "2", "10"]); // numeric, not "1","10","2"
    expect(out.map((c) => c.hasConfirmedPublications)).toEqual([false, true, false]);
  });

  it("flags a core whose only confirmed usage is a manual claim (no engine-confirmed row)", async () => {
    // Bug being fixed: under the old distinct-coreId-on-engine-status-only
    // query, core "3" would never appear in the confirmed set — the human
    // claim is the sole source of "confirmed" for this (pub, core) pair.
    const out = await getCoreList(
      reader(
        [{ id: "3", name: "Genomics", facility: "Genomics Core" }],
        [], // no engine-confirmed pairs at all
        [{ coreId: "3", pmid: "222", status: "claimed" }],
      ),
    );
    expect(out.map((c) => c.hasConfirmedPublications)).toEqual([true]);
  });

  it("drops a core whose only engine-confirmed pair was human-rejected", async () => {
    const out = await getCoreList(
      reader(
        [{ id: "4", name: "Proteomics", facility: "Proteomics Core" }],
        [{ coreId: "4", pmid: "333" }],
        [{ coreId: "4", pmid: "333", status: "rejected" }],
      ),
    );
    expect(out.map((c) => c.hasConfirmedPublications)).toEqual([false]);
  });
});

describe("getCorePage — manual PMID add", () => {
  const reader = (
    claims: Array<{ pmid: string; status: "claimed" | "rejected" }>,
    publications: Array<Record<string, unknown>>,
  ) =>
    ({
      core: { findUnique: async () => ({ id: "2", name: "Imaging", facility: "CBIC" }) },
      publicationCore: { findMany: async () => [] }, // engine never scored anything for this core
      coreClaim: { findMany: async () => claims },
      publication: { findMany: async () => publications },
    }) as unknown as Parameters<typeof getCorePage>[1];

  it("shows a manually-claimed pmid with no engine publication_core row", async () => {
    const page = await getCorePage(
      "2",
      reader(
        [{ pmid: "99999999", status: "claimed" }],
        [
          {
            pmid: "99999999",
            title: "A paper the engine never scored",
            journal: "Cell Reports",
            year: 2019,
            citationCount: 3,
            doi: null,
            pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/99999999/",
          },
        ],
      ),
    );
    expect(page?.publications.map((p) => p.pmid)).toEqual(["99999999"]);
    expect(page?.publications[0]?.title).toBe("A paper the engine never scored");
  });

  it("does not surface a manually-rejected pmid with no engine row (nothing to reject)", async () => {
    const page = await getCorePage("2", reader([{ pmid: "99999999", status: "rejected" }], []));
    expect(page?.publications).toEqual([]);
  });
});
