/**
 * #2215 — typo-tolerant zero-result fallback (`SEARCH_TYPO_FALLBACK`).
 *
 * Two layers:
 *   1. The pure helpers in `lib/api/search-typo-fallback.ts` (eligibility, the
 *      fuzzy clause, the run-primary-then-maybe-fuzzy control flow).
 *   2. `searchPeople` / `searchPublications` against a mocked OpenSearch client
 *      that returns ZERO for any exact body and N hits for a fuzzy one, asserting
 *      the request bodies actually sent:
 *        - opt absent (flag off)          → one request, nothing fuzzy;
 *        - opt on + non-zero primary      → one request, byte-identical to the
 *                                           flag-off body;
 *        - opt on + zero primary          → a second request carrying the fuzzy
 *                                           clause; result marked `typoFallback`;
 *        - cwid shape / MeSH concept      → never falls back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTypoFuzzyClause,
  isTypoFallbackEligible,
  PEOPLE_TYPO_FALLBACK_FIELDS,
  PUBLICATION_TYPO_FALLBACK_FIELDS,
  TYPO_FUZZY_PARAMS,
  withTypoFallback,
} from "@/lib/api/search-typo-fallback";
import { resolveSearchTypoFallback } from "@/lib/api/search-flags";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

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
  EMPTY_MENTORING_BUCKETS: {
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  },
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
}));

const capturedBodies: Array<Record<string, unknown>> = [];
/** Total the mock reports for an EXACT (non-fuzzy) body. Fuzzy bodies get `fuzzyTotal`. */
let exactTotal = 0;
let fuzzyTotal = 3;

const isFuzzy = (body: unknown) => JSON.stringify(body).includes('"fuzziness"');

// Real field constants (so the bodies are the production shapes); only the
// client is faked.
vi.mock("@/lib/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/search")>()),
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      const total = isFuzzy(req.body) ? fuzzyTotal : exactTotal;
      return {
        body: {
          hits: { total: { value: total }, hits: [] },
          aggregations: {},
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

const ENV_KEYS = [
  "SEARCH_TYPO_FALLBACK",
  "SEARCH_PUB_RELEVANCE_RECENCY",
  "SEARCH_PUB_FACET_SPLIT",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  capturedBodies.length = 0;
  exactTotal = 0;
  fuzzyTotal = 3;
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  delete process.env.SEARCH_TYPO_FALLBACK;
  // Recency / facet split are orthogonal to the fallback; pin both off so each
  // search is exactly one request.
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
  process.env.SEARCH_PUB_FACET_SPLIT = "off";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Every `multi_match` object anywhere in a body. */
function multiMatches(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) for (const n of node) multiMatches(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "multi_match") out.push(v as Record<string, unknown>);
      multiMatches(v, out);
    }
  }
  return out;
}

describe("resolveSearchTypoFallback", () => {
  it("is off unless the env is exactly 'on'", () => {
    expect(resolveSearchTypoFallback()).toBe(false);
    process.env.SEARCH_TYPO_FALLBACK = "off";
    expect(resolveSearchTypoFallback()).toBe(false);
    process.env.SEARCH_TYPO_FALLBACK = "ON";
    expect(resolveSearchTypoFallback()).toBe(false);
    process.env.SEARCH_TYPO_FALLBACK = "on";
    expect(resolveSearchTypoFallback()).toBe(true);
  });
});

describe("isTypoFallbackEligible", () => {
  it.each([
    ["oncolgy", true],
    ["Harrigton", true],
    ["  cardiolgy heart  ", true],
    ["onc", true],
    ["", false],
    ["   ", false],
    // AUTO never fuzzes ≤ 2-char terms, so a retry would re-run the zero.
    ["ab cd", false],
    // Bare identifiers: fuzzing resolves to a different record.
    ["12345678", false],
    ["abc2001", false],
    ["PMC1234567", false],
    ["10.1000/xyz123", false],
    // A pasted paragraph is not a typo.
    ["one two three four five six seven", false],
  ])("%j → %s", (q, expected) => {
    expect(isTypoFallbackEligible(q)).toBe(expected);
  });
});

describe("buildTypoFuzzyClause", () => {
  it("is a best_fields AND multi_match with bounded AUTO fuzziness", () => {
    expect(buildTypoFuzzyClause("oncolgy", ["title^4"])).toEqual({
      multi_match: {
        query: "oncolgy",
        fields: ["title^4"],
        type: "best_fields",
        operator: "and",
        fuzziness: "AUTO",
        prefix_length: 1,
        max_expansions: 25,
        fuzzy_transpositions: true,
      },
    });
  });

  it("never fuzzes keyword id fields or long prose", () => {
    for (const f of [...PEOPLE_TYPO_FALLBACK_FIELDS, ...PUBLICATION_TYPO_FALLBACK_FIELDS]) {
      expect(f).not.toMatch(/^(cwid|pmid|doi|pmcid|meshDescriptorUi|overview|publicationAbstracts|abstract)\b/);
    }
  });
});

