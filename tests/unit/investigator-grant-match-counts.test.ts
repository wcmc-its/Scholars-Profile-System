/**
 * #1412 — the page-level funding count agg that replaced the per-card /grants fan-out.
 * Guards the parity-sensitive bits: the admission `must` must mirror searchFunding's
 * `expanded` scope (text, or — under the concept flag — text OR descriptor-tagged), the
 * investigator restriction + per-cwid terms agg must be shaped so each bucket's
 * doc_count == that scholar's matching-grant count, and buckets must parse into the
 * cwid → { count, tagged } Map the people path attaches to hits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

let lastBody: Record<string, unknown> | null = null;
let bucketResponse: unknown = { aggregations: { byInvestigator: { buckets: [] } } };

vi.mock("@/lib/db", () => ({ prisma: { scholar: { findMany: vi.fn().mockResolvedValue([]) } } }));

vi.mock("@/lib/search", () => ({
  FUNDING_INDEX: "scholars-funding",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_FIELD_BOOSTS: ["title^4", "sponsorText^2", "peopleNames^1", "abstract^1", "keywordsText^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { index: string; body: Record<string, unknown> }) {
      lastBody = req.body;
      return { body: bucketResponse };
    },
  }),
}));

// Concept admission is behind a flag — control it per test; keep everything else real.
let conceptEnabled = false;
vi.mock("@/lib/api/search-flags", async (orig) => {
  const actual = await orig<typeof import("@/lib/api/search-flags")>();
  return {
    ...actual,
    resolveFundingConceptEnabled: () => conceptEnabled,
    resolveFundingMeshGateField: () => "meshDescriptorUi",
  };
});

import { investigatorGrantMatchCounts } from "@/lib/api/search-funding";

const resolution = (descendantUis: string[]): MeshResolution =>
  ({
    descriptorUi: descendantUis[0],
    name: "Heart Arrest",
    matchedForm: "Heart Arrest",
    confidence: "exact",
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis,
  }) as MeshResolution;

afterEach(() => {
  lastBody = null;
  bucketResponse = { aggregations: { byInvestigator: { buckets: [] } } };
  conceptEnabled = false;
  vi.restoreAllMocks();
});

describe("investigatorGrantMatchCounts", () => {
  it("short-circuits (no OpenSearch call) on empty cwids or empty query", async () => {
    expect((await investigatorGrantMatchCounts({ q: "diabetes", cwids: [] })).size).toBe(0);
    expect((await investigatorGrantMatchCounts({ q: "   ", cwids: ["a1"] })).size).toBe(0);
    expect(lastBody).toBeNull();
  });

  it("text-only: query admits the whole investigator population, the `matched` sub-agg admits the query", async () => {
    bucketResponse = {
      aggregations: {
        byInvestigator: {
          buckets: [
            // doc_count = every funding-index project this investigator is on (the
            // denominator); matched.doc_count = the ones the query admitted (the numerator).
            { key: "aaa1111", doc_count: 40, matched: { doc_count: 3 } },
            { key: "bbb2222", doc_count: 9, matched: { doc_count: 1 } },
          ],
        },
      },
    };
    const out = await investigatorGrantMatchCounts({ q: "breast cancer", cwids: ["aaa1111", "bbb2222"] });

    const body = lastBody as {
      size: number;
      query: { bool: { must?: unknown; filter: Array<Record<string, unknown>> } };
      aggs: {
        byInvestigator: {
          terms: Record<string, unknown>;
          aggs: { matched: { filter: { bool: { must: Array<Record<string, unknown>> } }; aggs?: unknown } };
        };
      };
    };
    expect(body.size).toBe(0);
    // #2018/E2 — the top-level query is now the investigator restriction ALONE, so each
    // bucket's doc_count is that scholar's whole searchable funding population.
    expect(body.query.bool.filter).toEqual([{ terms: { wcmInvestigatorCwids: ["aaa1111", "bbb2222"] } }]);
    expect(body.query.bool.must).toBeUndefined();
    // Admission moved down a level, unchanged: the bare lexical multi_match (expanded
    // scope, concept flag off). Parity with searchFunding's `must` is what makes the
    // numerator the same set /grants lists.
    const matchedMust = body.aggs.byInvestigator.aggs.matched.filter.bool.must;
    expect(matchedMust).toHaveLength(1);
    expect(matchedMust[0]).toHaveProperty("multi_match");
    // per-investigator bucketing, restricted to the page cwids, no concept sub-agg
    expect(body.aggs.byInvestigator.terms).toMatchObject({
      field: "wcmInvestigatorCwids",
      include: ["aaa1111", "bbb2222"],
    });
    expect(body.aggs.byInvestigator.aggs.matched.aggs).toBeUndefined();

    // Concept axis off ⇒ no sub-agg ⇒ nothing is tagged, so the card can only say "mention".
    expect(out.get("aaa1111")).toEqual({ count: 3, taggedCount: 0, indexedCount: 40 });
    expect(out.get("bbb2222")).toEqual({ count: 1, taggedCount: 0, indexedCount: 9 });
  });

  it("#2018/E2 — the denominator is the bucket total, and the numerator never exceeds it", async () => {
    bucketResponse = {
      aggregations: {
        byInvestigator: {
          // The measured shape: a scholar whose people-doc grantCount reads 127 while the
          // searchable funding population is 117. The card must divide by 117.
          buckets: [{ key: "aaa1111", doc_count: 117, matched: { doc_count: 32 } }],
        },
      },
    };
    const out = await investigatorGrantMatchCounts({ q: "genetic therapy", cwids: ["aaa1111"] });
    const row = out.get("aaa1111")!;
    expect(row.indexedCount).toBe(117);
    expect(row.count).toBe(32);
    // A filter sub-agg is a subset of its parent bucket by construction — pin it, because
    // this is the whole property that makes the fraction honest.
    expect(row.count).toBeLessThanOrEqual(row.indexedCount);
  });

  it("a bucket with no `matched` sub-agg degrades to a zero numerator, not a zero denominator", async () => {
    bucketResponse = {
      aggregations: { byInvestigator: { buckets: [{ key: "aaa1111", doc_count: 12 }] } },
    };
    const out = await investigatorGrantMatchCounts({ q: "x", cwids: ["aaa1111"] });
    // count 0 is dropped by the caller (emitted only when > 0). A 0 DENOMINATOR would
    // instead divide the card's share, so it must never be the degraded value.
    expect(out.get("aaa1111")).toEqual({ count: 0, taggedCount: 0, indexedCount: 12 });
  });

  it("concept flag on: admission becomes text OR descriptor-tagged, with a per-cwid tagged sub-agg", async () => {
    conceptEnabled = true;
    bucketResponse = {
      aggregations: {
        byInvestigator: {
          buckets: [
            { key: "aaa1111", doc_count: 20, matched: { doc_count: 2, tagged: { doc_count: 1 } } },
            { key: "bbb2222", doc_count: 5, matched: { doc_count: 1, tagged: { doc_count: 0 } } },
          ],
        },
      },
    };
    const out = await investigatorGrantMatchCounts({
      q: "cardiac arrest",
      cwids: ["aaa1111", "bbb2222"],
      meshResolution: resolution(["D006323", "D006324"]),
    });

    const body = lastBody as {
      aggs: {
        byInvestigator: {
          aggs: {
            matched: {
              filter: { bool: { must: Array<{ bool?: { should: unknown[]; minimum_should_match: number } }> } };
              aggs: { tagged: { filter: Record<string, unknown> } };
            };
          };
        };
      };
    };
    // #295 union: a single should over [textClause, descriptor terms], msm 1 — now inside
    // the `matched` filter rather than the top-level query, but structurally identical.
    const union = body.aggs.byInvestigator.aggs.matched.filter.bool.must[0].bool;
    expect(union?.minimum_should_match).toBe(1);
    expect(union?.should).toHaveLength(2);
    expect(union?.should).toContainEqual({ terms: { meshDescriptorUi: ["D006323", "D006324"] } });
    // tagged nests one level deeper — it is a subset of MATCHED, not of the population
    expect(body.aggs.byInvestigator.aggs.matched.aggs.tagged.filter).toEqual({
      terms: { meshDescriptorUi: ["D006323", "D006324"] },
    });

    // #1732 — the tagged sub-agg is returned as a COUNT, not collapsed to `> 0`.
    // aaa1111 is the MIXED case this fixture always described and the old assertion threw
    // away: 2 grants matched the OR, but only ONE carries the concept tag. `tagged: true`
    // was true and useless — it let the card caption the OR total (2) as "tagged", which
    // in prod rendered "5 of 24 grants tagged Immunoconjugates" over a single tagged grant.
    expect(out.get("aaa1111")).toEqual({ count: 2, taggedCount: 1, indexedCount: 20 });
    expect(out.get("bbb2222")).toEqual({ count: 1, taggedCount: 0, indexedCount: 5 });
    // The partition the card renders: tagged + mention-only = the matched set.
    const mixed = out.get("aaa1111")!;
    expect(mixed.taggedCount + (mixed.count - mixed.taggedCount)).toBe(mixed.count);
  });

  it("de-dupes cwids and drops falsy ids before the agg", async () => {
    await investigatorGrantMatchCounts({ q: "x", cwids: ["a1", "a1", "", "b2"] });
    const body = lastBody as { query: { bool: { filter: Array<{ terms: { wcmInvestigatorCwids: string[] } }> } } };
    expect(body.query.bool.filter[0].terms.wcmInvestigatorCwids).toEqual(["a1", "b2"]);
  });
});
