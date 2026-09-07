/**
 * Pure selection for the public per-core page (lib/api/cores
 * selectCorePublications). The DB load is thin; this exercises the
 * effective-confirmed CoreClaim merge and the year-desc, pmid-desc ordering.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getCoreList,
  getCorePage,
  loadConfirmedCorePmidsByCore,
  selectCorePublications,
} from "@/lib/api/cores";
import { claimKey, isEffectiveConfirmed } from "@/lib/api/core-merge";

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

describe("loadConfirmedCorePmidsByCore", () => {
  // Backs `/edit/reports/{3,6}` for a `core` unit (core-reports widening) and
  // that suite's liveness. Same CoreClaim-over-engine-status merge
  // `getCorePage`/`getCoreList` apply, batched across cores.
  const reader = (
    rows: Array<{ coreId: string; pmid: string; status: string }>,
    claims: Array<{ coreId: string; pmid: string; status: "claimed" | "rejected" }> = [],
  ) =>
    ({
      publicationCore: { findMany: async () => rows },
      coreClaim: { findMany: async () => claims },
    }) as unknown as Parameters<typeof loadConfirmedCorePmidsByCore>[1];

  it("keeps engine-confirmed, drops open candidate / below_threshold, per core", async () => {
    const out = await loadConfirmedCorePmidsByCore(
      ["14", "9"],
      reader([
        { coreId: "14", pmid: "111", status: "confirmed" },
        { coreId: "14", pmid: "222", status: "candidate" },
        { coreId: "14", pmid: "333", status: "below_threshold" },
        { coreId: "9", pmid: "444", status: "confirmed" },
      ]),
    );
    expect(out.get("14")).toEqual(["111"]);
    expect(out.get("9")).toEqual(["444"]);
  });

  it("an active 'claimed' promotes any engine status; an active 'rejected' removes an engine-confirmed pair", async () => {
    const out = await loadConfirmedCorePmidsByCore(
      ["14"],
      reader(
        [
          { coreId: "14", pmid: "111", status: "confirmed" },
          { coreId: "14", pmid: "222", status: "candidate" },
          { coreId: "14", pmid: "333", status: "below_threshold" },
        ],
        [
          { coreId: "14", pmid: "111", status: "rejected" },
          { coreId: "14", pmid: "222", status: "claimed" },
          { coreId: "14", pmid: "333", status: "claimed" },
        ],
      ),
    );
    expect([...(out.get("14") ?? [])].sort()).toEqual(["222", "333"]);
  });

  it("includes a manual PMID add — a claimed pair with no publication_core row at all", async () => {
    const out = await loadConfirmedCorePmidsByCore(
      ["14"],
      reader([], [{ coreId: "14", pmid: "999", status: "claimed" }]),
    );
    expect(out.get("14")).toEqual(["999"]);
  });

  it("a claim on a core that was not asked about never leaks into another core's set", async () => {
    const out = await loadConfirmedCorePmidsByCore(
      ["14"],
      reader(
        [{ coreId: "9", pmid: "888", status: "confirmed" }],
        [{ coreId: "9", pmid: "777", status: "claimed" }],
      ),
    );
    expect(out.get("14")).toEqual([]);
    expect(out.has("9")).toBe(false);
  });

  it("every requested core id is a key, with [] for one that has no confirmed usages", async () => {
    const out = await loadConfirmedCorePmidsByCore(["14", "7"], reader([]));
    expect(out.get("14")).toEqual([]);
    expect(out.get("7")).toEqual([]);
  });

  it("issues no queries for an empty core list", async () => {
    const publicationCore = { findMany: vi.fn() };
    const coreClaim = { findMany: vi.fn() };
    const out = await loadConfirmedCorePmidsByCore(
      [],
      { publicationCore, coreClaim } as unknown as Parameters<typeof loadConfirmedCorePmidsByCore>[1],
    );
    expect(out.size).toBe(0);
    expect(publicationCore.findMany).not.toHaveBeenCalled();
    expect(coreClaim.findMany).not.toHaveBeenCalled();
  });
});

/**
 * DIFFERENTIAL over the one thing that changed in `loadConfirmedCorePmidsByCore`:
 * the engine read went from `where: { coreId: { in } }` (every row for these
 * cores, non-confirmed ones discarded in JS) to
 * `where: { coreId: { in }, status: "confirmed" }`, the index-backed shape.
 *
 * `legacyLoad` below is the pre-fix merge, reproduced against an UNFILTERED row
 * list and reusing the same `core-merge` primitives, so the only difference
 * under test is the `where`. The fake client here HONORS `where` (the fixtures
 * in the describe above do not) — otherwise a filtered read and an unfiltered
 * one are trivially identical and the differential proves nothing.
 *
 * Each side is also asserted against a hand-written expected set, so a merge
 * bug present in BOTH implementations cannot pass as "equivalent".
 */