describe("withTypoFallback", () => {
  const r = (total: number) => ({ total, tag: total });

  it("disabled → primary only, same object", async () => {
    const primary = r(0);
    const fuzzy = vi.fn(async () => r(5));
    const out = await withTypoFallback({
      enabled: false,
      q: "oncolgy",
      corpus: "people",
      primary: async () => primary,
      fuzzy,
    });
    expect(out).toBe(primary);
    expect(fuzzy).not.toHaveBeenCalled();
  });

  it("non-zero primary → no retry, same object", async () => {
    const primary = r(7);
    const fuzzy = vi.fn(async () => r(5));
    const out = await withTypoFallback({
      enabled: true,
      q: "oncology",
      corpus: "people",
      primary: async () => primary,
      fuzzy,
    });
    expect(out).toBe(primary);
    expect(fuzzy).not.toHaveBeenCalled();
  });

  it("zero primary → serves the fuzzy result, marked", async () => {
    const out = await withTypoFallback({
      enabled: true,
      q: "oncolgy",
      corpus: "people",
      primary: async () => r(0),
      fuzzy: async () => r(5),
    });
    expect(out).toEqual({ total: 5, tag: 5, typoFallback: true });
  });

  it("zero primary, zero fuzzy → the primary zero, unmarked", async () => {
    const primary = r(0);
    const out = await withTypoFallback({
      enabled: true,
      q: "zzzqqq",
      corpus: "people",
      primary: async () => primary,
      fuzzy: async () => r(0),
    });
    expect(out).toBe(primary);
  });

  it("ineligible query → no retry", async () => {
    const fuzzy = vi.fn(async () => r(5));
    await withTypoFallback({
      enabled: true,
      q: "abc2001",
      corpus: "people",
      primary: async () => r(0),
      fuzzy,
    });
    expect(fuzzy).not.toHaveBeenCalled();
  });

  it("a failing retry degrades to the primary zero", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const primary = r(0);
    const out = await withTypoFallback({
      enabled: true,
      q: "oncolgy",
      corpus: "publications",
      primary: async () => primary,
      fuzzy: async () => {
        throw new Error("too_many_clauses");
      },
    });
    expect(out).toBe(primary);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("search_typo_fallback_failed"));
    err.mockRestore();
  });
});

describe("searchPeople — #2215 fallback wiring", () => {
  it("opt absent (flag off) → one exact request even on zero", async () => {
    const { searchPeople } = await import("@/lib/api/search");
    const res = await searchPeople({ q: "Harrigton", shape: "name" });
    expect(capturedBodies).toHaveLength(1);
    expect(isFuzzy(capturedBodies[0])).toBe(false);
    expect(res.total).toBe(0);
    expect(res.typoFallback).toBeUndefined();
  });

  it("opt on + non-zero primary → one request, byte-identical to flag off", async () => {
    // The body embeds a "published in the last 2 years" cutoff from `new Date()`.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    exactTotal = 4;
    const { searchPeople } = await import("@/lib/api/search");
    await searchPeople({ q: "oncology", shape: "topic" });
    const off = structuredClone(capturedBodies);
    capturedBodies.length = 0;
    const res = await searchPeople({ q: "oncology", shape: "topic", typoFallback: true });
    vi.useRealTimers();
    expect(capturedBodies).toEqual(off);
    expect(capturedBodies).toHaveLength(1);
    expect(res.typoFallback).toBeUndefined();
  });

  it("opt on + zero primary → fuzzy retry over the people name/title fields", async () => {
    const { searchPeople } = await import("@/lib/api/search");
    const res = await searchPeople({ q: "Harrigton", shape: "name", typoFallback: true });
    expect(capturedBodies).toHaveLength(2);
    expect(isFuzzy(capturedBodies[0])).toBe(false);
    const fuzzy = multiMatches(capturedBodies[1]).filter((m) => "fuzziness" in m);
    expect(fuzzy).toEqual([
      {
        query: "Harrigton",
        fields: [...PEOPLE_TYPO_FALLBACK_FIELDS],
        type: "best_fields",
        operator: "and",
        ...TYPO_FUZZY_PARAMS,
      },
    ]);
    // The name template is dropped on the retry (the fuzzy clause replaces it).
    expect(JSON.stringify(capturedBodies[1])).not.toContain("match_phrase");
    expect(res.total).toBe(3);
    expect(res.typoFallback).toBe(true);
  });

  it("count-only badge falls back with the list (same predicate)", async () => {
    const { searchPeople } = await import("@/lib/api/search");
    const res = await searchPeople({
      q: "oncolgy",
      shape: "topic",
      typoFallback: true,
      countOnly: true,
    });
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[1].size).toBe(0);
    expect(isFuzzy(capturedBodies[1])).toBe(true);
    expect(res).toMatchObject({ total: 3, typoFallback: true });
  });

  it("filters carry over onto the retry", async () => {
    const { searchPeople } = await import("@/lib/api/search");
    await searchPeople({
      q: "oncolgy",
      typoFallback: true,
      filters: { personType: ["full_time_faculty"], activity: ["has_grants"] },
    });
    expect(capturedBodies).toHaveLength(2);
    const [exact, fuzzy] = capturedBodies;
    // Same facet/post-filter scope on both requests — only the text clause moved.
    expect(fuzzy.post_filter).toEqual(exact.post_filter);
    expect(JSON.stringify(fuzzy.post_filter)).toContain("full_time_faculty");
  });

  it("never falls back for a CWID-shaped query or a resolved MeSH concept", async () => {
    const { searchPeople } = await import("@/lib/api/search");
    await searchPeople({ q: "abc2001", shape: "cwid", typoFallback: true, countOnly: true });
    await searchPeople({
      q: "neoplasms",
      shape: "topic",
      typoFallback: true,
      countOnly: true,
      meshDescendantUis: ["D009369"],
    });
    expect(capturedBodies.some(isFuzzy)).toBe(false);
  });

  it("zero fuzzy result → the exact zero, unmarked", async () => {
    fuzzyTotal = 0;
    const { searchPeople } = await import("@/lib/api/search");
    const res = await searchPeople({ q: "zzzqqqx", typoFallback: true, countOnly: true });
    expect(capturedBodies).toHaveLength(2);
    expect(res.total).toBe(0);
    expect(res.typoFallback).toBeUndefined();
  });
});

