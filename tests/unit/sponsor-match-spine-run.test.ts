/**
 * Sponsor-match searchPeople SPINE engine (`sponsor-match-spine-run.ts`):
 *  - returns the UI contract's `{ concepts, candidates }` — the DECOMPOSED score inputs
 *    (each concept's editable centrality AND fixed rarity; each candidate's per-concept
 *    rank), which is what lets the console re-rank live in the browser;
 *  - takes NO concept override: re-ranking is client-side (`rerankCandidates`), so a
 *    slider drag costs zero round-trips. #1673's server-side override — which re-retrieved
 *    and re-fused on every drag — is deliberately gone;
 *  - LLM `extractSponsorConcepts` is the primary term source; its per-term centrality
 *    reaches the fusion weight (a higher-centrality cluster outranks a lower one), and
 *    an empty LLM result falls back to the dictionary `extractTerms` (both empty ⇒ []);
 *  - term source → per-term MeSH resolution → cluster dedup → per-cluster
 *    `searchPeople` → weighted RRF → top-N map;
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
 * Mocks db + searchPeople + matchQueryToTaxonomy + extractSponsorConcepts (never
 * invokes Bedrock); the pure spine/axes helpers and `normalizeDescription` run for
 * real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rerankCandidates } from "@/lib/api/sponsor-match-contract";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockMeshDescriptorFindMany,
  mockTechnologyGroupBy,
  mockSearchPeople,
  mockMatchQueryToTaxonomy,
  mockExtractSponsorConcepts,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockMeshDescriptorFindMany: vi.fn(),
  mockTechnologyGroupBy: vi.fn(),
  mockSearchPeople: vi.fn(),
  mockMatchQueryToTaxonomy: vi.fn(),
  mockExtractSponsorConcepts: vi.fn(),
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
// LLM extractor mocked at the module seam — NEVER invokes Bedrock. The default below
// returns [] so the existing dictionary-path assertions exercise the fallback.
vi.mock("@/lib/api/sponsor-match-extract", () => ({
  extractSponsorConcepts: mockExtractSponsorConcepts,
}));

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
  // Default: LLM extractor yields nothing → the spine falls back to the dictionary
  // extractor, so the pre-existing tests below exercise the v1 path unchanged.
  mockExtractSponsorConcepts.mockResolvedValue([]);
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

    const { candidates: out } = await rankResearchersForDescriptionSpine("cancer and munchausen syndrome work");

    // Weights: cancer -ln(0.5)=0.693, munchausen -ln(0.001)=6.908. Fused:
    //   y = .693/62 + 6.908/61 = .124 (both terms), z = 6.908/62 = .111, x = .693/61 = .011.
    // Order [y,z,x] — z outranks x ONLY because the idf up-weighted the rare cluster;
    // with uniform weights the order would be [y,x,z]. So this proves the weight applied.
    expect(out.map((r) => r.cwid)).toEqual(["y", "z", "x"]);
    expect(out[0].fusedScore).toBeGreaterThan(out[1].fusedScore);
    expect(out[1].fusedScore).toBeGreaterThan(out[2].fusedScore);

    // Display fields ride in from the searchPeople hits; RRF score orders the rows.
    const y = out[0];
    expect(y).toMatchObject({
      cwid: "y",
      profileSlug: "s-y",
      name: "y Name",
      title: "T-y",
      department: "Dept-y",
      technologyCount: 2,
    });
    // The spine has no producer for these — they must be ABSENT, not zeroed. Fabricating a
    // count or a null stage would be a lie the UI cannot distinguish from a real one.
    expect(y.measures).toBeUndefined();
    expect(y.evidence).toBeUndefined();
    // THE HINGE: y appeared under both concepts, at rank 2 in each.
    expect(y.contributions).toEqual([
      { term: "cancer", rank: 2 },
      { term: "munchausen syndrome", rank: 1 },
    ]);
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

    const { concepts, candidates: out } =
      await rankResearchersForDescriptionSpine("rare and zerocov studies");

    // Neutral idf: x = 6.908/61 = .113 beats z = 1/61 = .016. Under the cap-branch
    // bug the zero-evidence cluster would weigh 10 and z (10/61 = .164) would win.
    expect(out.map((r) => r.cwid)).toEqual(["x", "z"]);
    expect(out[0].fusedScore).toBeGreaterThan(out[1].fusedScore * 5);

    // …and the zero-coverage concept ships NO `corpusCoverage` at all. It gets a neutral
    // weightFactor (a ranking decision), but the UI must not be handed a 0 it could render
    // as "vanishingly rare" — a zero root-tag coverage is missing evidence, not rarity, and
    // it is 40% of descriptors. Absent ≠ zero.
    const zerocov = concepts.find((c) => c.term === "zerocov")!;
    expect(zerocov.weightFactor).toBe(1); // NEUTRAL_IDF
    expect(zerocov.corpusCoverage).toBeUndefined();
    expect(concepts.find((c) => c.term === "rare")!.corpusCoverage).toBe(0.001);
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

  it("caps extraction at MAX_TERMS (8) — bounded resolution + retrieval fan-out", async () => {
    const labels = Array.from({ length: 15 }, (_, i) => `term${String(i + 1).padStart(2, "0")}`);
    mockTopicFindMany.mockResolvedValue(labels.map((label) => ({ label })));
    // Disjoint singleton descendant sets ⇒ every surviving term is its own cluster.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));

    await rankResearchersForDescriptionSpine(labels.join(" "));

    // 15 vocab labels occur in the paste; only the first 8 (fan-out breaker) resolve
    // and retrieve — bounding the per-request `searchPeople` burst on broad pastes.
    expect(mockMatchQueryToTaxonomy).toHaveBeenCalledTimes(8);
    expect(mockSearchPeople).toHaveBeenCalledTimes(8);
  });

  it("skips the discarded facet aggregations on every per-cluster searchPeople call", async () => {
    // Fan-out breaker (prime lever): the spine reads only hits/total/pageSize, so it
    // must pass `skipFacetAggs: true` so OpenSearch never runs the nine People-index
    // facet aggs that piled up the per-request heap and tripped the parent breaker.
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "munchausen syndrome" }]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_CANCER", ["D_CANCER"]) : meshRes("D_MUNCH", ["D_MUNCH"]),
    );
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "cancer" ? people(["x"]) : people(["y"]),
    );

    await rankResearchersForDescriptionSpine("cancer and munchausen syndrome work");

    expect(mockSearchPeople.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of mockSearchPeople.mock.calls) {
      expect(args.skipFacetAggs).toBe(true);
    }
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

    const { candidates: out } = await rankResearchersForDescriptionSpine("cancer research");

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

    const { candidates: out } = await rankResearchersForDescriptionSpine("cancer oncology");

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople.mock.calls[0][0]).toMatchObject({
      q: "cancer oncology",
      meshDescendantUis: ["D1", "D2"],
    });
    expect(out.map((r) => r.cwid)).toEqual(["a"]);
  });

  it("returns [] for empty/whitespace/control-char input WITHOUT loading vocab or searching", async () => {
    const empty = { concepts: [], candidates: [] };
    expect(await rankResearchersForDescriptionSpine("")).toEqual(empty);
    expect(await rankResearchersForDescriptionSpine("   \n\t  ")).toEqual(empty);
    expect(await rankResearchersForDescriptionSpine(String.fromCharCode(0, 7, 27, 127))).toEqual(
      empty,
    );
    expect(mockTopicFindMany).not.toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("returns [] when no vocab term occurs in the paste, without searching", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    const { candidates: out } = await rankResearchersForDescriptionSpine("totally unrelated prose about weather");
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

  it("flows differentiated LLM centrality into the fusion weight — higher centrality outranks lower", async () => {
    // Low-centrality concept FIRST, high-centrality SECOND. Disjoint MeSH sets ⇒ two
    // clusters; EQUAL coverage ⇒ identical idf, so ONLY centrality differentiates the
    // weight. Under uniform (v1) centrality the two weights tie and first-seen order
    // wins → [m, p]; the real centralities flip it to [p, m] — proving centrality is a
    // live fusion multiplicand, not an inert 1.0.
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "minor", centrality: 0.3 },
      { term: "primary", centrality: 1.0 },
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "minor" ? meshRes("D_MIN", ["D_MIN"]) : meshRes("D_PRI", ["D_PRI"]),
    );
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_MIN", localPubCoverage: 0.5 },
      { descriptorUi: "D_PRI", localPubCoverage: 0.5 },
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "minor" ? people(["m"]) : people(["p"]),
    );

    const { candidates: out } = await rankResearchersForDescriptionSpine("some sponsor prose");

    expect(mockExtractSponsorConcepts).toHaveBeenCalledWith("some sponsor prose");
    expect(out.map((r) => r.cwid)).toEqual(["p", "m"]);
    expect(out[0].fusedScore).toBeGreaterThan(out[1].fusedScore);
    // Primary path: the LLM terms are resolved directly; the taxonomy-label vocab is
    // never loaded.
    expect(mockMatchQueryToTaxonomy).toHaveBeenCalledWith("primary");
    expect(mockTopicFindMany).not.toHaveBeenCalled();
  });

  it("falls back to the dictionary extractor when the LLM returns [] (Bedrock outage/empty)", async () => {
    mockExtractSponsorConcepts.mockResolvedValue([]); // Bedrock failed / no concepts
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CANCER", localPubCoverage: 0.5 },
    ]);
    mockSearchPeople.mockResolvedValue(people(["a"]));

    const { candidates: out } = await rankResearchersForDescriptionSpine("cancer research program");

    expect(mockExtractSponsorConcepts).toHaveBeenCalledTimes(1);
    // Dictionary fallback engaged: the vocab loaded and its label match drove retrieval.
    expect(mockTopicFindMany).toHaveBeenCalled();
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.cwid)).toEqual(["a"]);
  });

  it("returns [] when BOTH the LLM and the dictionary fallback yield nothing", async () => {
    mockExtractSponsorConcepts.mockResolvedValue([]);
    // Vocab present, but no label occurs in the paste ⇒ dictionary also yields [].
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);

    const { candidates: out } = await rankResearchersForDescriptionSpine("prose with no taxonomy label at all");

    expect(out).toEqual([]);
    expect(mockExtractSponsorConcepts).toHaveBeenCalledTimes(1);
    expect(mockTopicFindMany).toHaveBeenCalled(); // fallback attempted
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  /**
   * The rail's whole purpose is "turn the dominant concept down and see who's left". That is
   * only possible if the response carries the people a re-weighting could promote — which the
   * DEFAULT-weight top-N does not.
   *
   * Dominant concept A outranks secondary concept B by weight, so A's people fill the entire
   * default head of the fused list. B's own best researcher scores below A's deep tail
   * (A@rank-100 = 7.2/160 = .045 > B@rank-1 = 1.6/61 = .026) and would be cut by a top-100
   * truncation. Drag A to zero and B's actual expert has to be there — otherwise the officer
   * isolates B and is shown A's leftovers.
   *
   * So: NO default truncation. The pool is bounded by MAX_TERMS × TERM_DEPTH instead.
   */
  it("ships the FULL fused pool, not a default-weight top-N (a truncated pool is a broken rail)", async () => {
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "dominant", kind: "concept", centrality: 1.0 },
      { term: "secondary", kind: "concept", centrality: 0.4 },
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "dominant" ? meshRes("D_DOM", ["D_DOM"]) : meshRes("D_SEC", ["D_SEC"]),
    );
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_DOM", localPubCoverage: 7.5e-4 }, // idf ≈ 7.2 ⇒ weight ≈ 7.2
      { descriptorUi: "D_SEC", localPubCoverage: 0.018 }, // idf ≈ 4.0 ⇒ weight ≈ 1.6
    ]);
    // "dominant" retrieves a full 100-deep pool; "secondary" retrieves one disjoint person.
    const dominantPool = Array.from({ length: 100 }, (_, i) => `dom${i + 1}`);
    mockSearchPeople.mockImplementation(async ({ q, page }: { q: string; page: number }) => {
      if (q === "secondary") return page === 0 ? people(["sec-expert"]) : people([]);
      return page === 0 ? people(dominantPool) : people([]);
    });

    const { candidates } = await rankResearchersForDescriptionSpine("dominant and secondary");

    // The secondary concept's ONE expert must be in the payload, even though at default
    // weights they rank below all 100 of the dominant concept's people.
    const cwids = candidates.map((c) => c.cwid);
    expect(cwids).toContain("sec-expert");
    expect(cwids.length).toBe(101);
    // …and they are genuinely below the truncation line at default weights, which is what
    // makes this a real cut rather than a lucky pass.
    expect(cwids.indexOf("sec-expert")).toBeGreaterThanOrEqual(100);

    // The payoff: mute the dominant concept and the secondary expert is re-rankable to #1,
    // purely client-side, because they were shipped.
    const muted = rerankCandidates(candidates, [
      { term: "dominant", kind: "concept", members: ["dominant"], centrality: 0, weightFactor: 7.2 },
      { term: "secondary", kind: "concept", members: ["secondary"], centrality: 0.4, weightFactor: 4.0 },
    ]);
    expect(muted[0].cwid).toBe("sec-expert");
  });

  it("returns each concept with BOTH halves of its fusion weight, plus its merged members", async () => {
    // The rail needs `centrality` (editable) and `weightFactor` (fixed) SEPARATELY —
    // shipping only their product would make the sliders unusable, because the client could
    // not recompute the weight after a drag. `members` are the merged-form chips; `kind`
    // splits the Concept/Method panels. `corpusCoverage` is DISPLAY-ONLY (the rarity badge)
    // and is carried separately from `weightFactor` on purpose — see the contract.
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "cancer", kind: "concept", centrality: 0.9 },
      { term: "oncology", kind: "concept", centrality: 0.4 },
      { term: "CAR-T", kind: "method", centrality: 0.7 },
    ]);
    // cancer ≡ oncology (same descriptor set) ⇒ ONE cluster, max centrality 0.9.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "CAR-T" ? meshRes("D_CART", ["D_CART"]) : meshRes("D_CA", ["D_CA"]),
    );
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CA", localPubCoverage: 0.5 }, // -ln(0.5) = 0.693
      { descriptorUi: "D_CART", localPubCoverage: 0.001 }, // -ln(0.001) = 6.908
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "CAR-T" ? people(["b"]) : people(["a"]),
    );

    const { concepts, candidates } = await rankResearchersForDescriptionSpine("sponsor prose");

    expect(concepts).toEqual([
      {
        term: "cancer",
        kind: "concept",
        members: ["cancer", "oncology"],
        centrality: 0.9, // max across the merged members, not oncology's 0.4
        weightFactor: expect.closeTo(0.693, 2), // dampedIdf(0.5) — today's engine choice
        corpusCoverage: 0.5, // the raw measured fraction, for the badge only
      },
      {
        term: "CAR-T",
        kind: "method",
        members: ["CAR-T"],
        centrality: 0.7,
        weightFactor: expect.closeTo(6.908, 2), // dampedIdf(0.001)
        corpusCoverage: 0.001,
      },
    ]);
    // Contributions key on the cluster's REPRESENTATIVE term, so they join to
    // `concepts[].term`. "oncology" merged away and must never appear as a key — a
    // contribution the rail cannot resolve to a slider is a dead re-rank input.
    expect(candidates.map((c) => c.cwid).sort()).toEqual(["a", "b"]);
    expect(candidates.flatMap((c) => c.contributions.map((x) => x.term)).sort()).toEqual([
      "CAR-T",
      "cancer",
    ]);
  });
});
