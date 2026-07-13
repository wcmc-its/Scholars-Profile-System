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
 *  - the fusion weight is centrality^γ × kindPrior — corpus coverage is NOT in it, and a
 *    500x coverage spread must not reorder anything (rarity anti-correlates with topicality;
 *    it was the bug, and #1676's ±15% band was found to earn nothing, so it is gone);
 *  - rare / known-zero / absent coverage all yield the SAME weightFactor (no §8.5 cliff),
 *    while `corpusCoverage` still carries the display signal and still distinguishes
 *    "measured rare" from "unknown" (absent ≠ zero);
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

import { conceptWeight, rerankCandidates } from "@/lib/api/sponsor-match-contract";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockMeshDescriptorFindMany,
  mockTechnologyGroupBy,
  mockScholarFindMany,
  mockSearchPeople,
  mockMatchQueryToTaxonomy,
  mockExtractSponsorConcepts,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockMeshDescriptorFindMany: vi.fn(),
  mockTechnologyGroupBy: vi.fn(),
  mockScholarFindMany: vi.fn(),
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
      // #1654 — the measures hydration read (career stage + clinician).
      scholar: { findMany: mockScholarFindMany },
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
  // Default: no Scholar rows ⇒ candidates carry NO measures, which is the contract's
  // "absent, not zero". Individual tests override to assert the produced values.
  mockScholarFindMany.mockResolvedValue([]);
  mockMatchQueryToTaxonomy.mockResolvedValue({ state: "none", meshResolution: null });
  mockSearchPeople.mockResolvedValue(people([]));
  // Default: LLM extractor yields nothing → the spine falls back to the dictionary
  // extractor, so the pre-existing tests below exercise the v1 path unchanged.
  mockExtractSponsorConcepts.mockResolvedValue([]);
});

