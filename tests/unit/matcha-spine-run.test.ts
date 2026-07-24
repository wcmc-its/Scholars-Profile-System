/**
 * Sponsor-match searchPeople SPINE engine (`sponsor-match-spine-run.ts`):
 *  - returns the UI contract's `{ concepts, candidates }` — the DECOMPOSED score inputs
 *    (each concept's editable centrality AND fixed rarity; each candidate's per-concept
 *    rank), which is what lets the console re-rank live in the browser;
 *  - takes NO concept override: re-ranking is client-side (`rerankCandidates`), so a
 *    slider drag costs zero round-trips. #1673's server-side override — which re-retrieved
 *    and re-fused on every drag — is deliberately gone;
 *  - LLM `extractMatchaConcepts` is the primary term source; its per-term centrality
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
 *  - each cluster's pool is retrieved in ONE size-TERM_DEPTH request (recall-neutral rescore);
 *  - empty/whitespace/control-char paste short-circuits with no vocab load or search;
 *  - a `searchPeople` failure propagates (no silent partial results).
 * Mocks db + searchPeople + matchQueryToTaxonomy + extractMatchaConcepts (never
 * invokes Bedrock); the pure spine/axes helpers and `normalizeDescription` run for
 * real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conceptWeight,
  matchedConcepts,
  MAX_EVIDENCE_CONCEPTS,
  rerankCandidates,
} from "@/lib/api/matcha-contract";

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
// The real extractor returns { concepts, titleSummary }. The existing tests resolve this mock
// with a bare concepts ARRAY, so wrap that shape here — a test that cares about the title can
// resolve the full { concepts, titleSummary } object instead. The spy still records the paste.
vi.mock("@/lib/api/matcha-extract", () => ({
  extractMatchaConcepts: (paste: string) =>
    Promise.resolve(mockExtractSponsorConcepts(paste)).then((r) =>
      Array.isArray(r) ? { concepts: r } : r,
    ),
}));

import {
  distinctiveGlossTerms,
  trimGlossFragment,
  rankResearchersForDescriptionSpine,
} from "@/lib/api/matcha-spine-run";

// MATCHA_GLOSS_INWORDS — the honesty core of the "in their words" line. `distinctiveGlossTerms`
// decides which words of the gloss are eligible to be highlighted in a scholar's OWN titles; if it
// ever let a shared canonical token through, the line could assert the sponsor's sense on a scholar
// who only used the concept's own word — the fabricated-relevance trap the whole evidence path
// exists to avoid.
describe("distinctiveGlossTerms (in-their-words highlight eligibility)", () => {
  it("drops the canonical member tokens so a SHARED word can never be the highlight query", () => {
    // The doc's case: term "cognitive dysfunction", gloss "cognitive decline with genetic and
    // vascular contributions". "cognitive" is shared and MUST NOT survive (else a "cognitive
    // behavioral therapy" title would falsely earn the "decline" line); "dysfunction" is a member
    // token; stopwords "with"/"and" go. Only the sponsor's DIVERGENT sense words remain.
    const terms = distinctiveGlossTerms(
      "cognitive decline with genetic and vascular contributions",
      ["cognitive dysfunction"],
    );
    const set = terms.split(" ");
    expect(set).not.toContain("cognitive");
    expect(set).not.toContain("dysfunction");
    expect(set).not.toContain("with");
    expect(set).not.toContain("and");
    expect(set).toEqual(["decline", "genetic", "vascular", "contributions"]);
  });

  it("subtracts tokens from EVERY merged member, not just the first", () => {
    // A cluster that merged "cognitive dysfunction" + "cognitive decline" leaves neither word
    // eligible — both are now the concept's own vocabulary.
    const terms = distinctiveGlossTerms("cognitive decline and vascular disease", [
      "cognitive dysfunction",
      "cognitive decline",
    ]);
    expect(terms.split(" ")).not.toContain("decline");
    expect(terms).toContain("vascular");
  });

  it("STEM-collides morphological variants — a plural gloss token can't smuggle the canonical word past subtraction", () => {
    // The defect an adversarial verifier found: publicationTitles is stemmed (english_stemmer) at
    // query time, so highlighting "dysfunctions" marks "dysfunction" (the canonical word) on any
    // title — including one with nothing to do with the sponsor's sense. Exact subtraction let the
    // plural through; stem-aware subtraction must drop it.
    const terms = distinctiveGlossTerms("cognitive dysfunctions and behavioral decline", [
      "cognitive dysfunction",
    ]).split(" ");
    expect(terms).not.toContain("dysfunctions"); // would stem to the canonical "dysfunction"
    expect(terms).toContain("decline");
    expect(terms).toContain("behavioral");
  });

  it("STEM-collides derivational variants (cognition ~ cognitive) but keeps genuinely distinct words", () => {
    const terms = distinctiveGlossTerms("cognition, gliosis, and vascular decline", [
      "cognitive dysfunction",
    ]).split(" ");
    expect(terms).not.toContain("cognition"); // shares the "cognit" stem with canonical "cognitive"
    expect(terms).toContain("gliosis");
    expect(terms).toContain("vascular");
  });

  it("does NOT over-collide on a short canonical acronym — a long distinct term that merely starts the same survives", () => {
    // canonical "MI" (2 chars) stems to "mi"; "mitochondrial" stems to "mitochondri" — distinct.
    expect(distinctiveGlossTerms("mitochondrial dysfunction of the myocardium", ["MI"])).toContain(
      "mitochondrial",
    );
  });

  it("STEM-collides y→ies plurals, short -s plurals, and 5-char-stem derivations — the families a shared-prefix heuristic missed", () => {
    // Second adversarial review: "arteries"/"artery" (Porter → "arteri"), "eyes"/"eye" (→ "ey"), and
    // "genomic"/"genome" (→ "genom") all stem-collide with the canonical word, but a shared-prefix
    // test kept them — marking the concept's OWN word on unrelated titles ("Renal artery …",
    // "Eye movement …", a genome-maintenance title).
    const arteries = distinctiveGlossTerms(
      "progressive narrowing of the coronary arteries by atherosclerotic plaque",
      ["coronary artery disease"],
    ).split(" ");
    expect(arteries).not.toContain("arteries");
    expect(arteries).toContain("atherosclerotic");

    expect(
      distinctiveGlossTerms("chronic disease of the eyes and tear film", ["dry eye disease"]).split(" "),
    ).not.toContain("eyes");

    expect(
      distinctiveGlossTerms("genomic instability and repair", ["genome maintenance"]).split(" "),
    ).not.toContain("genomic");
  });

  it("returns '' when the gloss adds nothing beyond the concept label (no highlight requested)", () => {
    expect(distinctiveGlossTerms("cognitive dysfunction", ["cognitive dysfunction"])).toBe("");
    expect(distinctiveGlossTerms("with the and of", ["x"])).toBe(""); // pure stopwords
  });

  it("strips GENERIC biomedical framing so it can't mark common words in unrelated titles (§1 eval)", () => {
    // The §1 acceptance eval showed 47% of highlighted tokens were generic vocabulary ("disease",
    // "cell", "treatment"…) matching unrelated titles. Those are stripped; the sponsor's distinctive
    // sense words survive.
    const terms = distinctiveGlossTerms(
      "cellular models of amyloid disease treatment response and patient outcomes",
      ["gene therapy"],
    ).split(" ");
    expect(terms).toContain("amyloid"); // the distinctive sense word survives (non-vacuous)
    for (const generic of ["cellular", "models", "disease", "treatment", "response", "patient", "outcomes"]) {
      expect(terms).not.toContain(generic);
    }
    // A gloss of nothing but generic framing earns no highlight at all — no line beats a noisy one.
    expect(distinctiveGlossTerms("novel therapeutic approaches for disease treatment", ["x"])).toBe("");
  });

  it("strips the v2 residual framing tail the first cut missed (risk, imaging, loss, molecular…)", () => {
    // §1 re-eval: these still marked common words in unrelated titles (biomarkers→"risk" in a
    // surgery paper, neuroinflammation→"loss" in an astronaut paper). Comprehensive strip.
    const terms = distinctiveGlossTerms(
      "molecular imaging of tissue at risk with loss of function and altered expression",
      ["x"],
    ).split(" ");
    for (const generic of ["molecular", "imaging", "tissue", "risk", "loss", "altered", "expression"]) {
      expect(terms).not.toContain(generic);
    }
  });

  it("KEEPS domain / sense terms — the generic stoplist must not eat the sponsor's actual meaning", () => {
    // "vascular"/"genetic" are the parent-doc's canonical distinctive words; "amyloid"/"metabolic"
    // are domain sense. None are generic framing, so all must survive.
    const terms = distinctiveGlossTerms(
      "amyloid and metabolic dysfunction with genetic and vascular contributions",
      ["cognitive dysfunction"],
    ).split(" ");
    for (const sense of ["amyloid", "metabolic", "genetic", "vascular"]) {
      expect(terms).toContain(sense);
    }
  });

  it("dedups and is case-insensitive", () => {
    expect(distinctiveGlossTerms("Decline, DECLINE and decline", ["cognitive dysfunction"])).toBe(
      "decline",
    );
  });
});

describe("trimGlossFragment (in-their-words fragment tidy)", () => {
  it("collapses the weight-repeated title to one clean marked sentence", () => {
    // publicationTitles repeats each title by authorship weight, so the raw window straddles copies.
    const raw =
      "<mark>Amyloid</mark> plaques in aged mice. <mark>Amyloid</mark> plaques in aged mice. <mark>Amyloid</mark> plaques in aged mice.";
    expect(trimGlossFragment(raw)).toBe("<mark>Amyloid</mark> plaques in aged mice.");
  });

  it("keeps only the FIRST title carrying the mark when the window spans two titles", () => {
    // A window can span a marked title and an adjacent unrelated one; show only the marked one.
    const raw = "Renal function in dialysis. <mark>Vascular</mark> decline in aging?";
    expect(trimGlossFragment(raw)).toBe("<mark>Vascular</mark> decline in aging?");
  });

  it("returns the fragment unchanged when it is already a single marked sentence", () => {
    expect(trimGlossFragment("<mark>Tau</mark> pathology in the cortex.")).toBe(
      "<mark>Tau</mark> pathology in the cortex.",
    );
  });
});

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

/** The display fields every `searchPeople` hit carries, whatever the evidence flags say. */
function displayFields(cwid: string) {
  return {
    cwid,
    slug: `s-${cwid}`,
    preferredName: `${cwid} Name`,
    primaryTitle: `T-${cwid}`,
    primaryDepartment: `Dept-${cwid}`,
  };
}

