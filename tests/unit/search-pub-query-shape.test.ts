/**
 * Issue #259 §1.2 — structural assertion on the publications-index query.
 *
 * Captures the `body.query` sent to OpenSearch by `searchPublications` and
 * checks the multi_match shape. Flag off: no `minimum_should_match`, no
 * `operator: or`, fields untouched. Flag on: msm is `"-0% 3<-25%"`,
 * operator is `"or"`, fields still untouched (no field-restructure on
 * pub-tab — abstract is per-doc, not a blob).
 *
 * Also asserts the people/pubs msm strings are intentionally identical
 * today so a future divergence is loud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    scholar: {
      findMany: vi.fn().mockResolvedValue([]),
    },
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
}));

const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: [
    "title^4",
    "meshTerms^2",
    "authorNames^2",
    "journal^1",
    "abstract^0.5",
  ],
  PUBLICATIONS_RESTRUCTURED_MSM: "-0% 3<-25%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      return {
        body: {
          hits: { total: { value: 0 }, hits: [] },
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

/**
 * The pub-tab query is a single flat must clause: body.query.bool.must[0].
 * (No CWID short-circuit, unlike the people-tab — pub-tab has nothing to
 * exact-match.)
 */
function multiMatchClause(body: Record<string, unknown>): Record<string, unknown> {
  const q = body.query as Record<string, unknown>;
  const must = (q.bool as { must: Record<string, unknown>[] }).must;
  return must[0];
}

describe("pub-tab query shape — SEARCH_PUB_TAB_MSM", () => {
  const originalEnv = process.env.SEARCH_PUB_TAB_MSM;

  beforeEach(() => {
    capturedBodies.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SEARCH_PUB_TAB_MSM = originalEnv;
  });

  it("flag off (default): multi_match has no minimum_should_match, no operator", async () => {
    delete process.env.SEARCH_PUB_TAB_MSM;
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("legacy_multi_match");
    expect(capturedBodies).toHaveLength(1);

    const clause = multiMatchClause(capturedBodies[0]);
    expect(clause).toHaveProperty("multi_match");
    const mm = clause.multi_match as Record<string, unknown>;
    expect(mm.type).toBe("best_fields");
    expect(mm).not.toHaveProperty("minimum_should_match");
    expect(mm).not.toHaveProperty("operator");
    expect(mm.fields).toEqual([
      "title^4",
      "meshTerms^2",
      "authorNames^2",
      "journal^1",
      "abstract^0.5",
    ]);
  });

  it("flag on: multi_match has msm '-0% 3<-25%', operator 'or', fields unchanged", async () => {
    process.env.SEARCH_PUB_TAB_MSM = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const clause = multiMatchClause(capturedBodies[0]);
    const mm = clause.multi_match as Record<string, unknown>;
    expect(mm.type).toBe("best_fields");
    expect(mm.operator).toBe("or");
    expect(mm.minimum_should_match).toBe("-0% 3<-25%");
    // Fields list is identical — pub-tab does NOT restructure (abstract on
    // the publications index is per-doc, not a concatenated blob).
    expect(mm.fields).toEqual([
      "title^4",
      "meshTerms^2",
      "authorNames^2",
      "journal^1",
      "abstract^0.5",
    ]);
  });

  it("flag on, empty query: skips the multi_match branch entirely (match_all)", async () => {
    process.env.SEARCH_PUB_TAB_MSM = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({ q: "", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const clause = multiMatchClause(capturedBodies[0]);
    expect(clause).toEqual({ match_all: {} });
  });
});

// NOTE: the people/pubs msm parity assertion (PUBLICATIONS_RESTRUCTURED_MSM
// === PEOPLE_RESTRUCTURED_MSM) belongs here but PEOPLE_RESTRUCTURED_MSM is
// added in the §1.1 PR (#260) and doesn't exist on master yet. Add the
// parity test in a follow-up after both branches are integrated.