describe("loadConfirmedCorePmidsByCore — status-filtered engine read", () => {
  type EngineRow = { coreId: string; pmid: string; status: string };
  type ClaimRow = {
    coreId: string;
    pmid: string;
    status: "claimed" | "rejected";
    revokedAt: Date | null;
  };

  const REVOKED = new Date("2026-08-01T00:00:00Z");
  const ASKED = ["14", "9"];

  // One row per shape the merge has to get right, plus a core NOT asked about.
  const ENGINE_ROWS: EngineRow[] = [
    { coreId: "14", pmid: "100", status: "confirmed" }, // confirmed, no claim → IN
    { coreId: "14", pmid: "110", status: "confirmed" }, // confirmed + active claimed → IN
    { coreId: "14", pmid: "200", status: "confirmed" }, // confirmed + active rejected → OUT
    { coreId: "14", pmid: "300", status: "candidate" }, // candidate + active claimed → IN
    { coreId: "14", pmid: "500", status: "confirmed" }, // confirmed + REVOKED rejected → IN
    { coreId: "14", pmid: "600", status: "candidate" }, // candidate + REVOKED claimed → OUT
    { coreId: "14", pmid: "700", status: "below_threshold" }, // no claim → OUT
    { coreId: "14", pmid: "800", status: "below_threshold" }, // + active claimed → IN
    { coreId: "9", pmid: "900", status: "confirmed" }, // second core in the same batch
    { coreId: "9", pmid: "910", status: "candidate" },
    { coreId: "3", pmid: "999", status: "confirmed" }, // core not asked about → never appears
  ];
  const CLAIM_ROWS: ClaimRow[] = [
    { coreId: "14", pmid: "110", status: "claimed", revokedAt: null },
    { coreId: "14", pmid: "200", status: "rejected", revokedAt: null },
    { coreId: "14", pmid: "300", status: "claimed", revokedAt: null },
    { coreId: "14", pmid: "400", status: "claimed", revokedAt: null }, // manual add: NO engine row
    { coreId: "14", pmid: "450", status: "claimed", revokedAt: REVOKED }, // revoked manual add
    { coreId: "14", pmid: "500", status: "rejected", revokedAt: REVOKED },
    { coreId: "14", pmid: "600", status: "claimed", revokedAt: REVOKED },
    { coreId: "14", pmid: "800", status: "claimed", revokedAt: null },
    { coreId: "3", pmid: "999", status: "claimed", revokedAt: null },
  ];

  const EXPECTED: Record<string, string[]> = {
    "14": ["100", "110", "300", "400", "500", "800"],
    "9": ["900"],
  };

  /** Records every `where` it is handed, and applies it the way MySQL would. */
  const recordingClient = () => {
    const seen: { publicationCore: unknown[]; coreClaim: unknown[] } = {
      publicationCore: [],
      coreClaim: [],
    };
    const client = {
      publicationCore: {
        findMany: async ({ where }: { where: { coreId: { in: string[] }; status?: string } }) => {
          seen.publicationCore.push(where);
          return ENGINE_ROWS.filter(
            (r) =>
              where.coreId.in.includes(r.coreId) &&
              (where.status === undefined || r.status === where.status),
          );
        },
      },
      coreClaim: {
        findMany: async ({ where }: { where: { coreId: { in: string[] }; revokedAt: null } }) => {
          seen.coreClaim.push(where);
          return CLAIM_ROWS.filter(
            (c) =>
              where.coreId.in.includes(c.coreId) &&
              (where.revokedAt !== null || c.revokedAt === null),
          );
        },
      },
    } as unknown as Parameters<typeof loadConfirmedCorePmidsByCore>[1];
    return { client, seen };
  };

  /** The pre-fix behaviour: the same merge over an UNFILTERED engine read. */
  const legacyLoad = (coreIds: readonly string[]): Map<string, string[]> => {
    const byCore = new Map<string, Set<string>>(coreIds.map((id) => [id, new Set<string>()]));
    const engine = ENGINE_ROWS.filter((r) => coreIds.includes(r.coreId));
    const active = CLAIM_ROWS.filter((c) => coreIds.includes(c.coreId) && c.revokedAt === null);
    const claimByKey = new Map(active.map((c) => [claimKey(c.pmid, c.coreId), c.status]));
    for (const r of engine) {
      if (!isEffectiveConfirmed(r.status, claimByKey.get(claimKey(r.pmid, r.coreId)) ?? null)) continue;
      byCore.get(r.coreId)?.add(r.pmid);
    }
    for (const c of active) if (c.status === "claimed") byCore.get(c.coreId)?.add(c.pmid);
    return new Map([...byCore].map(([id, pmids]) => [id, [...pmids].sort()]));
  };

  const sorted = (m: Map<string, string[]>) =>
    Object.fromEntries([...m].map(([id, pmids]) => [id, [...pmids].sort()]));

  it("returns the SAME set as the unfiltered read, over every merge shape", async () => {
    const { client } = recordingClient();
    const filtered = sorted(await loadConfirmedCorePmidsByCore(ASKED, client));

    expect(filtered).toEqual(sorted(legacyLoad(ASKED)));
    // ...and both equal the hand-written truth, so a shared bug can't pass.
    expect(filtered).toEqual(EXPECTED);
    expect(sorted(legacyLoad(ASKED))).toEqual(EXPECTED);
  });

  it("asks the DB for confirmed rows only — the indexed (coreId, status) shape", async () => {
    const { client, seen } = recordingClient();
    await loadConfirmedCorePmidsByCore(ASKED, client);

    expect(seen.publicationCore).toEqual([{ coreId: { in: ["14", "9"] }, status: "confirmed" }]);
    expect(seen.coreClaim).toEqual([{ coreId: { in: ["14", "9"] }, revokedAt: null }]);
  });

  it("still drops an engine-confirmed row an ACTIVE rejected claim overrides", async () => {
    // The DB filter alone would keep 200; the `isEffectiveConfirmed` pass is
    // what removes it, so this is the assertion that the JS merge stayed.
    const { client } = recordingClient();
    const out = await loadConfirmedCorePmidsByCore(["14"], client);
    expect(out.get("14")).not.toContain("200");
  });

  it("keeps every claimed-override pmid the filtered read never sees", async () => {
    // 300 (candidate), 800 (below_threshold) and 400 (no engine row at all) are
    // all invisible to a `status: "confirmed"` read — the activeClaims pass is
    // the only thing carrying them, and the union depends on it.
    const { client } = recordingClient();
    const out = await loadConfirmedCorePmidsByCore(["14"], client);
    expect([...(out.get("14") ?? [])].sort()).toEqual(EXPECTED["14"]);
    for (const pmid of ["300", "400", "800"]) expect(out.get("14")).toContain(pmid);
  });
});
