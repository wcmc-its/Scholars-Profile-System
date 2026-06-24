/**
 * #1269 — People-tab method-family TIER boost. When
 * `SEARCH_PEOPLE_METHOD_FAMILY_TIER=on` and the query resolved to a single
 * method family (carried in `matchAwareContext.methodFamily`), the topic-shape
 * function_score gains a multiplicative `match_phrase { methodFamily }` factor
 * weighted by `PEOPLE_METHOD_FAMILY_TAG_WEIGHT`, so an explicitly method-tagged
 * scholar outranks a keyword/MeSH-only match. Flag-OFF (or no resolved family)
 * ⇒ the factor is absent and the body is unchanged. Body-shape assertion, same
 * capture pattern as search-people-topic-template.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10", "publicationAbstracts^0.3"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^10",
    "fullName^10",
    "areasOfInterest^6",
    "publicationTitles^1",
    "publicationMesh^0.5",
  ],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: Object.freeze([
    "preferredName^1",
    "publicationTitles^6",
    "publicationMesh^4",
  ]),
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
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
  // #1269 — the constant under test.
  PEOPLE_METHOD_FAMILY_TAG_WEIGHT: 2.0,
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
                  cwid: FIXTURE_CWID,
                  slug: "jane-doe",
                  preferredName: "Jane Doe",
                  primaryTitle: "Professor",
                  primaryDepartment: "Medicine",
                  deptName: "Medicine",
                  divisionName: null,
                  personType: "full_time_faculty",
                  publicationCount: 40,
                  grantCount: 2,
                  hasActiveGrants: true,
                },
                highlight: undefined,
              },
            ],
          },
          aggregations: {
            deptDivs: { keys: { buckets: [] } },
            personTypes: { keys: { buckets: [] } },
            activityHasGrants: { doc_count: 0 },
            activityRecentPub: { doc_count: 0 },
            attributionMatch: { doc_count: 1 },
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

const FAMILY = { supercategory: "genomics_sequencing", familyLabel: "Spatial transcriptomics" };
const TIER_FN = {
  filter: { match_phrase: { methodFamily: "Spatial transcriptomics" } },
  weight: 2.0,
};

/** Drill to the INNER topic function_score (outer is the prominence factor). */
function innerFunctions(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const outer = (body.query as { function_score: { query: Record<string, unknown> } }).function_score;
  return (outer.query as { function_score: { functions: Array<Record<string, unknown>> } })
    .function_score.functions;
}

describe("#1269 people method-family tier boost", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.SEARCH_PEOPLE_METHOD_FAMILY_TIER;
    vi.clearAllMocks();
  });

  it("flag ON + resolved family → multiplicative match_phrase factor present", async () => {
    process.env.SEARCH_PEOPLE_METHOD_FAMILY_TIER = "on";
    await searchPeople({
      q: "spatial transcriptomics",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(innerFunctions(capturedBodies[0])).toContainEqual(TIER_FN);
  });

  it("flag OFF → factor absent (body unchanged)", async () => {
    await searchPeople({
      q: "spatial transcriptomics",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(innerFunctions(capturedBodies[0])).not.toContainEqual(TIER_FN);
  });

  it("flag ON but query did not resolve to a family → factor absent", async () => {
    process.env.SEARCH_PEOPLE_METHOD_FAMILY_TIER = "on";
    await searchPeople({
      q: "spatial transcriptomics",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: null, topics: [] },
    });
    expect(innerFunctions(capturedBodies[0])).not.toContainEqual(TIER_FN);
  });
});
