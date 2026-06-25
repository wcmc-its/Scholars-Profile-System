/**
 * Perf / #search-hang — the presentation-only reason aggregation (the SECOND
 * publications-index request that builds the "N publications" reason line) is
 * capped by a per-request wall-time so a broad-concept agg ("Aging" et al.)
 * can't hold the streamed People render past the #1017 nav watchdog. These
 * tests lock the contract:
 *   1. a timeout / transport error on the reason agg degrades gracefully —
 *      `searchPeople` still resolves with its hits (the list paints, the reason
 *      counts are simply absent);
 *   2. the reason-agg request carries `requestTimeout` (+ `maxRetries: 0`), and
 *      `SEARCH_PEOPLE_REASON_AGG_TIMEOUT_MS` overrides the default.
 *
 * Harness mirrors search-people-result-evidence.test.ts (same mock shape); the
 * only additions are the publications-index branch's throw mode and the
 * captured options arg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPubTopicGroupBy,
  mockScholarFamilyFindMany,
  mockTopicFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  reasonAgg,
  capturedReasonOpts,
} = vi.hoisted(() => ({
  mockPubTopicGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  // "throw" → the reason agg rejects (timeout); "buckets" → returns one bucket.
  reasonAgg: { mode: "throw" as "throw" | "buckets" },
  capturedReasonOpts: { value: undefined as unknown },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: mockPubTopicGroupBy },
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    topic: { findMany: mockTopicFindMany },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensSensitiveGateOn: () => false,
  isMethodPagesEnabled: () => true,
  isMethodsLensEnabled: () => true,
  isMethodsFamilyDefinitionsOn: () => false,
}));

const HITS = [
  {
    _source: {
      cwid: "el1",
      slug: "ed-leon",
      preferredName: "Ed Leon",
      primaryTitle: "Professor",
      primaryDepartment: "Medicine",
      deptName: "Medicine",
      divisionName: null,
      personType: "full_time_faculty",
      publicationCount: 200,
      grantCount: 12,
      hasActiveGrants: true,
      areasOfInterest: "mental_health",
    },
    highlight: undefined,
  },
];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10", "overview^2"],
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: Object.freeze(["preferredName^1", "overview^2"]),
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  MESH_ADMIT_WEIGHT: { exact: 3, "anchored-entry": 1.5, entry: 0.7 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
  searchClient: () => ({
    async search(args: { index?: string }, opts?: unknown) {
      // The reason aggregation is a separate `size:0` query against the
      // PUBLICATIONS index; everything else is the people query.
      if (args?.index === "scholars-publications") {
        capturedReasonOpts.value = opts;
        if (reasonAgg.mode === "throw") {
          throw new Error("opensearch request timed out");
        }
        return {
          body: {
            aggregations: {
              byAuthor: {
                buckets: [{ key: "el1", tagged: { d: { value: 5 } }, mention: { d: { value: 0 } } }],
              },
            },
          },
        };
      }
      return {
        body: {
          hits: { total: { value: 1 }, hits: HITS },
          aggregations: {
            deptDivs: { keys: { buckets: [] } },
            personTypes: { keys: { buckets: [] } },
            activityHasGrants: { doc_count: 0 },
            activityRecentPub: { doc_count: 0 },
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

import { searchPeople } from "@/lib/api/search";

beforeEach(() => {
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
  mockScholarFamilyFindMany.mockReset().mockResolvedValue([]);
  mockTopicFindMany.mockReset().mockResolvedValue([]);
  mockSuppressionOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockReset().mockResolvedValue([]);
  capturedReasonOpts.value = undefined;
  reasonAgg.mode = "throw";
  delete process.env.SEARCH_PEOPLE_REASON_AGG_TIMEOUT_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A concept query that routes to the topic template and fires the reason agg.
function runConceptSearch() {
  return searchPeople({
    q: "aging",
    shape: "topic",
    relevanceMode: "v3",
    meshDescendantUis: ["D000375"],
    meshDescriptorName: "Aging",
    matchExplain: true,
  });
}

describe("reason-agg wall-time cap (#search-hang)", () => {
  it("degrades gracefully when the reason agg times out — still returns the hits", async () => {
    reasonAgg.mode = "throw";
    const res = await runConceptSearch();
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].cwid).toBe("el1");
  });

  it("passes a per-request requestTimeout (default 1200ms) + maxRetries:0 to the reason agg", async () => {
    reasonAgg.mode = "buckets";
    await runConceptSearch();
    expect(capturedReasonOpts.value).toMatchObject({ requestTimeout: 1200, maxRetries: 0 });
  });

  it("honors the SEARCH_PEOPLE_REASON_AGG_TIMEOUT_MS override", async () => {
    process.env.SEARCH_PEOPLE_REASON_AGG_TIMEOUT_MS = "500";
    reasonAgg.mode = "buckets";
    await runConceptSearch();
    expect(capturedReasonOpts.value).toMatchObject({ requestTimeout: 500, maxRetries: 0 });
  });
});