/** Every hit carries the scholar's total pub count — the `M` in "N of M publications". */
const PUB_COUNT = 40;

/**
 * THE DEFAULT HIT — what `searchPeople({ matchExplain: true })` ACTUALLY EMITS, which is what
 * the spine actually reads, and which is NOT what this helper used to return.
 *
 * It used to be display fields and nothing else: no `pubCount`, no `evidence`, no
 * `evidenceLines`. THE REAL EMITTER CANNOT PRODUCE THAT SHAPE with the deployed flags on, and a
 * suite built on it was blind by construction — 7172 tests passed while the spine shipped
 * fabricated evidence to prod.
 *
 * `searchPeople` with SEARCH_RESULT_EVIDENCE + SEARCH_EVIDENCE_REASON_COUNTS (both ON in staging
 * and prod) returns `{ evidenceLines: selectEvidenceLines(evInput) }`, and `selectEvidenceLines`
 * ENDS with `if (lines.length === 0) lines.push(selectEvidence(input))`, whose own last line is
 * `return { kind: "none" }`. So `evidenceLines` is NEVER empty and never absent — a hit that
 * matched nothing still comes back carrying the IDENTITY TAIL. `areas` is the realistic default
 * (most scholars have `areasOfInterest`), so that is what this returns: a hit that ranked under
 * the concept but has NOTHING to say about WHY.
 *
 * Tests that need a hit whose concept genuinely matched use `hitWithEvidenceLines`; the
 * genuinely-evidence-less flag-off shape is `hitNoEvidence`.
 */