describe("searchPublications — #2215 fallback wiring", () => {
  it("opt absent (flag off) → one exact request even on zero", async () => {
    const { searchPublications } = await import("@/lib/api/search");
    const res = await searchPublications({ q: "oncolgy" });
    expect(capturedBodies).toHaveLength(1);
    expect(isFuzzy(capturedBodies[0])).toBe(false);
    expect(res.typoFallback).toBeUndefined();
  });

  it("opt on + non-zero primary → byte-identical to flag off", async () => {
    exactTotal = 9;
    const { searchPublications } = await import("@/lib/api/search");
    await searchPublications({ q: "oncology", highlightMatches: true });
    const off = structuredClone(capturedBodies);
    capturedBodies.length = 0;
    await searchPublications({ q: "oncology", highlightMatches: true, typoFallback: true });
    expect(capturedBodies).toEqual(off);
  });

  it("opt on + zero primary → fuzzy retry over title/MeSH/authors/journal, fuzzy highlight", async () => {
    const { searchPublications } = await import("@/lib/api/search");
    const res = await searchPublications({
      q: "oncolgy",
      highlightMatches: true,
      typoFallback: true,
    });
    expect(capturedBodies).toHaveLength(2);
    const fuzzy = multiMatches(capturedBodies[1]).filter((m) => "fuzziness" in m);
    expect(fuzzy).toEqual([
      {
        query: "oncolgy",
        fields: [...PUBLICATION_TYPO_FALLBACK_FIELDS],
        type: "best_fields",
        operator: "and",
        ...TYPO_FUZZY_PARAMS,
      },
    ]);
    const hl = (capturedBodies[1].highlight as { highlight_query: { bool: { should: unknown[] } } })
      .highlight_query.bool.should;
    expect(hl).toContainEqual({ match: { title: { query: "oncolgy", ...TYPO_FUZZY_PARAMS } } });
    expect(res).toMatchObject({ total: 3, typoFallback: true });
  });

  it("count-only badge falls back too", async () => {
    const { searchPublications } = await import("@/lib/api/search");
    const res = await searchPublications({ q: "oncolgy", typoFallback: true, countOnly: true });
    expect(capturedBodies).toHaveLength(2);
    expect(res).toMatchObject({ total: 3, typoFallback: true });
  });

  it("never falls back when a MeSH resolution is in play", async () => {
    const { searchPublications } = await import("@/lib/api/search");
    const resolution = {
      descriptorUi: "D009369",
      name: "Neoplasms",
      matchedForm: "neoplasms",
      confidence: "exact",
      descendantUis: ["D009369"],
      curatedTopicAnchors: [],
    } as unknown as MeshResolution;
    await searchPublications({
      q: "neoplasms",
      typoFallback: true,
      countOnly: true,
      meshResolution: resolution,
    });
    expect(capturedBodies).toHaveLength(1);
  });
});
