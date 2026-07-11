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

  it("text-only: multi_match admission, investigator filter, per-cwid terms agg, no tagged sub-agg", async () => {
    bucketResponse = {
      aggregations: {
        byInvestigator: {
          buckets: [
            { key: "aaa1111", doc_count: 3 },
            { key: "bbb2222", doc_count: 1 },
          ],
        },
      },
    };
    const out = await investigatorGrantMatchCounts({ q: "breast cancer", cwids: ["aaa1111", "bbb2222"] });

    const body = lastBody as {
      size: number;
      query: { bool: { must: Array<Record<string, unknown>>; filter: Array<Record<string, unknown>> } };
      aggs: { byInvestigator: { terms: Record<string, unknown>; aggs?: unknown } };
    };
    expect(body.size).toBe(0);
    // admission = the bare lexical multi_match (expanded scope, concept flag off)
    expect(body.query.bool.must).toHaveLength(1);
    expect(body.query.bool.must[0]).toHaveProperty("multi_match");
    // investigator restriction lives in the query filter (so each bucket count is exact)
    expect(body.query.bool.filter).toEqual([{ terms: { wcmInvestigatorCwids: ["aaa1111", "bbb2222"] } }]);
    // per-investigator bucketing, restricted to the page cwids, no concept sub-agg
    expect(body.aggs.byInvestigator.terms).toMatchObject({
      field: "wcmInvestigatorCwids",
      include: ["aaa1111", "bbb2222"],
    });
    expect(body.aggs.byInvestigator.aggs).toBeUndefined();

    expect(out.get("aaa1111")).toEqual({ count: 3, tagged: false });
    expect(out.get("bbb2222")).toEqual({ count: 1, tagged: false });
  });

  it("concept flag on: admission becomes text OR descriptor-tagged, with a per-cwid tagged sub-agg", async () => {
    conceptEnabled = true;
    bucketResponse = {
      aggregations: {
        byInvestigator: {
          buckets: [
            { key: "aaa1111", doc_count: 2, tagged: { doc_count: 1 } },
            { key: "bbb2222", doc_count: 1, tagged: { doc_count: 0 } },
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
      query: { bool: { must: Array<{ bool?: { should: unknown[]; minimum_should_match: number } }> } };
      aggs: { byInvestigator: { aggs: { tagged: { filter: Record<string, unknown> } } } };
    };
    // #295 union: a single should over [textClause, descriptor terms], msm 1
    const union = body.query.bool.must[0].bool;
    expect(union?.minimum_should_match).toBe(1);
    expect(union?.should).toHaveLength(2);
    expect(union?.should).toContainEqual({ terms: { meshDescriptorUi: ["D006323", "D006324"] } });
    // tagged sub-agg counts concept-admitted docs per investigator
    expect(body.aggs.byInvestigator.aggs.tagged.filter).toEqual({
      terms: { meshDescriptorUi: ["D006323", "D006324"] },
    });

    expect(out.get("aaa1111")).toEqual({ count: 2, tagged: true });
    expect(out.get("bbb2222")).toEqual({ count: 1, tagged: false });
  });

  it("de-dupes cwids and drops falsy ids before the agg", async () => {
    await investigatorGrantMatchCounts({ q: "x", cwids: ["a1", "a1", "", "b2"] });
    const body = lastBody as { query: { bool: { filter: Array<{ terms: { wcmInvestigatorCwids: string[] } }> } } };
    expect(body.query.bool.filter[0].terms.wcmInvestigatorCwids).toEqual(["a1", "b2"]);
  });
});