function hit(cwid: string) {
  return {
    ...displayFields(cwid),
    pubCount: PUB_COUNT,
    evidenceLines: [{ kind: "areas" as const, labels: [`Area of ${cwid}`], total: 1 }],
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
      // The headshot, DERIVED SERVER-SIDE from the cwid. It is asserted here (and on the
      // bespoke engine in `sponsor-match.test.ts`) because the field is OPTIONAL on the
      // contract, so nothing but a test stops a producer quietly dropping it — and a card
      // that silently falls back to initials looks exactly like a scholar with no photo.
      // `identityImageEndpoint` reads `process.env.SCHOLARS_HEADSHOT_BASE`, which does not
      // exist in the browser, which is why it cannot be derived in the client panel.
      identityImageEndpoint: "https://directory.weill.cornell.edu/api/v1/person/profile/y.png?returnGenericOn404=false",
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

  it("NEVER searches the funder's gloss — it is display-only, and searching it was measured worse", async () => {
    // The gloss ("lysosomal processing of ADC linkers") rides the wire so the rail can show the
    // sponsor's words, but it must NOT enter the BM25 query. Searching it was tried behind
    // MATCHA_GLOSS_QUERY and REJECTED on measurement: a long prose gloss narrows retrieval, and
    // the best gloss variant lost 15 judged-relevant scholars to gain 1 (see the spine's own
    // comment and docs/2026-07-19-matcha-gloss-query-concept-vs-keyword-handoff.md).
    //
    // This is the regression guard for that decision: the query is the bare member tokens, and
    // neither the gloss alone nor token+gloss may reappear as a query.
    mockExtractSponsorConcepts.mockResolvedValue([
      {
        term: "lysosomes",
        kind: "concept",
        centrality: 1.0,
        gloss: "lysosomal processing of ADC linkers",
      },
      { term: "HER2-low breast cancer", kind: "concept", centrality: 0.8 }, // no gloss
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
    mockSearchPeople.mockImplementation(async () => people(["p"]));

    const { concepts } = await rankResearchersForDescriptionSpine("adc paste");

    const queries = mockSearchPeople.mock.calls.map((c) => c[0].q);
    // The bare token IS the query, and the MeSH axis still resolves off the term.
    const bare = mockSearchPeople.mock.calls.find((c) => c[0].q === "lysosomes")![0];
    expect(bare.meshDescendantUis).toEqual(["D_lysosomes"]);
    expect(queries).toContain("HER2-low breast cancer");
    // Neither rejected composition may come back.
    expect(queries).not.toContain("lysosomal processing of ADC linkers");
    expect(queries).not.toContain("lysosomes lysosomal processing of ADC linkers");
    expect(queries.some((q: string) => q.includes("processing of ADC"))).toBe(false);
    // ...but the gloss still reaches the UI.
    expect(concepts.find((c) => c.term === "lysosomes")!.gloss).toBe(
      "lysosomal processing of ADC linkers",
    );
  });

  it("with MATCHA_RECENCY=on, projects the year and re-ranks by recency (the flag→candidate hop)", async () => {
    // The one hop that turns the flag into a candidate field, tested end to end: flag → searchPeople
    // opt → hit year → recencyWeightByCwid → rrfFuse reorder → candidate.mostRecentYear.
    process.env.MATCHA_RECENCY = "on";
    try {
      const thisYear = new Date().getUTCFullYear();
      mockExtractSponsorConcepts.mockResolvedValue([{ term: "adc", kind: "concept", centrality: 1.0 }]);
      mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
      // "old" ranks #1 (higher topical base), "recent" #2 — but "recent" is current-year and "old"
      // is 30y stale, so recency (≈1 vs ≈FLOOR) flips the order. Years are relative to the real
      // clock the spine reads, so the flip holds regardless of the calendar year the test runs in.
      mockSearchPeople.mockImplementation(async () => ({
        hits: [
          { ...hit("old"), mostRecentYear: thisYear - 30 },
          { ...hit("recent"), mostRecentYear: thisYear },
        ],
        total: 2,
        pageSize: 20,
      }));

      const { candidates } = await rankResearchersForDescriptionSpine("adc paste");

      // (a) every candidate-producing searchPeople call asked for the year.
      expect(mockSearchPeople.mock.calls.every((c) => c[0].includeMostRecentPub === true)).toBe(true);
      // (b) the year rides onto the candidate on the spine path (D8's "latest YYYY").
      expect(candidates.find((c) => c.cwid === "recent")!.mostRecentYear).toBe(thisYear);
      // (c) recency actually reordered: the recent scholar (worse topical rank) now leads.
      expect(candidates.map((c) => c.cwid)).toEqual(["recent", "old"]);
    } finally {
      delete process.env.MATCHA_RECENCY;
    }
  });

  it("with MATCHA_RECENCY off (default), does not request or attach the year (byte-identical)", async () => {
    delete process.env.MATCHA_RECENCY;
    mockExtractSponsorConcepts.mockResolvedValue([{ term: "adc", kind: "concept", centrality: 1.0 }]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
    // Even though the (mocked) hits carry a year, the spine must ignore it when the flag is off.
    mockSearchPeople.mockImplementation(async () => ({
      hits: [
        { ...hit("old"), mostRecentYear: 1999 },
        { ...hit("recent"), mostRecentYear: 2024 },
      ],
      total: 2,
      pageSize: 20,
    }));

    const { candidates } = await rankResearchersForDescriptionSpine("adc paste");

    expect(mockSearchPeople.mock.calls.every((c) => c[0].includeMostRecentPub !== true)).toBe(true);
    expect(candidates.every((c) => c.mostRecentYear === undefined)).toBe(true);
    // No recency ⇒ the topical base order stands: "old" (#1) before "recent" (#2).
    expect(candidates.map((c) => c.cwid)).toEqual(["old", "recent"]);
  });

  it("projects the ETL surname key onto every candidate, unflagged, and nulls it when unknown", async () => {
    // Matcha's A–Z sort, tested on the hop that actually carries it: searchPeople opt → hit →
    // candidate.lastNameSort. RECENCY stays OFF deliberately — the sort must not inherit that flag.
    delete process.env.MATCHA_RECENCY;
    mockExtractSponsorConcepts.mockResolvedValue([{ term: "adc", kind: "concept", centrality: 1.0 }]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
    // "keyed" carries the ETL key; "unkeyed" is a not-yet-reindexed doc that lacks the field.
    mockSearchPeople.mockImplementation(async () => ({
      hits: [{ ...hit("keyed"), lastNameSort: "zzyzx" }, hit("unkeyed")],
      total: 2,
      pageSize: 20,
    }));

    const { candidates } = await rankResearchersForDescriptionSpine("adc paste");

    // (a) every candidate-producing call asked for the key, with no flag set.
    expect(mockSearchPeople.mock.calls.every((c) => c[0].includeLastName === true)).toBe(true);
    // (b) the key rides onto the candidate.
    expect(candidates.find((c) => c.cwid === "keyed")!.lastNameSort).toBe("zzyzx");
    // (c) absent ⇒ null, NOT undefined and NOT a guess derived from the display name.
    expect(candidates.find((c) => c.cwid === "unkeyed")!.lastNameSort).toBeNull();
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

  it("#1838 clusters BEFORE capping so the default slots are distinct axes, not subsumed duplicates", async () => {
    // A co-extracted parent that SUBSUMES four children (all under it in the tree), plus five
    // distinct axes at lower centrality. The OLD order (cap 8 concepts by centrality, THEN cluster)
    // spends five of its eight slots on the CVD family — which collapses to ONE cluster — and drops
    // the two lowest-centrality distinct axes below the cut. Clustering FIRST collapses the family
    // before it consumes a slot, so every distinct axis survives the cap on clusters.
    const parent = { term: "cardiovascular diseases", kind: "concept" as const, centrality: 1.0 };
    const children = [
      { term: "atherosclerosis", kind: "concept" as const, centrality: 0.95 },
      { term: "heart failure", kind: "concept" as const, centrality: 0.9 },
      { term: "hypertension", kind: "concept" as const, centrality: 0.85 },
      { term: "congenital heart disease", kind: "concept" as const, centrality: 0.8 },
    ];
    const distinct = [
      { term: "vascular biology", kind: "concept" as const, centrality: 0.7 },
      { term: "inflammation", kind: "concept" as const, centrality: 0.65 },
      { term: "health equity", kind: "concept" as const, centrality: 0.6 },
      { term: "genomics", kind: "concept" as const, centrality: 0.55 },
      { term: "imaging", kind: "concept" as const, centrality: 0.5 },
    ];
    mockExtractSponsorConcepts.mockResolvedValue([parent, ...children, ...distinct]);

    // The parent's descendant set CONTAINS each child's ⇒ subsumption merges all five into one
    // cluster (union-find connects the children through the parent). Each distinct axis resolves to
    // its own disjoint singleton set ⇒ its own cluster.
    const childUi = new Map([
      ["atherosclerosis", "ATH"],
      ["heart failure", "HF"],
      ["hypertension", "HTN"],
      ["congenital heart disease", "CHD"],
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => {
      if (q === "cardiovascular diseases") return meshRes("CVD", ["CVD", "ATH", "HF", "HTN", "CHD"]);
      const ui = childUi.get(q);
      if (ui) return meshRes(ui, [ui]);
      return meshRes(`D_${q}`, [`D_${q}`]);
    });
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) => people([`p-${q}`]));

    await rankResearchersForDescriptionSpine("cardiovascular research");

    // Resolution runs over the FULL extraction (10 concepts), not a pre-cap top-8 — that reorder IS
    // the fix. The old order resolved only the 8 survivors of the concept cap.
    expect(mockMatchQueryToTaxonomy).toHaveBeenCalledTimes(10);

    // SIX distinct clusters searched: the CVD family as ONE, plus all five distinct axes. Fan-out is
    // still ≤ MAX_TERMS (8), unchanged. Under the old order the family ate five slots and the two
    // lowest-centrality axes were dropped, leaving only four searches.
    const searchedQueries = mockSearchPeople.mock.calls.map((c) => c[0].q);
    expect(mockSearchPeople).toHaveBeenCalledTimes(6);
    // The family is ONE query joining its merged members, the parent leading as representative.
    expect(searchedQueries).toContain(
      "cardiovascular diseases atherosclerosis heart failure hypertension congenital heart disease",
    );
    // The axes the old cap-before-cluster order dropped below the 8-slot cut now all survive.
    for (const axis of ["vascular biology", "inflammation", "health equity", "genomics", "imaging"]) {
      expect(searchedQueries).toContain(axis);
    }
  });

  it("#1838 resolves an officer-included term absent from the fresh extraction, keeping its MeSH boost", async () => {
    // The include-chip flow: an officer clicks a culled term that THIS run's temp-0 re-extraction did
    // not surface, so it is not a cluster representative and applyIncludes SYNTHS it. Pre-#1838 the
    // synth term was resolved to MeSH (resolution ran after includes); moving resolution ahead of the
    // cap dropped that, degrading the officer's concept to a bare keyword axis with no attribution
    // boost and no evidence. The fix resolves the non-reappearing include before synthing it.
    mockExtractSponsorConcepts.mockResolvedValue([{ term: "cancer", kind: "concept", centrality: 1.0 }]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "neuroprotection" ? meshRes("D_NP", ["D_NP1", "D_NP2"]) : meshRes("D_CA", ["D_CA"]),
    );
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) => people([`p-${q}`]));

    const { concepts } = await rankResearchersForDescriptionSpine("cancer prose", {
      include: ["neuroprotection"],
    });

    // The include got its own taxonomy round-trip and is searched WITH its MeSH descendant set as an
    // attribution boost — NOT a bare BM25 token. A pre-fix synth (descendantUis:[]) sends undefined.
    expect(mockMatchQueryToTaxonomy).toHaveBeenCalledWith("neuroprotection");
    const npCall = mockSearchPeople.mock.calls.find((c) => c[0].q === "neuroprotection");
    expect(npCall).toBeDefined();
    expect(npCall![0].meshDescendantUis).toEqual(["D_NP1", "D_NP2"]);
    // …and it is additive: the base concept survives alongside the officer's addition.
    expect(concepts.map((c) => c.term).sort()).toEqual(["cancer", "neuroprotection"]);
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

  // ── Grant Matcha ESI hydration (§3) ────────────────────────────────────────
  it("hydrates measures.esiEligible ONLY when eligibilitySignals is set — /edit/matcha byte-unchanged", async () => {
    const thisYear = new Date().getFullYear();
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockResolvedValue(people(["early", "senior"]));
    // Two Scholar reads fire on the grant-matcha path: the measures read (no `grants` in the
    // select) and the gated grants read. Distinguish them by whether the select asks for `grants`.
    const measureRows = [
      {
        cwid: "early",
        roleCategory: "full_time_faculty",
        primaryTitle: "Assistant Professor",
        hasClinicalProfile: false,
        appointments: [],
        educations: [{ year: thisYear - 2, degree: "PhD" }],
      },
      {
        cwid: "senior",
        roleCategory: "full_time_faculty",
        primaryTitle: "Professor",
        hasClinicalProfile: false,
        appointments: [],
        educations: [{ year: thisYear - 30, degree: "PhD" }],
      },
    ];
    const grantRows = [
      // early: recent PhD, no major PI award ⇒ inside the ESI window.
      { cwid: "early", grants: [], educations: [{ year: thisYear - 2, degree: "PhD" }] },
      // senior: PhD 30y ago ⇒ past the window.
      { cwid: "senior", grants: [], educations: [{ year: thisYear - 30, degree: "PhD" }] },
    ];
    mockScholarFindMany.mockImplementation(async (args: { select?: { grants?: unknown } }) =>
      args.select?.grants ? grantRows : measureRows,
    );

    // WITH signals → esiEligible present and correct; the gated grants read fired.
    const withSig = await rankResearchersForDescriptionSpine("cancer", {
      eligibilitySignals: true,
    });
    expect(withSig.candidates.find((c) => c.cwid === "early")?.measures?.esiEligible).toBe(true);
    expect(withSig.candidates.find((c) => c.cwid === "senior")?.measures?.esiEligible).toBe(false);
    expect(
      mockScholarFindMany.mock.calls.some(
        (c) => (c[0] as { select?: { grants?: unknown } }).select?.grants,
      ),
    ).toBe(true);

    // WITHOUT signals → esiEligible ABSENT, the rest of measures unchanged, and NO grants read at
    // all: the plain `/edit/matcha` path never touches the new query.
    mockScholarFindMany.mockClear();
    const noSig = await rankResearchersForDescriptionSpine("cancer");
    const early = noSig.candidates.find((c) => c.cwid === "early");
    expect(early?.measures?.esiEligible).toBeUndefined();
    expect(early?.measures).toMatchObject({ careerStage: "early", roleCategory: "full_time_faculty" });
    expect(
      mockScholarFindMany.mock.calls.every(
        (c) => !(c[0] as { select?: { grants?: unknown } }).select?.grants,
      ),
    ).toBe(true);
  });

  it("retrieves each cluster's pool in ONE size-TERM_DEPTH request, in rank order (no paging)", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CANCER", localPubCoverage: 0.5 },
    ]);
    // Recall-neutrality fix: the pool now arrives in ONE size-TERM_DEPTH request (was up to 5 paged
    // calls, each rescored independently — the 5 top-100 windows never stitched, so candidate counts
    // drifted with λ). One request, all hits taken in rank order, no second round-trip; a paged
    // rescore can't reappear.
    mockSearchPeople.mockImplementation(async () => ({
      hits: ["a", "b", "c", "d", "e", "f"].map(hit),
      total: 6,
      pageSize: 100,
    }));

    const { candidates: out } = await rankResearchersForDescriptionSpine("cancer research");

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople.mock.calls[0][0].page).toBe(0);
    expect(mockSearchPeople.mock.calls[0][0].pageSize).toBe(100); // TERM_DEPTH
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

// ── Evidence (#1689) ────────────────────────────────────────────────────────
/**
 * A hit in the shape `searchPeople` ACTUALLY emits in staging and prod: the TIERED
 * `evidenceLines[]`, not the singular `evidence`.
 *
 * Which field is emitted is a FLAG DECISION (`SEARCH_EVIDENCE_REASON_COUNTS`), and it is ON in
 * both deployed environments — so `evidence` is never populated there. The first cut of #1689
 * read only `evidence`, passed every test, and returned 0 evidence for 160 real hits on
 * staging. This factory exists so the suite tests the shape production actually sends.
 */
function hitWithEvidenceLines(cwid: string, term: string, count: number, pubCount: number) {
  return {
    ...displayFields(cwid),
    pubCount,
    evidenceLines: [taggedEvidence(term, count, pubCount)],
  };
}

/** The first-class `publications:tagged` reason — a real claim about the QUERY's concept, and
 *  the thing an officer is entitled to read as "this is why they matched". */
function taggedEvidence(term: string, count: number, pubCount: number) {
  return {
    kind: "publications" as const,
    strength: "tagged" as const,
    text: `${count} of ${pubCount} publications tagged`,
    term,
    count,
  };
}

/** The LEGACY single-object shape (emitted only with the reason-counts flag off). Built from
 *  `displayFields`, NOT from `hit()`: a hit carrying BOTH `evidenceLines` and `evidence` is a
 *  shape no flag combination produces, and the spine prefers `evidenceLines`, so inheriting the
 *  default hit's identity tail here would silently test the wrong branch. */
function hitWithEvidence(cwid: string, term: string, count: number, pubCount: number) {
  return {
    ...displayFields(cwid),
    pubCount,
    evidence: taggedEvidence(term, count, pubCount),
  };
}

/** A hit carrying an explicit identity-tail line — the `kind` is the parameter, because the
 *  ladder's tail has three termini and all three must be dropped. `areas` is `hit()`'s default
 *  (the realistic one); `none` and `concepts` fire for a scholar with no self-reported areas. */
/**
 * A hit whose ONLY evidence is a non-research kind — everything `isResearchMatchEvidence` denies.
 *
 * `affiliation` and `name` are the subtle two, and they are why the first fix of #1696 was still
 * wrong. Both ARE query-derived — the `<mark>` is the query's own — so a predicate that asked
 * "did the query produce this?" let them through. Neither says the person's WORK matches:
 * `affiliation` is the org segment of `preferredName` (the group they sit in — the emitter itself
 * ranks it "9, weak/organizational, just above empty", i.e. it fires precisely when nothing about
 * their research matched), and `name` is their surname.
 */
function hitWithTailEvidence(
  cwid: string,
  tail: "areas" | "concepts" | "none" | "affiliation" | "name",
) {
  const line =
    tail === "areas"
      ? { kind: "areas" as const, labels: [`Area of ${cwid}`], total: 1 }
      : tail === "concepts"
        ? { kind: "concepts" as const, items: [{ label: "Neoplasms", ui: "D009369" }], total: 1 }
        : tail === "affiliation"
          ? // the org segment carries the query's mark — a GROUP name, not this person's work
            { kind: "affiliation" as const, html: `Ann Doe - Institute for <mark>Cancer</mark> Care` }
          : tail === "name"
            ? { kind: "name" as const, html: `Ann <mark>Cancer</mark>ella` }
            : { kind: "none" as const };
  return { ...displayFields(cwid), pubCount: PUB_COUNT, evidenceLines: [line] };
}

/** The GENUINELY evidence-less hit — neither field. Only `SEARCH_RESULT_EVIDENCE` OFF produces
 *  this, which no deployed environment does; the spine's `!hitEvidence` guard is for it alone. */
function hitNoEvidence(cwid: string) {
  return { ...displayFields(cwid), pubCount: PUB_COUNT };
}

describe("rankResearchersForDescriptionSpine — evidence (#1689)", () => {
  /**
   * THE FIX ITSELF. The console's evidence block was empty in prod not because of
   * `skipFacetAggs` (which two comments in the repo claimed, and which is why an issue was
   * filed naming the wrong cause) but because the spine never passed `matchExplain`. This
   * pins the three options that turn it on, and pins `skipFacetAggs` staying ON alongside
   * them — because "fixing" the stated cause meant dropping it, which would have re-tripped
   * the OpenSearch breaker AND still produced nothing.
   */
  it("ASKS for evidence — matchExplain + the CHEAP doc-sourced path — while still skipping the facet aggs", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER", "D_KID"]));
    mockSearchPeople.mockResolvedValue(people(["a"]));

    await rankResearchersForDescriptionSpine("cancer work");

    expect(mockSearchPeople.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of mockSearchPeople.mock.calls) {
      expect(args.matchExplain).toBe(true);
      // reasonFromDoc + the descriptor UI select the O(1) `_source.meshSubtreeCounts` read,
      // so a resolved concept issues NO publications-index query. Without the UI this silently
      // falls back to the expensive per-call agg — the one that drove the ~10s hang.
      expect(args.reasonFromDoc).toBe(true);
      expect(args.meshDescriptorUi).toBe("D_CANCER");
      // The breaker guard must survive the fix.
      expect(args.skipFacetAggs).toBe(true);
    }
  });

  it("carries the search's own evidence onto the candidate, keyed to the concept it is FOR", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockResolvedValue({
      hits: [hitWithEvidence("a", "Cancer", 12, 40)],
      total: 1,
      pageSize: 20,
    });

    const { candidates } = await rankResearchersForDescriptionSpine("cancer work");

    const a = candidates.find((c) => c.cwid === "a")!;
    expect(a.searchEvidence).toHaveLength(1);
    // `term` is the JOIN KEY — it is the cluster's representative, the same string
    // `contributions[].term` and `concepts[].term` carry, so a client can put the block under
    // the right slider.
    expect(a.searchEvidence?.[0].term).toBe("cancer");
    expect(a.contributions.map((c) => c.term)).toContain("cancer");
    expect(a.searchEvidence?.[0].evidence).toMatchObject({ kind: "publications", term: "Cancer" });
    expect(a.searchEvidence?.[0].pubCount).toBe(40);
    // What the lazy `/api/search/key-paper` fetch needs, scoped to the matching concept.
    expect(a.searchEvidence?.[0].keyPaper).toEqual({
      descriptorUis: ["D_CANCER"],
      contentQuery: "cancer",
      conceptLabel: "D_CANCER",
    });
  });

  it("LEADS with the concept that carried the candidate — and still ships the other one", async () => {
    // Two concepts. "cancer" is extracted first and retrieves `a` at rank 3; "munchausen
    // syndrome" retrieves `a` at rank 1. First-wins would LEAD `a` with the cancer line — true,
    // but not why the fusion lifted them. The lead must follow the STRENGTH.
    //
    // Both come from the DICTIONARY fallback, so both carry UNIFORM_CENTRALITY and the same kind
    // prior ⇒ identical weights. At equal weights strength `w/(K+rank)` is monotone in rank
    // alone, so here — and ONLY here — strength ordering coincides with rank ordering. The tests
    // above pull the two apart with real (differentiated) centralities, which is what production
    // actually sends.
    //
    // #1696: and the cancer line, which was already fetched and then discarded, now ships too.
    // The card answers "why did this scholar match?" with every reason it paid for.
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "munchausen syndrome" }]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_CANCER", ["D_CANCER"]) : meshRes("D_MUNCH", ["D_MUNCH"]),
    );
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "cancer"
        ? {
            // `a` is 3rd here.
            hits: [
              hitWithEvidence("x", "Cancer", 9, 30),
              hitWithEvidence("y", "Cancer", 8, 30),
              hitWithEvidence("a", "Cancer", 1, 50),
            ],
            total: 3,
            pageSize: 20,
          }
        : {
            // `a` is 1st here — the concept that actually carried them.
            hits: [hitWithEvidence("a", "Munchausen", 22, 50)],
            total: 1,
            pageSize: 20,
          },
    );

    const { candidates } = await rankResearchersForDescriptionSpine(
      "cancer and munchausen syndrome work",
    );

    const a = candidates.find((c) => c.cwid === "a")!;
    expect(a.contributions.length).toBe(2); // ranked under both
    expect(a.searchEvidence?.map((e) => e.term)).toEqual(["munchausen syndrome", "cancer"]);
    expect(a.searchEvidence?.map((e) => e.evidence)).toMatchObject([
      { term: "Munchausen" },
      { term: "Cancer" },
    ]);
    // Each block's key-paper config is scoped to ITS OWN concept, which is what lets a block's
    // disclosure reveal papers about that concept rather than about the paste in general.
    expect(a.searchEvidence?.map((e) => e.keyPaper.descriptorUis)).toEqual([
      ["D_MUNCH"],
      ["D_CANCER"],
    ]);
    // The wire order is a re-ordering of the evidence ONLY. `contributions` — the re-rank inputs
    // the client sums — must not have been sorted underneath it.
    expect(a.contributions.map((c) => c.term)).toEqual(["cancer", "munchausen syndrome"]);
  });

  it("ships one block per matched concept, ordered by STRENGTH — not by raw rank (#1696)", async () => {
    // `a` ranks under all three concepts: #3 on alpha, #1 on beta, #2 on gamma. All three
    // `searchPeople` calls ALREADY returned evidence for them — the fan-out is the same either
    // way — and the old best-only read kept beta's and dropped the two it had paid for.
    //
    // ORDER IS BY STRENGTH, `conceptWeight(c)/(K + rank)` — the term the fusion sums, and the
    // one `matchedConcepts` orders the chips by. With γ=3, centrality dominates rank, so the
    // two orderings DISAGREE here and the test can tell them apart:
    //
    //   alpha  centrality 1.0 → weight 1.25    rank 3 → 1.25   /33 = .0379   ← strongest
    //   beta   centrality 0.9 → weight 0.91125 rank 1 → .91125 /31 = .0294
    //   gamma  centrality 0.8 → weight 0.64    rank 2 → .64    /32 = .0200
    //
    // By RANK it would be [beta, gamma, alpha] — leading the card with beta while the chips
    // lead with alpha. The blocks would contradict the chips beside them.
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "alpha", kind: "concept", centrality: 1.0 },
      { term: "beta", kind: "concept", centrality: 0.9 },
      { term: "gamma", kind: "concept", centrality: 0.8 },
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
    const ranked: Record<string, string[]> = {
      alpha: ["x", "y", "a"], // a at rank 3
      beta: ["a"], // a at rank 1
      gamma: ["z", "a"], // a at rank 2
    };
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) => ({
      hits: ranked[q].map((c) => hitWithEvidenceLines(c, `T-${q}`, 5, 40)),
      total: ranked[q].length,
      pageSize: 20,
    }));

    const { concepts, candidates } = await rankResearchersForDescriptionSpine("alpha beta gamma");

    const a = candidates.find((c) => c.cwid === "a")!;
    expect(a.contributions).toHaveLength(3);
    expect(a.searchEvidence?.map((e) => e.term)).toEqual(["alpha", "beta", "gamma"]);
    expect(a.searchEvidence?.map((e) => e.evidence)).toMatchObject([
      { term: "T-alpha" },
      { term: "T-beta" },
      { term: "T-gamma" },
    ]);
    // A rank sort would have shipped THIS instead. Naming the wrong answer explicitly is what
    // makes the test a discriminator rather than a snapshot: a regression to `.sort(by rank)`
    // produces exactly this list, and the assertion above rejects it.
    const byRank = [...a.contributions].sort((x, y) => x.rank - y.rank).map((c) => c.term);
    expect(byRank).toEqual(["beta", "gamma", "alpha"]);
    expect(a.searchEvidence?.map((e) => e.term)).not.toEqual(byRank);
    // THE JOIN THE CARD MAKES: the blocks lead with the same concept the CHIPS lead with,
    // because both are ordered by the same quantity. That is the property, not the literal list.
    expect(matchedConcepts(a, concepts).map((m) => m.concept.term)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    // The fan-out is unchanged: three concepts, one `searchPeople` page each. The widening reads
    // a Map — it buys no extra OpenSearch traffic, which is the budget the breaker polices.
    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
  });

  it("emits NO block for a concept whose evidence is the IDENTITY TAIL — even when it is the STRONGEST", async () => {
    // THE FABRICATION-OF-RELEVANCE GUARD, and the reason `isResearchMatchEvidence` exists.
    //
    // `unresolved` retrieves `a` at rank 1 and resolves to NO MeSH descriptor, so there is no
    // tagged count and nothing first-class to say. But `searchPeople` STILL returns evidence for
    // that hit — it always does; the ladder terminates in `{ kind: "none" }` and falls back to
    // the scholar's self-reported `areas` when they have any, which most do. The spine's old
    // `if (!hitEvidence) continue` guard could not fire, so the card rendered Alice's
    // areasOfInterest under a bold caption naming a concept nothing connected her to.
    //
    // It is also the STRONGEST contribution here (centrality 1.0, rank 1), so this pins that the
    // drop is by KIND, not a side effect of the cap — and that it does not take the real reason
    // below it down with it.
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "unresolved", kind: "concept", centrality: 1.0 },
      { term: "tagged", kind: "concept", centrality: 0.9 },
    ]);
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "tagged"
        ? meshRes("D_TAG", ["D_TAG"])
        : { state: "none" as const, meshResolution: null },
    );
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "tagged"
        ? {
            hits: [hitWithEvidenceLines("z", "Tagged", 9, 40), hitWithEvidenceLines("a", "Tagged", 7, 40)],
            total: 2,
            pageSize: 20,
          }
        : people(["a"]), // rank 1 — and the hit carries the `areas` identity tail, as prod does
    );

    const { candidates } = await rankResearchersForDescriptionSpine("unresolved tagged");

    const a = candidates.find((c) => c.cwid === "a")!;
    // The CHIP survives — `a` really did rank under `unresolved`, and that is a fact about the
    // retrieval. Only the claim about WHY is withheld, because there is none to make.
    expect(a.contributions.map((c) => c.term).sort()).toEqual(["tagged", "unresolved"]);
    expect(a.searchEvidence).toHaveLength(1);
    expect(a.searchEvidence?.[0].term).toBe("tagged");
    // Nothing anywhere on the wire captions a concept with the scholar's own research areas.
    expect(a.searchEvidence?.map((e) => e.evidence.kind)).toEqual(["publications"]);
  });

  it.each(["areas", "concepts", "none", "affiliation", "name"] as const)(
    "ships NO evidence at all when every concept's evidence is the `%s` tail",
    async (tail) => {
      // Every kind the ranker refuses to caption a concept with, one test each. The candidate
      // ranked #1 and the search returned evidence — it always does — but none of it is a claim
      // about their RESEARCH. `searchEvidence` must be ABSENT, not `[]` and certainly not a block:
      // an officer reading a bold "Fibrosis" caption over "— no specific match for this query —",
      // over the scholar's self-reported areas, or over the name of the institute they happen to
      // work in, has been told something untrue.
      //
      // `affiliation` and `name` are the two that a "is it query-derived?" test would WAVE THROUGH,
      // and they are exactly how the first fix of #1696 still shipped a fabrication.
      mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
      mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
      mockSearchPeople.mockResolvedValue({
        hits: [hitWithTailEvidence("a", tail)],
        total: 1,
        pageSize: 20,
      });

      const { candidates } = await rankResearchersForDescriptionSpine("cancer work");

      const a = candidates.find((c) => c.cwid === "a")!;
      expect(a.contributions.map((c) => c.term)).toEqual(["cancer"]); // ranked, and kept
      expect(a.searchEvidence).toBeUndefined();
      expect("searchEvidence" in a).toBe(false);
    },
  );

  it("caps the card at MAX_EVIDENCE_CONCEPTS — keeping the STRONGEST concepts, not the best-RANKED", async () => {
    // THE CAP-INVERSION GUARD. Five concepts, all with real evidence, `a` ranked 5/4/3/2/1
    // across them — i.e. rank runs OPPOSITE to centrality, which is the realistic shape, not a
    // contrived one: a sponsor's PRIMARY concept is its broadest, most competitive query, so a
    // specialist places WORSE on it than on a narrow peripheral mechanism.
    //
    // With the real constants (γ=3, K=30, kind prior 1.25 — all five are the target kind):
    //
    //   term  centrality  weight = c³×1.25   rank   strength = weight/(30+rank)
    //   c1       1.0          1.25            5        .0357   ← STRONGEST
    //   c2       0.9           .911           4        .0268
    //   c3       0.8           .640           3        .0194
    //   c4       0.7           .429           2        .0134
    //   c5       0.6           .270           1        .0087   ← weakest
    //
    // The cap must keep [c1, c2, c3]. A RANK cap keeps [c5, c4, c3] — the three WEAKEST — and
    // slices off c1, the sponsor's actual target and the card's leading chip. That is not a
    // rounding difference between two defensible orders; it is the exact inversion, and it is
    // what the first cut of #1696 shipped.
    const terms = ["c1", "c2", "c3", "c4", "c5"];
    mockExtractSponsorConcepts.mockResolvedValue(
      terms.map((term, i) => ({ term, kind: "concept" as const, centrality: 1 - i * 0.1 })),
    );
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
    // `a` sits at rank (5 - i) under cN: rank 5 under c1 … rank 1 under c5.
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) => {
      const depth = 5 - terms.indexOf(q); // c1 → 5 hits (a last), c5 → 1 hit (a first)
      const cwids = [...Array(depth - 1).keys()].map((n) => `pad${q}${n}`).concat("a");
      return {
        hits: cwids.map((c) => hitWithEvidenceLines(c, `T-${q}`, 5, 40)),
        total: cwids.length,
        pageSize: 20,
      };
    });

    const { concepts, candidates } = await rankResearchersForDescriptionSpine("c1 c2 c3 c4 c5");

    const a = candidates.find((c) => c.cwid === "a")!;
    expect(a.contributions).toHaveLength(5); // every one is still a re-rank input
    expect(MAX_EVIDENCE_CONCEPTS).toBeLessThan(a.contributions.length); // the cap really binds
    expect(a.searchEvidence).toHaveLength(MAX_EVIDENCE_CONCEPTS);
    expect(a.searchEvidence?.map((e) => e.term)).toEqual(["c1", "c2", "c3"]);

    // Name the wrong answer, so a regression to a rank sort is REJECTED rather than merely
    // un-asserted. These two lists are disjoint on their first two entries.
    const byRank = [...a.contributions].sort((x, y) => x.rank - y.rank).map((c) => c.term);
    expect(byRank.slice(0, MAX_EVIDENCE_CONCEPTS)).toEqual(["c5", "c4", "c3"]);
    expect(a.searchEvidence?.map((e) => e.term)).not.toEqual(byRank.slice(0, MAX_EVIDENCE_CONCEPTS));

    // AND THE CAP AGREES WITH THE CARD. `matchedConcepts` is what orders the chips; the blocks
    // the server kept are the first MAX_EVIDENCE_CONCEPTS chips, in chip order. If these two
    // ever diverge the officer sees a card whose top chip has no block under it.
    expect(matchedConcepts(a, concepts).map((m) => m.concept.term)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  it("drops the evidence-less concepts BEFORE the cap — a full card, not a short one", async () => {
    // FILTER-BEFORE-SLICE, pinned. Five concepts, `a` ranked #1 under every one of them, so
    // strength order is just centrality order: c1 > c2 > c3 > c4 > c5. But the two STRONGEST —
    // c1 and c2 — resolved to nothing and come back carrying the identity tail, so they ship no
    // block.
    //
    // Correct: filter first, then slice ⇒ [c3, c4, c5], a FULL card of MAX_EVIDENCE_CONCEPTS.
    // A cap-before-filter implementation slices [c1, c2, c3] first and then drops c1/c2, leaving
    // ONE block — spending two of its three slots on concepts that had nothing to say while real
    // evidence sat unused in the map. That mutant passes every other test in this file.
    const terms = ["c1", "c2", "c3", "c4", "c5"];
    mockExtractSponsorConcepts.mockResolvedValue(
      terms.map((term, i) => ({ term, kind: "concept" as const, centrality: 1 - i * 0.1 })),
    );
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) => meshRes(`D_${q}`, [`D_${q}`]));
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) => ({
      // `a` is rank 1 everywhere. c1/c2 → identity tail (no match evidence); c3/c4/c5 → tagged.
      hits: [
        q === "c1" || q === "c2"
          ? hitWithTailEvidence("a", "areas")
          : hitWithEvidenceLines("a", `T-${q}`, 5, 40),
      ],
      total: 1,
      pageSize: 20,
    }));

    const { candidates } = await rankResearchersForDescriptionSpine("c1 c2 c3 c4 c5");

    const a = candidates.find((c) => c.cwid === "a")!;
    expect(a.contributions).toHaveLength(5);
    // A FULL card. Not one block, not two.
    expect(a.searchEvidence).toHaveLength(MAX_EVIDENCE_CONCEPTS);
    expect(a.searchEvidence?.map((e) => e.term)).toEqual(["c3", "c4", "c5"]);
    // And the two strongest concepts — which a cap-before-filter would have spent slots on —
    // contribute nothing at all.
    expect(a.searchEvidence?.map((e) => e.term)).not.toContain("c1");
    expect(a.searchEvidence?.map((e) => e.term)).not.toContain("c2");
  });

  it("reads the TIERED `evidenceLines` shape production actually emits, not just `evidence`", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `searchPeople` emits `evidenceLines[]` whenever
    // SEARCH_EVIDENCE_REASON_COUNTS is on — which it is, in staging AND prod — and then never
    // populates `evidence`. Reading only `evidence` yields a candidate list with no evidence at
    // all in every environment that matters, while every mocked test still passes.
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockResolvedValue({
      hits: [hitWithEvidenceLines("a", "Cancer", 12, 40)],
      total: 1,
      pageSize: 20,
    });

    const { candidates } = await rankResearchersForDescriptionSpine("cancer work");

    expect(candidates[0].searchEvidence?.[0].evidence).toMatchObject({
      kind: "publications",
      term: "Cancer",
      count: 12,
    });
    expect(candidates[0].searchEvidence?.[0].pubCount).toBe(40);
  });

  it("takes the PRIMARY lead when several evidence lines are tiered — and only that one", async () => {
    // `evidenceLines[0]` is the strongest reason by the search's own precedence ladder — the
    // one the People card renders large. A lesser "Also matched" row must not caption the card.
    //
    // #1696 widened the card ACROSS concepts, deliberately NOT within one. `evidenceLines[1..]`
    // restate the same concept's match more weakly; a second CONCEPT's lead is a new reason.
    // One block per concept — not one per tiered line per concept.
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    const primary = taggedEvidence("Cancer", 30, 40);
    const lesser = taggedEvidence("Something Weaker", 1, 40);
    mockSearchPeople.mockResolvedValue({
      hits: [{ ...displayFields("a"), pubCount: 40, evidenceLines: [primary, lesser] }],
      total: 1,
      pageSize: 20,
    });

    const { candidates } = await rankResearchersForDescriptionSpine("cancer work");
    expect(candidates[0].searchEvidence).toHaveLength(1);
    expect(candidates[0].searchEvidence?.[0].evidence).toMatchObject({
      term: "Cancer",
      count: 30,
    });
  });

  it("leaves evidence ABSENT when the hit carries NEITHER field — never a zeroed count, never an empty array", async () => {
    // The `!hitEvidence` half of the guard, which only `SEARCH_RESULT_EVIDENCE` OFF can trigger
    // (no deployed environment does — hence `hitNoEvidence`, a shape prod cannot emit). Absent
    // means "not computed"; a `{ count: 0 }` would assert the scholar has no matching papers,
    // and an empty `[]` is the same lie in list form. The field is omitted outright.
    //
    // The case that ACTUALLY fires in prod — a hit carrying the identity tail — is the `it.each`
    // above. Both land here; only one of them was reachable, and the suite used to test only the
    // unreachable one.
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockResolvedValue({
      hits: [hitNoEvidence("a")],
      total: 1,
      pageSize: 20,
    });

    const { candidates } = await rankResearchersForDescriptionSpine("cancer work");
    expect(candidates[0].searchEvidence).toBeUndefined();
    expect("searchEvidence" in candidates[0]).toBe(false);
  });
});

