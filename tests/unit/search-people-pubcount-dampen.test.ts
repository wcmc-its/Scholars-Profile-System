/**
 * Issue #2068 — `SEARCH_PEOPLE_PUBCOUNT_DAMPEN` body assertions.
 *
 * Master emits ONE unbounded `field_value_factor` on `publicationCount`
 * (`modifier: ln1p`, `factor: 1`, `missing: 0`) inside the outer prominence
 * `function_score` (`score_mode: sum`, `boost_mode: multiply`) — contract
 * `docs/search-relevance-contract.md` open violation O3: a query-independent prior
 * with no stated ceiling. With the lever set to `capped`, the topic, hybrid and
 * `unclassified` shapes swap it for the exact-ceiling step ladder
 * `PEOPLE_PROMINENCE_PUBCOUNT_BANDS` (max `PEOPLE_PROMINENCE_PUBCOUNT_CEILING`).
 * THREE shapes, not two — `applyTopicTemplate` is `shape === "topic" || shape ===
 * "unclassified"`, and `unclassified` is the classifier's catch-all fallback.
 *
 * The lever is an `opts` field (`pubCountDampen`) resolved AT THE CALLER, exactly like
 * `facultyProminence` / `grantProminence`, falling back to
 * `resolveSearchPeoplePubCountDampen()` when absent — so the Matcha spine can pin it
 * `off` rather than inherit a /search A/B. The last describe block covers that.
 *
 * The three invariants this file exists to defend:
 *
 *  1. **OFF is byte-identical.** Flag off — or on but on a name/department shape —
 *     the prominence functions array must deep-equal master's, in order, with no
 *     extra keys and no empty-array spread artifacts.
 *  2. **Ordering only.** `publicationCount` never enters admission: the whole body
 *     minus the outer `functions` array is identical between the two modes, and the
 *     innermost matched bool mentions `publicationCount` nowhere. A `function_score`
 *     function scores documents the query already matched, so `total` and every
 *     facet bucket count are unchanged.
 *  3. **The caller wins over the env.** An explicit `pubCountDampen` overrides the
 *     environment in BOTH directions, and the spine's own opts produce master's body
 *     even with the env set to `capped`.
 *
 * `@/lib/search` is only PARTIALLY mocked (real constants via `importOriginal`, only
 * the client replaced) so the emitted ladder is asserted against the SHIPPED band
 * table, not against a copy of it maintained in this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { groupByMock, capturedBodies } = vi.hoisted(() => ({
  groupByMock: vi.fn(),
  capturedBodies: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>();
  return {
    ...actual,
    searchClient: () => ({
      async search(req: { body: Record<string, unknown> }) {
        capturedBodies.push(req.body);
        const aggs = req.body.aggs as { byAuthor?: unknown } | undefined;
        if (aggs && "byAuthor" in aggs) {
          return { body: { aggregations: { byAuthor: { buckets: [] } } } };
        }
        return {
          body: {
            hits: { total: { value: 1 }, hits: [] },
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
  };
});

import { searchPeople } from "@/lib/api/search";
import {
  PEOPLE_PROMINENCE_PUBCOUNT_BANDS as BANDS,
  PEOPLE_PROMINENCE_PUBCOUNT_CEILING as CEILING,
} from "@/lib/search";

type FnScore = {
  query: Record<string, unknown>;
  functions: Array<Record<string, unknown>>;
  score_mode: string;
  boost_mode: string;
};

function outerFnScore(body: Record<string, unknown>): FnScore {
  const fs = (body.query as { function_score?: FnScore }).function_score;
  expect(fs).toBeDefined();
  return fs!;
}

/** The innermost matched bool — the ADMISSION predicate, under every scoring wrapper. */
function admissionBool(body: Record<string, unknown>): Record<string, unknown> {
  let node = body.query as Record<string, unknown>;
  while (node && typeof node === "object" && "function_score" in node) {
    node = (node.function_score as { query: Record<string, unknown> }).query;
  }
  expect(node).toHaveProperty("bool");
  return node;
}

