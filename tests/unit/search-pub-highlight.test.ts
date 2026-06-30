/**
 * SEARCH_PUB_HIGHLIGHT — `searchPublications` requests a `title` highlight and
 * emits `titleHighlight` so the result row can mark the matched terms.
 *
 *   - off → no `highlight` clause in the body; `titleHighlight` is null
 *     (byte-identical to the pre-flag shape).
 *   - on  → `highlight.fields.title` requested; the marked fragment is emitted.
 *   - on + #692 demote → `highlight_query` runs the content query over `title`
 *     so a stripped generic isn't marked.
 *
 * Mirrors the capture-the-body harness in `search-pub-recency.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hitHolder } = vi.hoisted(() => ({
  hitHolder: {
    highlight: undefined as { title?: string[] } | undefined,
    meshDescriptorUi: undefined as string[] | undefined,
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    scholar: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn().mockResolvedValue(new Map()),
  fetchAuthorBylineForPmids: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/api/search-taxonomy", () => ({
  descriptorLabelsForUis: vi.fn().mockResolvedValue(
    new Map([
      ["D018270", "Carcinoma, Ductal, Breast"],
      ["D018275", "Carcinoma, Lobular"],
    ]),
  ),
}));

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
  EMPTY_MENTORING_BUCKETS: {
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  },
}));

const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: ["title^4", "meshTerms^2", "authorNames^2", "journal^1", "abstract^0.5"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      return {
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  pmid: "1",
                  title: "The Traveling Microbiome.",
                  journal: "Cell",
                  year: 2022,
                  publicationType: "Journal Article",
                  citationCount: 3,
                  doi: null,
                  pmcid: null,
                  pubmedUrl: null,
                  abstract: "",
                  meshDescriptorUi: hitHolder.meshDescriptorUi,
                },
                highlight: hitHolder.highlight,
              },
            ],
          },
          aggregations: {
            publicationTypes: { keys: { buckets: [] } },
            journals: { keys: { buckets: [] } },
            wcmRoleFirst: { doc_count: 0 },
            wcmRoleSenior: { doc_count: 0 },
            wcmRoleMiddle: { doc_count: 0 },
            wcmAuthors: { keys: { buckets: [] }, total: { value: 0 } },
            mentoringPrograms: {
              buckets: {
                md: { doc_count: 0 },
                mdphd: { doc_count: 0 },
                phd: { doc_count: 0 },
                postdoc: { doc_count: 0 },
                ecr: { doc_count: 0 },
              },
            },
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

import { searchPublications } from "@/lib/api/search";

type Body = Record<string, unknown>;
const highlightOf = (b: Body) =>
  (b as { highlight?: { fields?: Record<string, unknown>; highlight_query?: unknown } }).highlight;

beforeEach(() => {
  capturedBodies.length = 0;
  hitHolder.highlight = undefined;
  hitHolder.meshDescriptorUi = undefined;
});
afterEach(() => {
  delete process.env.SEARCH_PUB_HIGHLIGHT;
});

// Breast Neoplasms (D001943) → [self, Carcinoma Ductal Breast, Carcinoma Lobular].
const BREAST_RESOLUTION = {
  descriptorUi: "D001943",
  name: "Breast Neoplasms",
  matchedForm: "breast cancer",
  confidence: "entry-term" as const,
  scopeNote: null,
  entryTerms: ["Breast Cancer"],
  curatedTopicAnchors: [],
  descendantUis: ["D001943", "D018270", "D018275"],
};

describe("searchPublications highlight body", () => {
  it("off: no highlight clause; titleHighlight is null", async () => {
    const res = await searchPublications({ q: "microbiome" });
    expect(highlightOf(capturedBodies[0])).toBeUndefined();
    expect(res.hits[0].titleHighlight).toBeNull();
  });

  type BoolHq = {
    bool: {
      should: [{ match_phrase: { title: string } }, { match: { title: string } }];
    };
  };

  it("on: highlight_query gates the full query OR phrase; emits the marked fragment", async () => {
    hitHolder.highlight = { title: ["The Traveling <mark>Microbiome</mark>."] };
    // contentQuery is the route-stripped significant query (here unchanged).
    const res = await searchPublications({
      q: "microbiome",
      contentQuery: "microbiome",
      highlightMatches: true,
    });
    const hl = highlightOf(capturedBodies[0]);
    expect(hl?.fields).toHaveProperty("title");
    const hq = hl?.highlight_query as BoolHq;
    expect(hq.bool.should[0].match_phrase.title).toBe("microbiome");
    expect(hq.bool.should[1].match.title).toBe("microbiome");
    expect(res.hits[0].titleHighlight).toBe("The Traveling <mark>Microbiome</mark>.");
  });

  it("significance gating: phrase keeps the full query; token-match drops the generic", async () => {
    // The route passes contentQuery = stripDeprioritized("microbiome research") = "microbiome".
    await searchPublications({
      q: "microbiome research",
      contentQuery: "microbiome",
      highlightMatches: true,
    });
    const hq = highlightOf(capturedBodies[0])?.highlight_query as BoolHq;
    // Phrase clause keeps the FULL typed query (so a contiguous "Microbiome
    // Research" still highlights as the phrase)...
    expect(hq.bool.should[0].match_phrase.title).toBe("microbiome research");
    // ...but the token clause is the SIGNIFICANT query only — scattered
    // "research" never lights up.
    expect(hq.bool.should[1].match.title).toBe("microbiome");
  });

  it("gating is decoupled from the demote flag (highlight_query present even with demote off)", async () => {
    await searchPublications({
      q: "microbiome research",
      contentQuery: "microbiome",
      genericDemote: false,
      highlightMatches: true,
    });
    const hq = highlightOf(capturedBodies[0])?.highlight_query as BoolHq;
    expect(hq.bool.should[1].match.title).toBe("microbiome");
  });

  it("on but no title match: titleHighlight stays null", async () => {
    hitHolder.highlight = undefined;
    const res = await searchPublications({ q: "microbiome", highlightMatches: true });
    expect(res.hits[0].titleHighlight).toBeNull();
  });

  it("#1351 — with a concept resolved, the should also marks the resolved concept term", async () => {
    await searchPublications({
      q: "breast cancer",
      contentQuery: "breast cancer",
      highlightMatches: true,
      meshResolution: BREAST_RESOLUTION,
    });
    const should = (highlightOf(capturedBodies[0])?.highlight_query as { bool: { should: unknown[] } })
      .bool.should;
    // literal clauses stay...
    expect(should).toContainEqual({ match_phrase: { title: "breast cancer" } });
    // ...and the resolved descriptor name is marked too (concept-expansion match).
    expect(should).toContainEqual({ match_phrase: { title: "Breast Neoplasms" } });
  });
});

describe("searchPublications MeSH match provenance (#707)", () => {
  it("emits a narrower note when the pub is tagged with a descendant descriptor", async () => {
    hitHolder.meshDescriptorUi = ["D018270"]; // Carcinoma, Ductal, Breast
    const res = await searchPublications({
      q: "breast cancer",
      meshResolution: BREAST_RESOLUTION,
      matchProvenance: true,
    });
    expect(res.hits[0].matchProvenance).toEqual({
      kind: "narrower",
      parentTerm: "Breast Neoplasms",
      descendantTerms: ["Carcinoma, Ductal, Breast"],
    });
  });

  it("emits a concept note when the pub is tagged with the resolved descriptor itself", async () => {
    hitHolder.meshDescriptorUi = ["D001943"]; // Breast Neoplasms
    const res = await searchPublications({
      q: "breast cancer",
      meshResolution: BREAST_RESOLUTION,
      matchProvenance: true,
    });
    expect(res.hits[0].matchProvenance).toEqual({ kind: "concept", parentTerm: "Breast Neoplasms" });
  });

  it("omits the note when the flag is off", async () => {
    hitHolder.meshDescriptorUi = ["D018270"];
    const res = await searchPublications({ q: "breast cancer", meshResolution: BREAST_RESOLUTION });
    expect(res.hits[0].matchProvenance).toBeUndefined();
  });

  it("omits the note when no descriptor resolved", async () => {
    hitHolder.meshDescriptorUi = ["D018270"];
    const res = await searchPublications({ q: "breast cancer", matchProvenance: true });
    expect(res.hits[0].matchProvenance).toBeUndefined();
  });

  it("omits the note when the pub carries no intersecting descriptor", async () => {
    hitHolder.meshDescriptorUi = ["D099999"]; // unrelated
    const res = await searchPublications({
      q: "breast cancer",
      meshResolution: BREAST_RESOLUTION,
      matchProvenance: true,
    });
    expect(res.hits[0].matchProvenance).toBeUndefined();
  });
});
