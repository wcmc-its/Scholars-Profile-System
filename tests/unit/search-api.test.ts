import { describe, expect, it, vi } from "vitest";
import { EXPECTED_HEADSHOT_URL, FIXTURE_CWID } from "../fixtures/scholar";

// lib/api/search.ts imports @/lib/db for the topic pre-filter (Phase 3 D-10).
// Mock it out so tests that don't exercise the topic path still work.
vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Mock the OpenSearch wrapper module so the hit mapper runs over a fixture.
// lib/api/search.ts imports `searchClient`, `PEOPLE_INDEX`, `PEOPLE_FIELD_BOOSTS`,
// `PUBLICATIONS_INDEX`, `PUBLICATION_FIELD_BOOSTS` from @/lib/search.
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_RESTRUCTURED_MSM: "3<-25%",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "3<-25%",
  searchClient: () => ({
    async search() {
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
                  primaryTitle: "Associate Professor",
                  primaryDepartment: "Medicine",
                  deptName: "Medicine",
                  divisionName: null,
                  personType: "full_time_faculty",
                  publicationCount: 12,
                  grantCount: 1,
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
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

describe("search hit mapper (PeopleHit)", () => {
  it("each hit includes identityImageEndpoint computed from CWID", async () => {
    const mod: Record<string, unknown> = await import("@/lib/api/search");
    // Use the existing public people-search function name; Wave 1 must not
    // rename it. Current export is `searchPeople`.
    const fn =
      (mod as { searchPeople?: (opts: unknown) => Promise<unknown> }).searchPeople ??
      (mod as { peopleSearch?: (opts: unknown) => Promise<unknown> }).peopleSearch ??
      (mod as { search?: (opts: unknown) => Promise<unknown> }).search;
    expect(fn, "search module must export a public people-search function").toBeTruthy();
    const result = (await fn!({ q: "doe", page: 0 })) as {
      hits: Array<{ identityImageEndpoint?: string }>;
    };
    expect(result.hits[0].identityImageEndpoint).toBe(EXPECTED_HEADSHOT_URL);
  });
});
