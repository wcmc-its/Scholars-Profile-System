/**
 * Sponsor-match searchPeople SPINE engine (`sponsor-match-spine-run.ts`):
 *  - term extraction over the taxonomy-label vocab → per-term MeSH resolution →
 *    cluster dedup → per-cluster `searchPeople` → weighted RRF → top-N map;
 *  - the fusion weight is centrality × dampedIdf(coverage) — the idf actually
 *    reorders (a rare concept up-weights its cluster);
 *  - a KNOWN-ZERO coverage row gets the NEUTRAL idf, never dampedIdf's cap branch
 *    (zero root-tag coverage ≠ maximally rare);
 *  - redundant phrasing collapses into ONE `searchPeople` call;
 *  - the vocab loads with a deterministic order (bake-off run-to-run comparability);
 *  - extracted terms are capped at MAX_TERMS (bounded per-request fan-out);
 *  - paging keys off the reported `result.pageSize`, not a copied constant;
 *  - empty/whitespace/control-char paste short-circuits with no vocab load or search;
 *  - a `searchPeople` failure propagates (no silent partial results).
 * Mocks db + searchPeople + matchQueryToTaxonomy; the pure spine/axes helpers and
 * `normalizeDescription` run for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockMeshDescriptorFindMany,
  mockTechnologyGroupBy,
  mockSearchPeople,
  mockMatchQueryToTaxonomy,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockMeshDescriptorFindMany: vi.fn(),
  mockTechnologyGroupBy: vi.fn(),
  mockSearchPeople: vi.fn(),
  mockMatchQueryToTaxonomy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      topic: { findMany: mockTopicFindMany },
      subtopic: { findMany: mockSubtopicFindMany },
      meshDescriptor: { findMany: mockMeshDescriptorFindMany },
      scholarTechnology: { groupBy: mockTechnologyGroupBy },
    },
  },
}));
vi.mock("@/lib/api/search", () => ({
  searchPeople: mockSearchPeople,
  relevanceScoresForQuery: vi.fn(), // imported by the bespoke engine module we load for real
}));
vi.mock("@/lib/api/search-taxonomy", () => ({
  matchQueryToTaxonomy: mockMatchQueryToTaxonomy,
}));
vi.mock("@/lib/search", () => ({ meshMatchTier: vi.fn(() => "exact") }));

import { rankResearchersForDescriptionSpine } from "@/lib/api/sponsor-match-spine-run";

/** A MeSH resolution stub — spine-run reads descriptorUi/descendantUis/confidence/
 *  curatedTopicAnchors/ambiguous/matchedForm/name. */
function meshRes(descriptorUi: string, descendantUis: string[]) {
  return {
    state: "none" as const,
    meshResolution: {
      descriptorUi,
      name: descriptorUi,
      matchedForm: descriptorUi,
      confidence: "exact" as const,
      scopeNote: null,
      entryTerms: [] as string[],
      curatedTopicAnchors: [] as string[],
      descendantUis,
      ambiguous: false,
    },
  };
}

/** A `searchPeople` hit — only the display fields spine-run reads. */
function hit(cwid: string) {
  return {
    cwid,
    slug: `s-${cwid}`,
    preferredName: `${cwid} Name`,
    primaryTitle: `T-${cwid}`,
    primaryDepartment: `Dept-${cwid}`,
  };
}

/** A `searchPeople` result page. Carries the authoritative `pageSize` the real
 *  `PeopleSearchResult` reports; hits < pageSize so the caller stops after page 0. */
function people(cwids: string[]) {
  return { hits: cwids.map(hit), total: cwids.length, pageSize: 20 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTopicFindMany.mockResolvedValue([]);
  mockSubtopicFindMany.mockResolvedValue([]);
  mockMeshDescriptorFindMany.mockResolvedValue([]);
  mockTechnologyGroupBy.mockResolvedValue([]);
  mockMatchQueryToTaxonomy.mockResolvedValue({ state: "none", meshResolution: null });
  mockSearchPeople.mockResolvedValue(people([]));
});