/** Exactly what master emits for the volume prior — hardcoded, not derived from source. */
const MASTER_PUBCOUNT_FUNCTION = {
  field_value_factor: {
    field: "publicationCount",
    modifier: "ln1p",
    factor: 1,
    missing: 0,
  },
};

/** Master's full prominence array, in order, for a default (no-lever-off) call. */
const MASTER_PROMINENCE_FUNCTIONS = [
  { weight: 1.0 },
  MASTER_PUBCOUNT_FUNCTION,
  { filter: { term: { personType: "full_time_faculty" } }, weight: 1.0 },
  { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
];

/** The ladder clauses the shipped band table must produce, in table order. */
const EXPECTED_LADDER_FUNCTIONS = BANDS.map((b) => ({
  filter: {
    range: {
      publicationCount: b.lt === undefined ? { gte: b.gte } : { gte: b.gte, lt: b.lt },
    },
  },
  weight: b.weight,
}));

const TOPIC_CALL = {
  q: "cancer",
  relevanceMode: "v3" as const,
  shape: "topic" as const,
  meshDescendantUis: ["D009369"],
};

beforeEach(() => {
  capturedBodies.length = 0;
  groupByMock.mockResolvedValue([]);
  delete process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN;
});

afterEach(() => {
  delete process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("#2068 — flag OFF is byte-identical to master", () => {
  for (const value of [undefined, "off", "", "capped ", "CAPPED", "on", "true", "1"]) {
    it(`SEARCH_PEOPLE_PUBCOUNT_DAMPEN=${JSON.stringify(value)} emits master's prominence array`, async () => {
      if (value === undefined) delete process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN;
      else process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = value;

      await searchPeople({ ...TOPIC_CALL });
      const fs = outerFnScore(capturedBodies[0]);
      expect(fs.score_mode).toBe("sum");
      expect(fs.boost_mode).toBe("multiply");
      // Exact array, in order: no extra keys, no empty-array spread artifacts.
      expect(fs.functions).toEqual(MASTER_PROMINENCE_FUNCTIONS);
    });
  }

  it("emits no range clause on publicationCount in the OUTER prominence functions", async () => {
    await searchPeople({ ...TOPIC_CALL });
    const fs = outerFnScore(capturedBodies[0]);
    expect(fs.functions.some((f) => "filter" in f && "range" in (f.filter as object))).toBe(false);
  });
});

describe("#2068 — flag CAPPED swaps the factor for the ladder (topic + hybrid)", () => {
  beforeEach(() => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
  });

  it("topic shape emits the ladder in place of the ln1p factor, priors intact", async () => {
    await searchPeople({ ...TOPIC_CALL });
    const fs = outerFnScore(capturedBodies[0]);
    expect(fs.functions).toEqual([
      { weight: 1.0 },
      ...EXPECTED_LADDER_FUNCTIONS,
      { filter: { term: { personType: "full_time_faculty" } }, weight: 1.0 },
      { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
    ]);
    // The unbounded factor is GONE — not merely joined by the ladder.
    expect(fs.functions).not.toContainEqual(MASTER_PUBCOUNT_FUNCTION);
    expect(fs.score_mode).toBe("sum");
    expect(fs.boost_mode).toBe("multiply");
  });

  it("hybrid shape emits the ladder too", async () => {
    await searchPeople({ q: "cantley ras", relevanceMode: "v3", shape: "hybrid" });
    const fs = outerFnScore(capturedBodies[0]);
    expect(fs.functions).toEqual([
      { weight: 1.0 },
      ...EXPECTED_LADDER_FUNCTIONS,
      { filter: { term: { personType: "full_time_faculty" } }, weight: 1.0 },
      { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
    ]);
  });

  // THREE shapes, not two. `applyTopicTemplate` is `shape === "topic" || shape ===
  // "unclassified"`, and `unclassified` is the People classifier's catch-all fallback — so
  // it shares the topic template and is inside the ladder's gate. A doc that says
  // "topic/hybrid" understates the lever's reach by a whole shape.
  it("unclassified shape emits the ladder too (it shares the topic template)", async () => {
    await searchPeople({ q: "crispr screens 2019", relevanceMode: "v3", shape: "unclassified" });
    const fs = outerFnScore(capturedBodies[0]);
    expect(fs.functions).toEqual([
      { weight: 1.0 },
      ...EXPECTED_LADDER_FUNCTIONS,
      { filter: { term: { personType: "full_time_faculty" } }, weight: 1.0 },
      { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
    ]);
    expect(fs.functions).not.toContainEqual(MASTER_PUBCOUNT_FUNCTION);
  });

  it("no emitted band weight exceeds the declared ceiling", async () => {
    await searchPeople({ ...TOPIC_CALL });
    const weights = outerFnScore(capturedBodies[0])
      .functions.filter((f) => "filter" in f && "range" in (f.filter as object))
      .map((f) => f.weight as number);
    expect(weights).toHaveLength(BANDS.length);
    expect(Math.max(...weights)).toBe(CEILING);
    expect(Math.max(...weights)).toBe(3.0);
  });

  it("still drops the faculty term when that lever is off (levers compose)", async () => {
    await searchPeople({ ...TOPIC_CALL, facultyProminence: false });
    const fs = outerFnScore(capturedBodies[0]);
    expect(fs.functions).toEqual([
      { weight: 1.0 },
      ...EXPECTED_LADDER_FUNCTIONS,
      { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
    ]);
  });
});

describe("#2068 — CAPPED is gated to topic/hybrid; name + department keep master's body", () => {
  beforeEach(() => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
  });

  it("name shape is byte-identical to master", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "v3", shape: "name" });
    expect(outerFnScore(capturedBodies[0]).functions).toEqual(MASTER_PROMINENCE_FUNCTIONS);
  });

  it("department shape is byte-identical to master", async () => {
    await searchPeople({ q: "cardiology", relevanceMode: "v3", shape: "department" });
    expect(outerFnScore(capturedBodies[0]).functions).toEqual(MASTER_PROMINENCE_FUNCTIONS);
  });

  it("legacy mode applies no prominence wrapper at all", async () => {
    await searchPeople({ q: "cancer", relevanceMode: "legacy", shape: "topic" });
    expect(capturedBodies[0].query).not.toHaveProperty("function_score");
    expect(capturedBodies[0].query).toHaveProperty("bool");
  });
});

describe("#2068 — ORDERING ONLY: admission and facets are untouched", () => {
  it("the whole body minus the prominence functions is identical in both modes", async () => {
    // The recency filter is `now - 2y`, so the two builds must see one clock —
    // otherwise a 1 ms gap between them shows up as a body difference.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));

    delete process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN;
    await searchPeople({ ...TOPIC_CALL });
    const off = structuredClone(capturedBodies[0]);

    capturedBodies.length = 0;
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
    await searchPeople({ ...TOPIC_CALL });
    const on = structuredClone(capturedBodies[0]);
    vi.useRealTimers();

    // Same number of round trips, same aggregation requests → same facet counts.
    const strip = (b: Record<string, unknown>) => {
      const clone = structuredClone(b);
      const fs = (clone.query as { function_score?: { functions?: unknown } }).function_score;
      if (fs) delete fs.functions;
      return clone;
    };
    expect(strip(on)).toEqual(strip(off));
    // Sanity: the two bodies DID differ before the functions array was stripped.
    expect(on).not.toEqual(off);
  });

  it("publicationCount appears in no admission predicate (must / filter / post_filter)", async () => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
    await searchPeople({ ...TOPIC_CALL });
    const body = capturedBodies[0];
    expect(JSON.stringify(admissionBool(body))).not.toContain("publicationCount");
    expect(body.post_filter).toBeUndefined();
  });

  it("the ladder clauses land in the OUTER prominence functions, nowhere else", async () => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
    await searchPeople({ ...TOPIC_CALL });
    const fs = outerFnScore(capturedBodies[0]);
    for (const clause of EXPECTED_LADDER_FUNCTIONS) {
      expect(fs.functions).toContainEqual(clause);
    }
    // The inner (topic multiplicative) layer is untouched by the swap.
    const inner = (fs.query as { function_score?: FnScore }).function_score;
    expect(inner?.score_mode).toBe("multiply");
  });
});

