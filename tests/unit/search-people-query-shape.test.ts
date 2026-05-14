/**
 * Issue #259 §1.1 — structural assertion on the people-index query body.
 *
 * Captures the `body.query` sent to OpenSearch and checks shape, not
 * behavior. With the flag off, the existing flat multi_match shape must
 * be preserved bit-for-bit. With the flag on, the multimatch branch must
 * become a bool with:
 *   - must: [multi_match over high-evidence fields, msm "2<-34%"]
 *   - should: [match on publicationAbstracts with boost 0.3]
 * and `publicationAbstracts` must NOT appear in the must clause's fields.
 *
 * This guards against accidental shape drift — e.g. someone re-adding
 * abstracts to the must list "for completeness" and silently defeating
 * msm. The msm-parser test covers semantics; this one covers placement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Capture the query body across calls so each test can inspect what was sent.
const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: [
    "preferredName^10",
    "fullName^10",
    "areasOfInterest^6",
    "primaryTitle^4",
    "primaryDepartment^3",
    "overview^2",
    "publicationTitles^1",
    "publicationMesh^0.5",
    "publicationAbstracts^0.3",
  ],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^10",
    "fullName^10",
    "areasOfInterest^6",
    "primaryTitle^4",
    "primaryDepartment^3",
    "overview^2",
    "publicationTitles^1",
    "publicationMesh^0.5",
  ],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
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

/**
 * Helper: walk the captured request body to the inner query branch the
 * multimatch lives in. Path is stable: bool.must[0].bool.should[1].
 * Index 0 is the CWID term boost; index 1 is the multimatch branch.
 */
function multiMatchBranch(body: Record<string, unknown>): Record<string, unknown> {
  const q = body.query as Record<string, unknown>;
  const must = (q.bool as { must: Record<string, unknown>[] }).must;
  const innerBool = (must[0].bool as { should: Record<string, unknown>[] }).should;
  return innerBool[1] as Record<string, unknown>;
}

describe("people-index query shape — SEARCH_PEOPLE_QUERY_RESTRUCTURE", () => {
  const originalEnv = process.env.SEARCH_PEOPLE_QUERY_RESTRUCTURE;

  beforeEach(() => {
    capturedBodies.length = 0;
    // Force re-import on each test so the env-read in searchPeople reflects
    // whatever the test set. Module cache lives outside vi.mock.
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SEARCH_PEOPLE_QUERY_RESTRUCTURE = originalEnv;
  });

  it("flag explicitly off: emits a flat multi_match over all 9 PEOPLE_FIELD_BOOSTS", async () => {
    // Default flipped on in this PR; explicit "off" exercises the legacy
    // emergency-rollback path.
    process.env.SEARCH_PEOPLE_QUERY_RESTRUCTURE = "off";
    const mod = (await import("@/lib/api/search")) as {
      searchPeople: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPeople({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("legacy_multi_match");
    expect(capturedBodies).toHaveLength(1);

    const branch = multiMatchBranch(capturedBodies[0]);
    expect(branch).toHaveProperty("multi_match");
    const mm = branch.multi_match as { fields: string[]; type: string };
    expect(mm.type).toBe("best_fields");
    expect(mm.fields).toContain("publicationAbstracts^0.3");
    expect(mm.fields).toHaveLength(9);
  });

  it("flag on: emits bool { must: [multi_match w/ msm], should: [abstracts] }", async () => {
    process.env.SEARCH_PEOPLE_QUERY_RESTRUCTURE = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPeople: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPeople({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const branch = multiMatchBranch(capturedBodies[0]);
    expect(branch).toHaveProperty("bool");
    const innerBool = branch.bool as {
      must: Record<string, unknown>[];
      should: Record<string, unknown>[];
    };

    // must: multi_match over high-evidence fields with msm. Abstracts MUST NOT appear here.
    expect(innerBool.must).toHaveLength(1);
    const mm = (innerBool.must[0] as { multi_match: Record<string, unknown> }).multi_match;
    // cross_fields (not best_fields) per the v2.2 spec correction — concept
    // queries want field-blended matching, not single-best-field scoring.
    expect(mm.type).toBe("cross_fields");
    // operator:or with msm (not operator:and) because OpenSearch ignores
    // msm under operator:and, and the §1.1 msm table is the contract.
    expect(mm.operator).toBe("or");
    expect(mm.minimum_should_match).toBe("2<-34%");
    expect(mm.fields).not.toContain("publicationAbstracts^0.3");
    const fieldNames = (mm.fields as string[]).map((f) => f.split("^")[0]);
    expect(fieldNames).not.toContain("publicationAbstracts");

    // should: scoring-only match on publicationAbstracts with boost 0.3.
    expect(innerBool.should).toHaveLength(1);
    const should = innerBool.should[0] as { match: { publicationAbstracts: { query: string; boost: number } } };
    expect(should.match.publicationAbstracts.query).toBe("electronic health records");
    expect(should.match.publicationAbstracts.boost).toBe(0.3);
  });

  it("flag on, empty query: skips the multi_match branch entirely (match_all)", async () => {
    process.env.SEARCH_PEOPLE_QUERY_RESTRUCTURE = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPeople: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPeople({ q: "", page: 0 });

    // queryShape still reflects the flag, even when no query body is built.
    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const q = capturedBodies[0].query as Record<string, unknown>;
    const must = (q.bool as { must: Record<string, unknown>[] }).must;
    // Empty trimmed query → match_all branch, no restructured bool to inspect.
    expect(must[0]).toEqual({ match_all: {} });
  });
});