describe("rankResearchersForDescriptionSpine", () => {
  it("fuses per-cluster searchPeople rankings and applies the dampedIdf weight", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "munchausen syndrome" }]);
    // Disjoint descendant sets ⇒ two separate clusters.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_CANCER", ["D_CANCER"]) : meshRes("D_MUNCH", ["D_MUNCH"]),
    );
    // Cancer is common (coverage 0.5 ⇒ low idf); Munchausen is rare (0.001 ⇒ high idf).
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CANCER", localPubCoverage: 0.5 },
      { descriptorUi: "D_MUNCH", localPubCoverage: 0.001 },
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "cancer" ? people(["x", "y"]) : people(["y", "z"]),
    );
    mockTechnologyGroupBy.mockResolvedValue([{ cwid: "y", _count: { _all: 2 } }]);

    const out = await rankResearchersForDescriptionSpine("cancer and munchausen syndrome work");

    // Weights: cancer -ln(0.5)=0.693, munchausen -ln(0.001)=6.908. Fused:
    //   y = .693/62 + 6.908/61 = .124 (both terms), z = 6.908/62 = .111, x = .693/61 = .011.
    // Order [y,z,x] — z outranks x ONLY because the idf up-weighted the rare cluster;
    // with uniform weights the order would be [y,x,z]. So this proves the weight applied.
    expect(out.map((r) => r.cwid)).toEqual(["y", "z", "x"]);
    expect(out[0].defaultScore).toBeGreaterThan(out[1].defaultScore);
    expect(out[1].defaultScore).toBeGreaterThan(out[2].defaultScore);

    // Display fields ride in from the searchPeople hits; RRF score orders the rows.
    const y = out[0];
    expect(y).toMatchObject({
      cwid: "y",
      slug: "s-y",
      preferredName: "y Name",
      title: "T-y",
      department: "Dept-y",
      careerStage: null,
      technologyCount: 2,
      topPapers: [],
      matchedTopics: [],
    });
    expect(y.axes.topicFit).toBe(y.defaultScore);
    expect(out.find((r) => r.cwid === "x")!.technologyCount).toBe(0);

    // Topical-only retrieval: employment priors OFF, topic shape, v3, concept boost.
    const cancerCall = mockSearchPeople.mock.calls.find((c) => c[0].q === "cancer")![0];
    expect(cancerCall).toMatchObject({
      q: "cancer",
      shape: "topic",
      relevanceMode: "v3",
      facultyProminence: false,
      grantProminence: false,
      meshDescendantUis: ["D_CANCER"],
    });
  });

  it("treats KNOWN-ZERO coverage as neutral idf — never dampedIdf's cap branch", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "rare" }, { label: "zerocov" }]);
    // Disjoint descendant sets ⇒ two separate clusters.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "rare" ? meshRes("D_RARE", ["D_RARE"]) : meshRes("D_ZERO", ["D_ZERO"]),
    );
    // `rare` is genuinely rare (0.001 ⇒ idf 6.908, near the cap). `zerocov` has a
    // KNOWN-ZERO coverage row (the ETL writes COALESCE(n_pubs,0)/total for every
    // descriptor) — zero root-tag coverage is NOT evidence of rarity, so it must get
    // the neutral idf (1), not the cap (10) that would let it dominate the fusion.
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_RARE", localPubCoverage: 0.001 },
      { descriptorUi: "D_ZERO", localPubCoverage: 0 },
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "rare" ? people(["x"]) : people(["z"]),
    );

    const out = await rankResearchersForDescriptionSpine("rare and zerocov studies");

    // Neutral idf: x = 6.908/61 = .113 beats z = 1/61 = .016. Under the cap-branch
    // bug the zero-evidence cluster would weigh 10 and z (10/61 = .164) would win.
    expect(out.map((r) => r.cwid)).toEqual(["x", "z"]);
    expect(out[0].defaultScore).toBeGreaterThan(out[1].defaultScore * 5);
  });

  it("loads the vocab with a deterministic order (label asc)", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    await rankResearchersForDescriptionSpine("cancer research");
    expect(mockTopicFindMany).toHaveBeenCalledWith({
      select: { label: true },
      orderBy: { label: "asc" },
    });
    expect(mockSubtopicFindMany).toHaveBeenCalledWith({
      select: { label: true },
      orderBy: { label: "asc" },
    });
  });

  it("caps extraction at MAX_TERMS (12) — bounded resolution + retrieval fan-out", async () => {
    const labels = Array.from({ length: 15 }, (_, i) => `term${String(i + 1).padStart(2, "0")}`);
    mockTopicFindMany.mockResolvedValue(labels.map((label) => ({ label })));
    // Disjoint singleton descendant sets ⇒ every surviving term is its own cluster.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));

    await rankResearchersForDescriptionSpine(labels.join(" "));

    // 15 vocab labels occur in the paste; only the first 12 resolve and retrieve.
    expect(mockMatchQueryToTaxonomy).toHaveBeenCalledTimes(12);
    expect(mockSearchPeople).toHaveBeenCalledTimes(12);
  });

  it("pages by the reported result.pageSize, not a copied constant", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CANCER", localPubCoverage: 0.5 },
    ]);
    // Three FULL pages of 2 (total 6). A break keyed to a hard-coded 20 would stop
    // after page 0 (2 < 20); keying to the reported pageSize pages to the total.
    const pages = [
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ];
    mockSearchPeople.mockImplementation(async ({ page }: { page: number }) => ({
      hits: pages[page].map(hit),
      total: 6,
      pageSize: 2,
    }));

    const out = await rankResearchersForDescriptionSpine("cancer research");

    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
    expect(mockSearchPeople.mock.calls.map((c) => c[0].page)).toEqual([0, 1, 2]);
    expect(out.map((r) => r.cwid)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("merges redundant phrasing into ONE searchPeople call (union descendant set)", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "oncology" }]);
    // Identical descendant sets ⇒ subsumption/Jaccard=1 ⇒ one merged cluster.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_A", ["D1", "D2"]) : meshRes("D_B", ["D1", "D2"]),
    );
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_A", localPubCoverage: 0.2 },
      { descriptorUi: "D_B", localPubCoverage: 0.2 },
    ]);
    mockSearchPeople.mockResolvedValue(people(["a"]));

    const out = await rankResearchersForDescriptionSpine("cancer oncology");

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople.mock.calls[0][0]).toMatchObject({
      q: "cancer oncology",
      meshDescendantUis: ["D1", "D2"],
    });
    expect(out.map((r) => r.cwid)).toEqual(["a"]);
  });

  it("returns [] for empty/whitespace/control-char input WITHOUT loading vocab or searching", async () => {
    expect(await rankResearchersForDescriptionSpine("")).toEqual([]);
    expect(await rankResearchersForDescriptionSpine("   \n\t  ")).toEqual([]);
    expect(await rankResearchersForDescriptionSpine(String.fromCharCode(0, 7, 27, 127))).toEqual([]);
    expect(mockTopicFindMany).not.toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("returns [] when no vocab term occurs in the paste, without searching", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    const out = await rankResearchersForDescriptionSpine("totally unrelated prose about weather");
    expect(out).toEqual([]);
    expect(mockTopicFindMany).toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("propagates a searchPeople failure (route maps it to 502 — no partial results)", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockRejectedValue(new Error("opensearch down"));
    await expect(rankResearchersForDescriptionSpine("cancer research")).rejects.toThrow(
      "opensearch down",
    );
  });
});
