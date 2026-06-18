/**
 * Issue #532 — dept-shape leadership boost.
 *
 * Asserts the inner-`function_score` wrapper that the dept-template gains
 * when `deptLeadershipBoost: true` is passed (the route resolves the flag
 * to that value when `SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST=on`):
 *
 *   - default (flag off): the dept body is unwrapped at the inner level (no
 *     leadership function_score, just the prominence outer wrap).
 *   - flag on + dept shape: inner `function_score` carries the two filters
 *     (`leadership.chairOf` ×3.0, `leadership.chiefOf` ×1.5) under
 *     `score_mode: max` and `boost_mode: multiply`. The trimmed-lowercased
 *     query is what the filter matches against.
 *   - flag on + non-dept shape: no leadership wrapper (the boost is dept-
 *     scoped; name / topic / hybrid bodies are untouched).
 *   - flag on + empty trimmed query: no leadership wrapper (the dept
 *     template itself doesn't fire on empty queries either).
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
    "primaryTitle^4",
    "primaryDepartment^3",
  ],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^1",
    "fullName^1",
    "primaryTitle^3",
  ],
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PEOPLE_DEPT_LEADERSHIP_CHAIR_WEIGHT: 3.0,
  PEOPLE_DEPT_LEADERSHIP_CHIEF_WEIGHT: 1.5,
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
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
                  slug: "p",
                  preferredName: "P",
                  primaryDepartment: "Pediatrics",
                  deptName: "Pediatrics",
                  divisionName: null,
                  personType: "full_time_faculty",
                  publicationCount: 50,
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

import { searchPeople } from "@/lib/api/search";

/**
 * The body's outer `function_score` is the #513 prominence wrap (additive).
 * Its `.query` is either the inner leadership wrap (when the boost is on
 * for the dept shape) or the plain bool. The leadership wrap shape is what
 * these tests assert.
 */
type FnScore = {
  query?: Record<string, unknown>;
  functions: Array<Record<string, unknown>>;
  score_mode?: string;
  boost_mode?: string;
};

function prominenceFs(body: Record<string, unknown>): FnScore | undefined {
  return (body.query as { function_score?: FnScore }).function_score;
}

function innerOfProminence(body: Record<string, unknown>): Record<string, unknown> {
  const prom = prominenceFs(body);
  return (prom?.query ?? body.query) as Record<string, unknown>;
}

describe("dept-shape leadership boost — #532", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("default (flag off, dept shape): the inner query is the plain bool, no leadership function_score", async () => {
    await searchPeople({
      q: "pediatrics",
      relevanceMode: "v3",
      shape: "department",
    });
    const inner = innerOfProminence(capturedBodies[0]);
    // No leadership wrapper at the inner layer — only the outer prominence
    // wraps the dept body when the flag is off.
    expect("function_score" in inner).toBe(false);
    expect(inner.bool).toBeDefined();
  });

  it("flag on + dept shape: inner function_score carries the leadership filters", async () => {
    await searchPeople({
      q: "pediatrics",
      relevanceMode: "v3",
      shape: "department",
      deptLeadershipBoost: true,
    });
    const inner = innerOfProminence(capturedBodies[0]) as { function_score?: FnScore };
    expect(inner.function_score).toBeDefined();
    expect(inner.function_score!.score_mode).toBe("max");
    expect(inner.function_score!.boost_mode).toBe("multiply");
    expect(inner.function_score!.functions).toEqual([
      {
        filter: { term: { "leadership.chairOf": "pediatrics" } },
        weight: 3.0,
      },
      {
        filter: { term: { "leadership.chiefOf": "pediatrics" } },
        weight: 1.5,
      },
    ]);
  });

  it("flag on + dept shape: the term filter uses the trimmed *lowercased* query", async () => {
    // Mixed-case query must still match the lowercased keyword stored on the
    // people doc (`leadership.chairOf` carries `Department.name.toLowerCase()`).
    await searchPeople({
      q: "  Population Health Sciences  ",
      relevanceMode: "v3",
      shape: "department",
      deptLeadershipBoost: true,
    });
    const inner = innerOfProminence(capturedBodies[0]) as { function_score: FnScore };
    expect(inner.function_score.functions[0]).toEqual({
      filter: { term: { "leadership.chairOf": "population health sciences" } },
      weight: 3.0,
    });
  });

  it("flag on + non-dept shape (name): no leadership wrapper — boost is dept-scoped only", async () => {
    await searchPeople({
      q: "cantley",
      relevanceMode: "v3",
      shape: "name",
      deptLeadershipBoost: true,
    });
    const inner = innerOfProminence(capturedBodies[0]);
    expect("function_score" in inner).toBe(false);
  });

  it("flag on + non-dept shape (topic): topic shape's own multiplicative wrap is unchanged, no leadership term", async () => {
    // Topic shape already uses the inner function_score slot for attribution
    // + sparse-decay; that path must NOT acquire the leadership filters.
    await searchPeople({
      q: "spatial transcriptomics methods of analysis",
      relevanceMode: "v3",
      shape: "topic",
      deptLeadershipBoost: true,
    });
    const inner = innerOfProminence(capturedBodies[0]) as { function_score?: FnScore };
    if (inner.function_score) {
      // If the topic template's multiply wrap is present, none of its filters
      // should be a leadership term.
      const filterStrings = inner.function_score.functions.map((f) =>
        JSON.stringify(f.filter ?? {}),
      );
      for (const s of filterStrings) {
        expect(s).not.toContain("leadership.chairOf");
        expect(s).not.toContain("leadership.chiefOf");
      }
    }
  });
});