/**
 * MATCHA_GLOSS_RERANK — the spine threads the cluster's gloss into `searchPeople` as an OpenSearch
 * `rescore` (recall-safe re-order), but ONLY when the flag is on AND the cluster has a gloss.
 * The guard the handoff calls out: flag OFF ⇒ the searchPeople args are byte-identical to today,
 * so a mutation that always attaches the rescore is caught here.
 */
describe("MATCHA_GLOSS_RERANK — gloss rescore threading", () => {
  const GLOSS = "reprogramming cellular metabolism to fuel tumor growth";
  const prev = {
    on: process.env.MATCHA_GLOSS_RERANK,
    lambda: process.env.MATCHA_GLOSS_RERANK_LAMBDA,
  };

  beforeEach(() => {
    // LLM path with ONE concept that carries a gloss ⇒ one cluster whose representative has a gloss.
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "cancer metabolism", kind: "concept", centrality: 1, gloss: GLOSS },
    ]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CM", ["D_CM"]));
    mockSearchPeople.mockResolvedValue(people(["a", "b"]));
    delete process.env.MATCHA_GLOSS_RERANK;
    delete process.env.MATCHA_GLOSS_RERANK_LAMBDA;
  });

  afterEach(() => {
    if (prev.on === undefined) delete process.env.MATCHA_GLOSS_RERANK;
    else process.env.MATCHA_GLOSS_RERANK = prev.on;
    if (prev.lambda === undefined) delete process.env.MATCHA_GLOSS_RERANK_LAMBDA;
    else process.env.MATCHA_GLOSS_RERANK_LAMBDA = prev.lambda;
  });

  it("flag OFF ⇒ searchPeople args carry NO rescore keys (byte-identical guard)", async () => {
    await rankResearchersForDescriptionSpine("cancer metabolism paste");
    const call = mockSearchPeople.mock.calls[0][0];
    expect("rescoreQuery" in call).toBe(false);
    expect("rescoreWeight" in call).toBe(false);
    expect("rescoreWindow" in call).toBe(false);
  });

  it("flag ON + cluster has a gloss ⇒ rescoreQuery=gloss, λ from env, window=TERM_DEPTH(100)", async () => {
    process.env.MATCHA_GLOSS_RERANK = "on";
    process.env.MATCHA_GLOSS_RERANK_LAMBDA = "0.25";
    await rankResearchersForDescriptionSpine("cancer metabolism paste");
    const call = mockSearchPeople.mock.calls[0][0];
    expect(call.rescoreQuery).toBe(GLOSS);
    expect(call.rescoreWeight).toBe(0.25);
    expect(call.rescoreWindow).toBe(100);
  });

  it("flag ON + λ unset ⇒ defaults to 0.5", async () => {
    process.env.MATCHA_GLOSS_RERANK = "on";
    await rankResearchersForDescriptionSpine("cancer metabolism paste");
    expect(mockSearchPeople.mock.calls[0][0].rescoreWeight).toBe(0.5);
  });

  it("a negative λ is clamped to 0 (keeps the rescore recall-safe by construction)", async () => {
    process.env.MATCHA_GLOSS_RERANK = "on";
    process.env.MATCHA_GLOSS_RERANK_LAMBDA = "-1";
    await rankResearchersForDescriptionSpine("cancer metabolism paste");
    expect(mockSearchPeople.mock.calls[0][0].rescoreWeight).toBe(0);
  });

  it("flag ON but the cluster has NO gloss ⇒ no rescore (off-path byte-identical)", async () => {
    process.env.MATCHA_GLOSS_RERANK = "on";
    mockExtractSponsorConcepts.mockResolvedValue([
      { term: "cancer metabolism", kind: "concept", centrality: 1 },
    ]);
    await rankResearchersForDescriptionSpine("cancer metabolism paste");
    expect("rescoreQuery" in mockSearchPeople.mock.calls[0][0]).toBe(false);
  });
});
