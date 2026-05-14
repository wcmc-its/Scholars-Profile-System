/**
 * Tests for the ?topic= filter on lib/api/search.ts searchPeople.
 *
 * D-10: "View all N scholars in this area →" link on the topic page calls
 * /api/search?topic=<slug>&type=people which should return only scholars who
 * have ≥1 PublicationTopic row attributed to that parent topic.
 *
 * Strategy: mock both @/lib/db (Prisma — for the topic pre-filter groupBy) and
 * @/lib/search (OpenSearch — for the actual search hit fetch). Verify that:
 *   - topic param triggers a Prisma groupBy for the cwid pre-filter
 *   - the resulting cwid list is passed as a terms filter to OpenSearch
 *   - when no scholars match, the empty result is returned without calling OpenSearch
 *   - existing q + page behaviour is preserved when topic is absent
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPublicationTopicGroupBy,
  mockSearchClientSearch,
  mockSearchClientMGet,
} = vi.hoisted(() => ({
  mockPublicationTopicGroupBy: vi.fn(),
  mockSearchClientSearch: vi.fn(),
  mockSearchClientMGet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: mockPublicationTopicGroupBy,
    },
  },
}));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_RESTRUCTURED_MSM: "-0% 3<-25%",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "-0% 3<-25%",
  searchClient: () => ({
    search: mockSearchClientSearch,
    mget: mockSearchClientMGet,
  }),
}));

import { searchPeople } from "@/lib/api/search";

const EMPTY_AGGS = {
  deptDivs: { keys: { buckets: [] } },
  personTypes: { keys: { buckets: [] } },
  activityHasGrants: { doc_count: 0 },
  activityRecentPub: { doc_count: 0 },
};

const EMPTY_OS_RESPONSE = {
  body: {
    hits: { hits: [], total: { value: 0 } },
    aggregations: EMPTY_AGGS,
  },
};

const OS_HIT_RESPONSE = (cwids: string[]) => ({
  body: {
    hits: {
      total: { value: cwids.length },
      hits: cwids.map((cwid) => ({
        _source: {
          cwid,
          slug: `scholar-${cwid}`,
          preferredName: `Scholar ${cwid}`,
          primaryTitle: "Professor",
          primaryDepartment: "Medicine",
          deptName: "Medicine",
          divisionName: null,
          personType: "full_time_faculty",
          publicationCount: 5,
          grantCount: 0,
          hasActiveGrants: false,
        },
        highlight: undefined,
      })),
    },
    aggregations: EMPTY_AGGS,
  },
});

describe("searchPeople with topic filter (D-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchClientMGet.mockResolvedValue({ body: { docs: [] } });
  });

  it("filters scholars by topic when topic param provided", async () => {
    // Arrange: prisma returns two cwids matching the topic
    mockPublicationTopicGroupBy.mockResolvedValue([
      { cwid: "scholar01", _count: { _all: 1 } },
      { cwid: "scholar02", _count: { _all: 1 } },
    ]);
    mockSearchClientSearch.mockResolvedValue(OS_HIT_RESPONSE(["scholar01", "scholar02"]));

    // Act
    const result = await searchPeople({ q: "", topic: "cancer_genomics" });

    // Assert: Prisma was called to pre-filter by topic
    expect(mockPublicationTopicGroupBy).toHaveBeenCalledOnce();
    const prismCall = mockPublicationTopicGroupBy.mock.calls[0][0];
    expect(prismCall.where.parentTopicId).toBe("cancer_genomics");
    expect(prismCall.where.scholar.deletedAt).toBeNull();
    expect(prismCall.where.scholar.status).toBe("active");

    // Assert: OpenSearch received a terms filter with the cwid list
    expect(mockSearchClientSearch).toHaveBeenCalledOnce();
    const osBody = mockSearchClientSearch.mock.calls[0][0].body;
    const filterClauses = osBody.query.bool.filter as Array<Record<string, unknown>>;
    const termsFilter = filterClauses.find(
      (f) =>
        typeof f === "object" &&
        "terms" in f &&
        typeof (f as Record<string, unknown>).terms === "object",
    );
    expect(termsFilter).toBeDefined();
    const termsObj = (termsFilter as Record<string, { cwid?: string[] }>).terms;
    expect(termsObj.cwid).toBeDefined();
    expect(termsObj.cwid).toContain("scholar01");
    expect(termsObj.cwid).toContain("scholar02");

    // Assert: result hits populated
    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("returns empty hits when no scholars match topic (no OpenSearch call)", async () => {
    // Arrange: topic has no matching scholars
    mockPublicationTopicGroupBy.mockResolvedValue([]);

    const result = await searchPeople({ q: "", topic: "obscure_topic" });

    // Prisma was called
    expect(mockPublicationTopicGroupBy).toHaveBeenCalledOnce();
    // OpenSearch should NOT be called — early return optimisation
    expect(mockSearchClientSearch).not.toHaveBeenCalled();

    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(20);
  });

  it("ignores topic param when not provided (existing behaviour preserved)", async () => {
    mockSearchClientSearch.mockResolvedValue(EMPTY_OS_RESPONSE);

    await searchPeople({ q: "doe" });

    // Prisma groupBy should NOT be called when no topic
    expect(mockPublicationTopicGroupBy).not.toHaveBeenCalled();
    // OpenSearch should be called normally
    expect(mockSearchClientSearch).toHaveBeenCalledOnce();

    // Verify the filter clause does NOT contain a terms-cwid filter
    const osBody = mockSearchClientSearch.mock.calls[0][0].body;
    const filterClauses = osBody.query.bool.filter as Array<Record<string, unknown>>;
    const termsFilter = filterClauses.find(
      (f) => typeof f === "object" && "terms" in f,
    );
    // terms filter may appear for other reasons (personType, dept, grants) but
    // NOT for cwid in the no-topic case.
    if (termsFilter) {
      const termsObj = (termsFilter as Record<string, unknown>).terms;
      expect(termsObj).not.toHaveProperty("cwid");
    }
  });

  it("ignores topic param when empty string", async () => {
    mockSearchClientSearch.mockResolvedValue(EMPTY_OS_RESPONSE);

    await searchPeople({ q: "test", topic: "" });

    // Empty string should not trigger the topic filter
    expect(mockPublicationTopicGroupBy).not.toHaveBeenCalled();
    expect(mockSearchClientSearch).toHaveBeenCalledOnce();
  });
});
