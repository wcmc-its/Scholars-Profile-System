/**
 * GRANT spine (`matcha-grants-spine.ts`) — the grant-target sibling of the people spine.
 *  - reuses extract → resolve-to-MeSH → cluster → cap → weighted RRF verbatim, swapping only
 *    retrieval (over `scholars-opportunities`, by MeSH descendant-UI + title/synopsis) and hydration
 *    (to `GrantCandidate`);
 *  - fuses per-concept opportunity rankings into GrantCandidates carrying `contributions` (THE HINGE)
 *    + `fusedScore`, so the client re-ranks grants with the same machinery as people;
 *  - admits a grant by MeSH-descendant OR text, and omits the MeSH clause for an unresolved concept;
 *  - v1 has NO dictionary fallback: an empty extraction short-circuits to no grants, no search issued.
 * Mocks the extractor (never Bedrock), the taxonomy resolver, and the OpenSearch client; the pure
 * spine/axes/contract helpers and `normalizeDescription` run for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExtract, mockTaxonomy, mockSearch } = vi.hoisted(() => ({
  mockExtract: vi.fn(),
  mockTaxonomy: vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock("@/lib/api/matcha-extract", () => ({
  extractMatchaConcepts: (paste: string) =>
    Promise.resolve(mockExtract(paste)).then((r) => (Array.isArray(r) ? { concepts: r } : r)),
}));
vi.mock("@/lib/api/search-taxonomy", () => ({ matchQueryToTaxonomy: mockTaxonomy }));
vi.mock("@/lib/search", () => ({
  OPPORTUNITIES_INDEX: "scholars-opportunities",
  searchClient: () => ({ search: mockSearch }),
  meshMatchTier: vi.fn(() => "exact"),
}));

import { rankGrantsForDescriptionSpine } from "@/lib/api/matcha-grants-spine";

/** A taxonomy resolution stub — the grant spine reads only `meshResolution.descendantUis`. */
function meshRes(descriptorUi: string, descendantUis: string[]) {
  return { state: "none" as const, meshResolution: { descriptorUi, descendantUis } };
}

/** An opportunities-index hit `_source` with all hydrated fields. */
function oppHit(id: string, over: Record<string, unknown> = {}) {
  return {
    _source: {
      opportunityId: id,
      title: `T-${id}`,
      synopsis: `S-${id}`,
      sponsor: "NIH",
      mechanism: "R01",
      status: "open",
      dueDate: "2026-09-01",
      awardCeiling: 500000,
      numberOfAwards: 3,
      ...over,
    },
  };
}

type SearchClause = {
  multi_match?: { query: string };
  terms?: { meshDescriptorUi: string[]; boost?: number };
};
type SearchReq = { index: string; body: { query: { bool: { should: SearchClause[] } } } };
function textQueryOf(req: SearchReq): string {
  return req.body.query.bool.should[0].multi_match!.query;
}

describe("rankGrantsForDescriptionSpine", () => {
  beforeEach(() => {
    mockExtract.mockReset();
    mockTaxonomy.mockReset();
    mockSearch.mockReset();
  });

  it("fuses per-concept opportunity rankings into GrantCandidates with contributions + hydration", async () => {
    mockExtract.mockResolvedValue({
      concepts: [
        { term: "glioblastoma", kind: "concept", centrality: 1.0 },
        { term: "immunotherapy", kind: "concept", centrality: 0.8 },
      ],
      titleSummary: "GBM immunotherapy",
    });
    mockTaxonomy.mockImplementation((term: string) =>
      Promise.resolve(meshRes(`D-${term}`, [`U-${term}`])),
    );
    // glioblastoma → [opp-a #1, opp-b #2]; immunotherapy → [opp-b #1, opp-c #2].
    // opp-b ranks under BOTH ⇒ it wins and carries two contributions.
    mockSearch.mockImplementation((req: SearchReq) => {
      const q = textQueryOf(req);
      const hits = q.includes("glioblastoma")
        ? [oppHit("opp-a"), oppHit("opp-b")]
        : [oppHit("opp-b"), oppHit("opp-c")];
      return Promise.resolve({ body: { hits: { hits } } });
    });

    const { concepts, candidates, titleSummary } = await rankGrantsForDescriptionSpine(
      "we fund glioblastoma immunotherapy",
    );

    expect(titleSummary).toBe("GBM immunotherapy");
    expect(concepts.map((c) => c.term).sort()).toEqual(["glioblastoma", "immunotherapy"]);
    // opp-b matched both concepts ⇒ top, with both contributions.
    expect(candidates[0].opportunityId).toBe("opp-b");
    expect(candidates[0].contributions.map((c) => c.term).sort()).toEqual([
      "glioblastoma",
      "immunotherapy",
    ]);
    // Hydration fields came straight off the hit `_source`.
    expect(candidates[0].title).toBe("T-opp-b");
    expect(candidates[0].sponsor).toBe("NIH");
    expect(candidates[0].awardCeiling).toBe(500000);
    // fusedScore present + monotonically the max (client re-rank input).
    expect(typeof candidates[0].fusedScore).toBe("number");
    expect(candidates[0].fusedScore).toBeGreaterThan(candidates[candidates.length - 1].fusedScore);
  });

  it("admits by MeSH-descendant OR text, and omits the MeSH clause for an unresolved concept", async () => {
    mockExtract.mockResolvedValue({
      concepts: [
        { term: "diabetes", kind: "concept", centrality: 1.0 },
        { term: "novelunresolved", kind: "concept", centrality: 0.5 },
      ],
    });
    mockTaxonomy.mockImplementation((term: string) =>
      Promise.resolve(term === "diabetes" ? meshRes("D-dia", ["U1", "U2"]) : meshRes("D-x", [])),
    );
    const reqs: SearchReq[] = [];
    mockSearch.mockImplementation((req: SearchReq) => {
      reqs.push(req);
      return Promise.resolve({ body: { hits: { hits: [oppHit("o1")] } } });
    });

    await rankGrantsForDescriptionSpine("diabetes and novelunresolved");

    const dia = reqs.find((r) => textQueryOf(r) === "diabetes")!;
    const method = reqs.find((r) => textQueryOf(r) === "novelunresolved")!;
    expect(dia.index).toBe("scholars-opportunities");
    // Resolved concept → a MeSH-descendant terms clause is present, carrying its descendant UIs.
    const diaTerms = dia.body.query.bool.should.find((s) => s.terms);
    expect(diaTerms?.terms?.meshDescriptorUi).toEqual(["U1", "U2"]);
    // Unresolved concept → text-only admission, no terms clause.
    expect(method.body.query.bool.should.some((s) => s.terms)).toBe(false);
  });

  it("returns no grants when extraction is empty (no dictionary fallback in v1) — no search issued", async () => {
    mockExtract.mockResolvedValue({ concepts: [], titleSummary: "x" });
    const r = await rankGrantsForDescriptionSpine("something conceptless");
    expect(r.candidates).toEqual([]);
    expect(r.concepts).toEqual([]);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
