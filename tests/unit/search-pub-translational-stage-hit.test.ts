/**
 * The publications search hit carries the paper's display-ready
 * `translationalStage` while SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET is on: the
 * field is requested in the slimmed `_source` include list (#1407) and mapped
 * onto the hit. Flag off, a doc with no stage, or a value outside the four
 * stages leaves the key off the hit altogether.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
}));

const capturedBodies: Array<Record<string, unknown>> = [];

function doc(pmid: string, translationalStage?: string) {
  return {
    _score: 1,
    _source: {
      pmid,
      title: `Paper ${pmid}`,
      journal: "Journal of Test Fixtures",
      year: 2024,
      publicationType: "Academic Article",
      citationCount: 0,
      doi: null,
      pmcid: null,
      pubmedUrl: null,
      ...(translationalStage ? { translationalStage } : {}),
    },
  };
}

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_INDEX: "scholars-funding",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: ["title^4"],
  FUNDING_FIELD_BOOSTS: ["title^4"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { index: string; body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      return {
        body: {
          hits: {
            total: { value: 3 },
            hits: [doc("1", "T2"), doc("2"), doc("3", "NA")],
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

/** The hits request is the one that asks for a page of documents. */
function hitsSource(): string[] {
  const body = capturedBodies.find((b) => Array.isArray(b._source) && (b.size as number) > 0);
  return (body?._source ?? []) as string[];
}

async function run() {
  const { searchPublications } = await import("@/lib/api/search");
  return searchPublications({ q: "cancer", page: 0, filters: {} });
}

beforeEach(() => {
  capturedBodies.length = 0;
  vi.resetModules();
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
});

afterEach(() => {
  delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  delete process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET;
});

describe("Publications hit — translationalStage", () => {
  it("flag ON: requests the field and maps a displayable stage onto the hit", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    const result = await run();
    expect(hitsSource()).toContain("translationalStage");
    expect(result.hits.map((h) => h.translationalStage)).toEqual(["T2", undefined, undefined]);
    // No stage (or a non-displayable value) leaves the key off, not null.
    expect(result.hits[1]).not.toHaveProperty("translationalStage");
    expect(result.hits[2]).not.toHaveProperty("translationalStage");
  });

  it("flag OFF: the field is neither requested nor on any hit", async () => {
    const result = await run();
    expect(hitsSource()).not.toContain("translationalStage");
    for (const h of result.hits) expect(h).not.toHaveProperty("translationalStage");
  });
});