describe("rankResearchersForDescriptionSpine", () => {
  it("fuses per-cluster searchPeople rankings — and corpus COVERAGE does not reorder them", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "munchausen syndrome" }]);
    // Disjoint descendant sets ⇒ two separate clusters.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_CANCER", ["D_CANCER"]) : meshRes("D_MUNCH", ["D_MUNCH"]),
    );
    // A 500x coverage spread: cancer is corpus-COMMON (0.5), Munchausen corpus-RARE (0.001).
    // Under the old corpus-IDF weight this was the whole ballgame. It must now change nothing.
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CANCER", localPubCoverage: 0.5 },
      { descriptorUi: "D_MUNCH", localPubCoverage: 0.001 },
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "cancer" ? people(["x", "y"]) : people(["y", "z"]),
    );
    mockTechnologyGroupBy.mockResolvedValue([{ cwid: "y", _count: { _all: 2 } }]);

    const { concepts, candidates: out } = await rankResearchersForDescriptionSpine(
      "cancer and munchausen syndrome work",
    );

    // THE REGRESSION GUARD. Both clusters are the same kind, so both take the same kind prior
    // and `weightFactor` is IDENTICAL despite a 500x coverage difference. Rarity is out of the
    // fusion weight, not merely bounded (it was a ±15% band in #1676; the sweep found the band
    // earned nothing). If someone re-derives weightFactor from coverage, this fails first.
    const cancer = concepts.find((c) => c.term === "cancer")!;
    const munch = concepts.find((c) => c.term === "munchausen syndrome")!;
    expect(cancer.weightFactor).toBe(munch.weightFactor);

    // So RANK decides, not rarity. Equal weights w, K=30:
    //   y = w/32 + w/31 = .0635 (both terms) ; x = w/31 = .0323 ; z = w/32 = .0313
    // Order [y,x,z]. Note x now beats z: x is rank-1 on the COMMON concept and z is rank-2 on
    // the RARE one. Under the old idf z beat x purely for being rare — that inversion is the
    // bug the FINDING is about, and this assertion is what pins it shut.
    expect(out.map((r) => r.cwid)).toEqual(["y", "x", "z"]);
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

  /**
   * THE REGRESSION TEST FOR THE FINDING ITSELF (`docs/2026-07-12-FINDING-...`).
   *
   * Both halves are measured from the live extractor, not invented:
   *
   *  - multiple-sclerosis extracts `multiple sclerosis` alongside `remyelination` and
   *    `neuroprotection` — its own MECHANISMS, which are corpus-RARER than the disease
   *    (MS coverage 1.28e-3; the mechanisms are far rarer). Corpus IDF therefore weighted
   *    the mechanisms ABOVE the disease and a mechanism generalist outranked the disease
   *    specialist. The disease must now win.
   *
   *  - ml-in-medicine extracts `machine learning` as a METHOD at centrality 1.0 — here the
   *    method IS the funder's target. This is §9's objection to a kind prior, and it is why
   *    the prior is paste-RELATIVE rather than a blanket "disease beats method": a rule that
   *    fixed MS by always demoting methods would break this paste. Both must hold at once,
   *    which is the whole reason this is one test with two halves.
   */
  it("FINDING §8: the funder's target outranks its own mechanisms — in BOTH directions", async () => {
    const setup = (concepts: { term: string; kind: "concept" | "method"; centrality: number }[],
                   coverage: Record<string, number>) => {
      mockExtractSponsorConcepts.mockResolvedValue(concepts);
      mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
        meshRes(`D_${q}`, [`D_${q}`]),
      );
      mockMeshDescriptorFindMany.mockResolvedValue(
        Object.entries(coverage).map(([t, c]) => ({ descriptorUi: `D_${t}`, localPubCoverage: c })),
      );
      mockSearchPeople.mockImplementation(async () => people(["p"]));
    };
    const weightOf = (cs: { term: string }[] & unknown[], term: string) =>
      conceptWeight((cs as Parameters<typeof conceptWeight>[0][]).find((c) => c.term === term)!);

    // (a) DISEASE paste. The disease is corpus-COMMON, its mechanisms corpus-RARE — the exact
    //     anti-correlation the FINDING is about.
    setup(
      [
        { term: "multiple sclerosis", kind: "concept", centrality: 1.0 },
        { term: "remyelination", kind: "concept", centrality: 0.4 },
        { term: "neuroprotection", kind: "concept", centrality: 0.4 },
      ],
      { "multiple sclerosis": 1.28e-3, remyelination: 2.0e-5, neuroprotection: 3.0e-5 },
    );
    const ms = (await rankResearchersForDescriptionSpine("ms paste")).concepts;
    expect(weightOf(ms, "multiple sclerosis")).toBeGreaterThan(weightOf(ms, "remyelination"));
    expect(weightOf(ms, "multiple sclerosis")).toBeGreaterThan(weightOf(ms, "neuroprotection"));
    // …and it is not a hair's breadth: the target should DOMINATE its supporting detail.
    expect(weightOf(ms, "multiple sclerosis")).toBeGreaterThan(
      weightOf(ms, "remyelination") + weightOf(ms, "neuroprotection"),
    );

    // (b) METHOD paste (§9). Same rules, opposite target kind — the method must win here, so
    //     the fix cannot be a blanket disease-over-method prior.
    setup(
      [
        { term: "machine learning", kind: "method", centrality: 1.0 },
        { term: "disease progression", kind: "concept", centrality: 0.4 },
      ],
      { "machine learning": 4.0e-3, "disease progression": 8.0e-4 },
    );
    const ml = (await rankResearchersForDescriptionSpine("ml paste")).concepts;
    expect(weightOf(ml, "machine learning")).toBeGreaterThan(weightOf(ml, "disease progression"));
  });

  it("coverage NEVER reaches the fusion weight — rare, zero and absent all weigh the same", async () => {
    mockTopicFindMany.mockResolvedValue([
      { label: "rare" },
      { label: "zerocov" },
      { label: "nocov" },
    ]);
    // Disjoint descendant sets ⇒ three separate clusters.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "rare"
        ? meshRes("D_RARE", ["D_RARE"])
        : q === "zerocov"
          ? meshRes("D_ZERO", ["D_ZERO"])
          : meshRes("D_NONE", ["D_NONE"]),
    );
    // Three states that used to produce three very different weights:
    //   rare    — genuinely rare (0.001), which the old idf drove to ~6.9 of a 10 cap
    //   zerocov — a KNOWN-ZERO coverage row (the ETL writes COALESCE(n_pubs,0)/total)
    //   nocov   — NO row at all (40% of descriptors have no usable coverage)
    // The §8.5 cliff lived exactly here: "no row" took idf 1 while "one tagged paper" took ~10,
    // a 10x jump across a boundary carrying no topical meaning. Rarity is now out of the weight
    // entirely, so all three collapse to the same weightFactor and the cliff cannot exist.
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_RARE", localPubCoverage: 0.001 },
      { descriptorUi: "D_ZERO", localPubCoverage: 0 },
      // D_NONE: deliberately absent.
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "rare" ? people(["x"]) : q === "zerocov" ? people(["z"]) : people(["n"]),
    );

    const { concepts } = await rankResearchersForDescriptionSpine("rare and zerocov and nocov studies");

    const rare = concepts.find((c) => c.term === "rare")!;
    const zerocov = concepts.find((c) => c.term === "zerocov")!;
    const nocov = concepts.find((c) => c.term === "nocov")!;

    // All three the same kind ⇒ all three take the same kind prior ⇒ ONE weightFactor.
    expect(rare.weightFactor).toBe(zerocov.weightFactor);
    expect(zerocov.weightFactor).toBe(nocov.weightFactor);
    expect(rare.weightFactor).toBeCloseTo(1.25, 6); // the aligned kind prior, and nothing else

    // …while `corpusCoverage` still carries the honest DISPLAY signal, and still distinguishes
    // "measured rare" from "we don't know". Absent ≠ zero: a zero root-tag coverage is missing
    // evidence, not rarity, so the UI is never handed a 0 it could render as "vanishingly rare".
    expect(rare.corpusCoverage).toBe(0.001);
    expect(zerocov.corpusCoverage).toBeUndefined();
    expect(nocov.corpusCoverage).toBeUndefined();
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

  // ── Measures producer (#1654) ──────────────────────────────────────────────
  it("hydrates career stage + clinician from Scholar; a cwid with no row carries NO measures", async () => {
    // `searchPeople`'s headless shape has neither signal, so the spine reads them for the
    // fused candidate list. A candidate with no Scholar row must come back with `measures`
    // ABSENT — not `{ isClinician: false }`, which would assert something we never learned.
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockResolvedValue(people(["staffed", "ghost"]));
    mockScholarFindMany.mockResolvedValue([
      {
        cwid: "staffed",
        roleCategory: "full_time_faculty",
        primaryTitle: "Assistant Professor of Medicine",
        hasClinicalProfile: true,
        appointments: [],
        // A 2020 MD ⇒ inside the early-career window.
        educations: [{ year: 2020, degree: "MD" }],
      },
    ]);

    const { candidates } = await rankResearchersForDescriptionSpine("cancer");

    const staffed = candidates.find((c) => c.cwid === "staffed");
    // `roleCategory` rides in on the SAME hydration read — the spine already selected the
    // column to derive the career stage and was dropping it. It is the DB's value, not the
    // People index's: the index coerces a null role to the literal string "unknown", and the
    // person-type facet must not offer a bucket the directory never asserted.
    expect(staffed?.measures).toEqual({
      careerStage: "early",
      isClinician: true,
      roleCategory: "full_time_faculty",
    });

    const ghost = candidates.find((c) => c.cwid === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.measures).toBeUndefined();
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
      // 0.15, not 0.4 — an incidental mention, so this concept's ONE expert genuinely falls
      // below the 100-deep dominant pool and the "no truncation" claim is a REAL cut.
      // At 0.4 it no longer does: K=8 (FINDING §8.3) deliberately promotes being #1 on a
      // secondary concept over being #54-100 on the primary one, which is the head-sharpening
      // the fix is FOR — so the old fixture stopped exercising truncation at all.
      { term: "secondary", kind: "concept", centrality: 0.15 },
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "dominant" ? meshRes("D_DOM", ["D_DOM"]) : meshRes("D_SEC", ["D_SEC"]),
    );
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_DOM", localPubCoverage: 7.5e-4 }, // rare-ish ⇒ band ≈ 1.07
      { descriptorUi: "D_SEC", localPubCoverage: 0.018 }, // common-ish ⇒ band ≈ 0.97
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
      { descriptorUi: "D_CA", localPubCoverage: 0.5 },
      { descriptorUi: "D_CART", localPubCoverage: 0.001 },
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "CAR-T" ? people(["b"]) : people(["a"]),
    );

    const { concepts, candidates } = await rankResearchersForDescriptionSpine("sponsor prose");

    // The paste's top centrality is a `concept` (0.9) so the target kind is "concept":
    // `cancer` takes the aligned 1.25 prior and the off-target `CAR-T` method takes 0.8.
    // `weightFactor` IS the prior now — coverage does not enter it, which is why the
    // corpus-common cancer (0.5) still out-weighs the corpus-rare CAR-T (0.001).
    expect(concepts).toEqual([
      {
        term: "cancer",
        kind: "concept",
        members: ["cancer", "oncology"],
        centrality: 0.9, // max across the merged members, not oncology's 0.4
        weightFactor: expect.closeTo(1.25, 6), // aligned kind prior, full stop
        corpusCoverage: 0.5, // the raw measured fraction, for the badge only
      },
      {
        term: "CAR-T",
        kind: "method",
        members: ["CAR-T"],
        centrality: 0.7,
        weightFactor: expect.closeTo(0.8, 6), // off-target kind prior
        corpusCoverage: 0.001,
      },
    ]);

    // THE INVERSION, FIXED — this fixture is the FINDING in miniature. `CAR-T` is rare
    // (coverage 0.001) and `cancer` is ubiquitous (0.5), so the old corpus-IDF weightFactor
    // handed the OFF-TARGET method 6.908 against the on-target concept's 0.693 — a 10x
    // advantage bought with nothing but corpus rarity, which is how a mechanism generalist
    // came to outrank the disease specialist. The funder's actual target must now win.
    const w = (t: string) => conceptWeight(concepts.find((c) => c.term === t)!);
    expect(w("cancer")).toBeGreaterThan(w("CAR-T"));

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