describe("#2068 — `pubCountDampen` is a CALLER opt; the env is only the fallback", () => {
  // The whole point of the opt. `facultyProminence` and `grantProminence` are resolved at
  // the caller precisely so a non-/search consumer can override them, and the Matcha spine
  // does exactly that. Reading the volume lever from `process.env` INSIDE `searchPeople`
  // would have given the spine no way out of a /search A/B.

  it("an explicit 'off' opt beats env=capped (the spine's posture)", async () => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
    await searchPeople({ ...TOPIC_CALL, pubCountDampen: "off" });
    expect(outerFnScore(capturedBodies[0]).functions).toEqual(MASTER_PROMINENCE_FUNCTIONS);
  });

  it("an explicit 'capped' opt beats an unset/off env", async () => {
    delete process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN;
    await searchPeople({ ...TOPIC_CALL, pubCountDampen: "capped" });
    expect(outerFnScore(capturedBodies[0]).functions).toEqual([
      { weight: 1.0 },
      ...EXPECTED_LADDER_FUNCTIONS,
      { filter: { term: { personType: "full_time_faculty" } }, weight: 1.0 },
      { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
    ]);

    capturedBodies.length = 0;
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "off";
    await searchPeople({ ...TOPIC_CALL, pubCountDampen: "capped" });
    expect(
      outerFnScore(capturedBodies[0]).functions.filter(
        (f) => "filter" in f && "range" in (f.filter as object),
      ),
    ).toHaveLength(BANDS.length);
  });

  it("an ABSENT opt still consults the env (headless callers keep today's behavior)", async () => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
    await searchPeople({ ...TOPIC_CALL });
    expect(outerFnScore(capturedBodies[0]).functions).not.toContainEqual(MASTER_PUBCOUNT_FUNCTION);
  });

  it("THE SPINE'S OWN OPTS produce master's body even when the env says capped", async () => {
    // The whole-body comparison at the end of this test is byte-exact, and the
    // `activityRecentPub` agg embeds a `Date.now()`-derived `gte`. The two calls
    // below are built a moment apart, so on a millisecond boundary the bodies
    // differ by 1ms in that one field and the assertion fails — ~1 run in 15.
    // Freeze the clock for the duration. `toFake: ["Date"]` only: faking timers
    // wholesale would stall the awaited promises.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Exactly the three prominence opts `matcha-spine-run.ts` `retrieveCluster` passes,
      // on the shape it passes (`topic`, which IS inside the ladder's gate). With both
      // employment priors off the spine's entire outer multiplier is `1 + volume`, so the
      // ladder's proportional effect there is LARGER than on /search — this must not move.
      process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
      await searchPeople({
        ...TOPIC_CALL,
        facultyProminence: false,
        grantProminence: false,
        pubCountDampen: "off",
      });
      const capped = structuredClone(capturedBodies[0]);

      capturedBodies.length = 0;
      delete process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN;
      await searchPeople({
        ...TOPIC_CALL,
        facultyProminence: false,
        grantProminence: false,
        pubCountDampen: "off",
      });
      const off = structuredClone(capturedBodies[0]);

      // The spine's body is exactly BASE + the unbounded factor, in both env postures.
      expect(outerFnScore(capped).functions).toEqual([{ weight: 1.0 }, MASTER_PUBCOUNT_FUNCTION]);
      expect(outerFnScore(off).functions).toEqual(outerFnScore(capped).functions);
      expect(JSON.stringify(capped)).toBe(JSON.stringify(off));
    } finally {
      vi.useRealTimers();
    }
  });
});
