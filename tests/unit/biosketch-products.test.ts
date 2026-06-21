import { describe, expect, it } from "vitest";

import { DEFAULT_BIOSKETCH_PARAMS, type BiosketchParams } from "@/lib/edit/biosketch-params";
import {
  applyProductMapping,
  productPmids,
  selectBiosketchProducts,
  type BiosketchProducts,
} from "@/lib/edit/biosketch-products";
import type { OverviewFacts } from "@/lib/edit/overview-facts";

type Pub = OverviewFacts["representativePublications"][number];

function pub(over: Partial<Pub> & { pmid: string }): Pub {
  return {
    pmid: over.pmid,
    title: over.title ?? `Title ${over.pmid}`,
    venue: over.venue ?? "Journal",
    year: over.year ?? 2020,
    impact: over.impact ?? 50,
    synopsis: over.synopsis ?? null,
    impactJustification: null,
    topicRationale: over.topicRationale ?? null,
    authorPosition: over.authorPosition ?? "first",
    citationCount: over.citationCount ?? 0,
    relativeCitationRatio: over.relativeCitationRatio ?? null,
    nihPercentile: over.nihPercentile ?? null,
    citedByCount: over.citedByCount ?? null,
  };
}

function facts(pubs: Pub[]): OverviewFacts {
  return {
    name: "Dr. Test",
    title: null,
    department: null,
    topics: [],
    representativePublications: pubs,
    publicationCount: pubs.length,
    yearsActive: { first: 2010, last: 2024 },
    activeGrants: [],
    education: [],
    titles: [],
    methods: [],
    facultyMetrics: null,
    existingBio: null,
  };
}

const params = (over: Partial<BiosketchParams> = {}): BiosketchParams => ({
  ...DEFAULT_BIOSKETCH_PARAMS,
  mode: "contributions",
  ...over,
});

describe("selectBiosketchProducts (#917 v6)", () => {
  it("returns empty buckets for an empty corpus", () => {
    const out = selectBiosketchProducts(facts([]), params());
    expect(out.related).toEqual([]);
    expect(out.otherSignificant).toEqual([]);
    expect(out.relatedFromAims).toBe(false);
  });

  it("with no aims, related = most significant, buckets are disjoint and capped at 5", () => {
    const pubs = Array.from({ length: 12 }, (_, i) =>
      pub({ pmid: `p${i}`, impact: 100 - i, citationCount: (12 - i) * 10 }),
    );
    const out = selectBiosketchProducts(facts(pubs), params());
    expect(out.relatedFromAims).toBe(false);
    expect(out.related.length).toBe(5);
    expect(out.otherSignificant.length).toBe(5);
    const relatedIds = new Set(out.related.map((p) => p.pmid));
    // disjoint
    expect(out.otherSignificant.every((p) => !relatedIds.has(p.pmid))).toBe(true);
    // related is the highest-blended-impact set (p0 has the top impact + citations)
    expect(out.related[0].pmid).toBe("p0");
  });

  it("with aims, related is ranked by aims/topic overlap and flagged relatedFromAims", () => {
    const pubs = [
      pub({ pmid: "match1", title: "CRISPR genome editing in pancreatic cancer", impact: 30 }),
      pub({ pmid: "match2", synopsis: "A study of pancreatic cancer immunotherapy", impact: 20 }),
      pub({ pmid: "off1", title: "Unrelated cardiology imaging work", impact: 99, citationCount: 999 }),
    ];
    const out = selectBiosketchProducts(
      facts(pubs),
      params({ projectTitle: "Pancreatic cancer therapy", aims: "Targeting pancreatic cancer with editing" }),
    );
    expect(out.relatedFromAims).toBe(true);
    const relatedIds = out.related.map((p) => p.pmid);
    expect(relatedIds).toContain("match1");
    expect(relatedIds).toContain("match2");
    // the high-impact but unrelated pub is NOT in related (it overlaps no aims token)
    expect(relatedIds).not.toContain("off1");
    // it surfaces in otherSignificant instead
    expect(out.otherSignificant.map((p) => p.pmid)).toContain("off1");
  });

  it("falls back to most-significant when aims overlap nothing", () => {
    const pubs = [pub({ pmid: "a", impact: 80 }), pub({ pmid: "b", impact: 60 })];
    const out = selectBiosketchProducts(
      facts(pubs),
      params({ aims: "quantum chromodynamics lattice gauge" }),
    );
    expect(out.relatedFromAims).toBe(false);
    expect(out.related.map((p) => p.pmid)).toEqual(["a", "b"]);
  });
});

describe("applyProductMapping (#917 v6)", () => {
  const base: BiosketchProducts = {
    related: [
      { pmid: "p1", title: "T1", venue: "V", year: 2020, contributionIndex: null, why: "" },
      { pmid: "p2", title: "T2", venue: "V", year: 2021, contributionIndex: null, why: "" },
    ],
    otherSignificant: [
      { pmid: "p3", title: "T3", venue: "V", year: 2019, contributionIndex: null, why: "" },
    ],
    relatedFromAims: true,
  };

  it("applies a valid mapping, clamping the contribution index", () => {
    const json = JSON.stringify({
      mappings: [
        { pmid: "p1", contributionIndex: 2, why: "supports aim 2" },
        { pmid: "p2", contributionIndex: 99, why: "out of range" },
        { pmid: "p3", contributionIndex: 1, why: "foundational" },
      ],
    });
    const out = applyProductMapping(base, json, 3);
    expect(out.related[0]).toMatchObject({ pmid: "p1", contributionIndex: 2, why: "supports aim 2" });
    // 99 > maxContribution(3) → clamped to null
    expect(out.related[1].contributionIndex).toBe(null);
    expect(out.otherSignificant[0]).toMatchObject({ pmid: "p3", contributionIndex: 1 });
  });

  it("ignores pmids not in the selected set and tolerates garbage", () => {
    const json = JSON.stringify({ mappings: [{ pmid: "GHOST", contributionIndex: 1, why: "x" }] });
    const out = applyProductMapping(base, json, 3);
    expect(out.related.every((p) => p.contributionIndex === null)).toBe(true);
    // malformed JSON degrades to unmapped, never throws
    const out2 = applyProductMapping(base, "not json at all", 3);
    expect(out2.related.every((p) => p.contributionIndex === null)).toBe(true);
  });

  it("productPmids returns the unique pmids across both buckets", () => {
    expect(productPmids(base)).toEqual(["p1", "p2", "p3"]);
  });
});
