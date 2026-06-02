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
  hitHolder: { highlight: undefined as { title?: string[] } | undefined },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    scholar: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn().mockResolvedValue(new Map()),
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
});
afterEach(() => {
  delete process.env.SEARCH_PUB_HIGHLIGHT;
});

describe("searchPublications highlight body", () => {
  it("off: no highlight clause; titleHighlight is null", async () => {
    const res = await searchPublications({ q: "microbiome" });
    expect(highlightOf(capturedBodies[0])).toBeUndefined();
    expect(res.hits[0].titleHighlight).toBeNull();
  });

  it("on: requests a title highlight and emits the marked fragment", async () => {
    hitHolder.highlight = { title: ["The Traveling <mark>Microbiome</mark>."] };
    const res = await searchPublications({ q: "microbiome", highlightMatches: true });
    const hl = highlightOf(capturedBodies[0]);
    expect(hl?.fields).toHaveProperty("title");
    expect(hl?.highlight_query).toBeUndefined();
    expect(res.hits[0].titleHighlight).toBe("The Traveling <mark>Microbiome</mark>.");
  });

  it("on + demote: highlight_query runs the content query over title", async () => {
    await searchPublications({
      q: "microbiome research",
      contentQuery: "microbiome",
      genericDemote: true,
      highlightMatches: true,
    });
    const hq = highlightOf(capturedBodies[0])?.highlight_query as {
      multi_match: { query: string; fields: string[] };
    };
    expect(hq.multi_match.query).toBe("microbiome");
    expect(hq.multi_match.fields).toEqual(["title"]);
  });

  it("on but no title match: titleHighlight stays null", async () => {
    hitHolder.highlight = undefined;
    const res = await searchPublications({ q: "microbiome", highlightMatches: true });
    expect(res.hits[0].titleHighlight).toBeNull();
  });
});
