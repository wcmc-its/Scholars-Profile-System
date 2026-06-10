/**
 * Unit tests for lib/profile/facet-counts.ts — the pure exclude-own-facet
 * contextual counter behind the scholar-profile facet-filter redesign (PR-1).
 *
 * Strategy: small HAND-CONSTRUCTED publication fixtures with author-designed
 * pmids/meshTerms, asserting EXACT counts computed by hand. No mocks, no I/O.
 *
 * Coverage:
 *  (a) Convergence — selected topic AND selected family both equal barTotal.
 *  (b) Exclude-own-facet — an UNSELECTED topic's count reflects the family filter.
 *  (c) Zero-count — a topic/family with 0 in-filter pubs stays present at 0.
 *  (d) Position composes — matchesPosition restricts counts like an "other facet".
 *  (e) Family dedupe — two selected families sharing pmids → barTotal is the UNION.
 *  (f) Clamp + mismatch — a too-small denominator clamps and fires onClampMismatch.
 */
import { describe, expect, it, vi } from "vitest";

import { computeFacetCounts } from "@/lib/profile/facet-counts";
import type { ProfilePublication } from "@/lib/api/profile";

// ---------------------------------------------------------------------------
// Fixture builder — only the fields computeFacetCounts reads matter (pmid,
// meshTerms, authorship). Everything else is filled with inert placeholders so
// the object satisfies ProfilePublication without distracting from the logic.
// ---------------------------------------------------------------------------
function pub(
  pmid: string,
  uis: string[],
  authorship: { isFirst?: boolean; isLast?: boolean; isPenultimate?: boolean } = {},
): ProfilePublication {
  return {
    pmid,
    title: `Title ${pmid}`,
    authorsString: null,
    journal: null,
    year: 2020,
    publicationType: "Journal Article",
    citationCount: 0,
    reciteraiImpact: 0,
    dateAddedToEntrez: null,
    doi: null,
    pmcid: null,
    pubmedUrl: null,
    authorship: {
      isFirst: authorship.isFirst ?? false,
      isLast: authorship.isLast ?? false,
      isPenultimate: authorship.isPenultimate ?? false,
    },
    isConfirmed: true,
    meshTerms: uis.map((ui) => ({ ui, label: ui })),
    abstract: null,
    wcmAuthors: [],
    score: 0,
  } as unknown as ProfilePublication;
}

const ALWAYS = () => true;

// Shared base fixture (used by most cases).
//   p1: T1,T2  first
//   p2: T1,T3  first
//   p3: T1,T2  middle (not first)
//   p4: T2     first
//   p5: T1     first
//   p6: T3     middle (not first)
function baseFixture(): ProfilePublication[] {
  return [
    pub("p1", ["T1", "T2"], { isFirst: true }),
    pub("p2", ["T1", "T3"], { isFirst: true }),
    pub("p3", ["T1", "T2"], { isFirst: false }),
    pub("p4", ["T2"], { isFirst: true }),
    pub("p5", ["T1"], { isFirst: true }),
    pub("p6", ["T3"], { isFirst: false }),
  ];
}

// F1 = {p1,p2,p4}, F2 = {p2,p4,p5}. They SHARE p2 and p4.
//   union F1∪F2 = {p1,p2,p4,p5} (size 4, NOT 6).
function baseFamilyPmids(): Map<string, string[]> {
  return new Map<string, string[]>([
    ["F1", ["p1", "p2", "p4"]],
    ["F2", ["p2", "p4", "p5"]],
  ]);
}

describe("computeFacetCounts", () => {
  // (a) Convergence -----------------------------------------------------------
  it("(a) selected topic AND selected family both converge on barTotal", () => {
    // Select topic T1 and family F1.
    //   T1 pubs (any position): p1,p2,p3,p5
    //   F1 = {p1,p2,p4}
    //   barTotal = pubs with T1 AND in F1 = {p1,p2} -> 2
    const res = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: ["T1"],
      selectedFamilyIds: ["F1"],
      familyPmids: baseFamilyPmids(),
      matchesPosition: ALWAYS,
    });

    expect(res.barTotal).toBe(2);

    // Selected TOPIC T1 is counted with topics EXCLUDED but family F1 applied:
    //   pubsForTopicCounts = F1 = {p1,p2,p4}; of those carrying T1 -> {p1,p2} = 2.
    expect(res.topic.get("T1")).toBe(2);

    // Selected FAMILY F1 is counted with families EXCLUDED but topic T1 applied:
    //   pubsForMethodCounts = T1 pubs = {p1,p2,p3,p5}; ∩ F1{p1,p2,p4} -> {p1,p2} = 2.
    expect(res.family.get("F1")).toBe(2);

    // The "6 of 27 / 6 of 10" property: both selected facet counts == barTotal.
    expect(res.topic.get("T1")).toBe(res.barTotal);
    expect(res.family.get("F1")).toBe(res.barTotal);
  });

  // (b) Exclude-own-facet -----------------------------------------------------
  it("(b) an UNSELECTED topic's count reflects the OTHER (family) facet filter", () => {
    // Select ONLY family F1 = {p1,p2,p4}. No topic selected.
    //   pubsForTopicCounts = F1 (no topic selection) = {p1,p2,p4}.
    //   Unselected topic T2 appears on p1 and p4 within F1 -> 2.
    //   Without the F1 filter T2 would be on p1,p3,p4 = 3, so the method
    //   filter demonstrably CHANGED the unselected topic count (3 -> 2).
    const filtered = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: ["F1"],
      familyPmids: baseFamilyPmids(),
      matchesPosition: ALWAYS,
    });
    expect(filtered.topic.get("T2")).toBe(2);

    // Control: with NO family filter, T2 is on p1,p3,p4 = 3.
    const unfiltered = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: [],
      familyPmids: baseFamilyPmids(),
      matchesPosition: ALWAYS,
    });
    expect(unfiltered.topic.get("T2")).toBe(3);

    // And T1 within F1 = {p1,p2} -> 2 (vs 4 unfiltered).
    expect(filtered.topic.get("T1")).toBe(2);
    expect(unfiltered.topic.get("T1")).toBe(4);
  });

  // (c) Zero-count ------------------------------------------------------------
  it("(c) a topic and a family with 0 in-filter pubs stay present at 0", () => {
    // Add an empty family F3 = {} and select topic T3 (on p2,p6).
    //   pubsForMethodCounts = T3 pubs = {p2,p6}.
    //   F3 has no members -> family.get('F3') === 0 (present, not absent).
    //   topic T2 within (no family filter) pubsForTopicCounts = all = on p1,p3,p4
    //   but we want a zero TOPIC: introduce family filter F-only-p6 so a topic
    //   absent from that pub is 0.
    const fams = new Map<string, string[]>([
      ["F1", ["p1", "p2", "p4"]],
      ["F3", []], // empty family
      ["Fp6", ["p6"]], // single-pub family carrying only T3
    ]);

    const res = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: ["Fp6"], // restrict context to {p6}
      familyPmids: fams,
      matchesPosition: ALWAYS,
    });

    // Empty family is present with 0.
    expect(res.family.has("F3")).toBe(true);
    expect(res.family.get("F3")).toBe(0);

    // TOPIC counts use the EXCLUDE-OWN-FACET context, which (no topic selected)
    // is the family-filtered set {p6}. p6 carries only T3, so:
    //   T3 -> 1 ; T1/T2 absent from p6 -> not indexed (treated as 0).
    expect(res.topic.get("T3")).toBe(1);
    expect(res.topic.get("T1") ?? 0).toBe(0);
    expect(res.topic.get("T2") ?? 0).toBe(0);

    // FAMILY counts EXCLUDE the family selection, so the Methods context is all
    // pubs (no topic/position filter) -> each family's count is its full
    // membership ∩ all: F1{p1,p2,p4} = 3, Fp6{p6} = 1. (The family facet does
    // NOT self-filter; that is the exclude-own-facet property for Methods.)
    expect(res.family.get("F1")).toBe(3);
    expect(res.family.get("Fp6")).toBe(1);
  });

  // (d) Position composes -----------------------------------------------------
  it("(d) matchesPosition restricts counts as an 'other facet' with no facets selected", () => {
    // No topic, no family selected; only a first-author position predicate.
    //   First-author pubs = p1,p2,p4,p5 (p3,p6 are middle).
    //   Topic counts over first-author pubs:
    //     T1 on p1,p2,p5 -> 3   (p3 excluded by position)
    //     T2 on p1,p4    -> 2   (p3 excluded)
    //     T3 on p2       -> 1   (p6 excluded)
    //   barTotal = all first-author pubs = 4.
    const firstAuthorOnly = (p: ProfilePublication) => p.authorship.isFirst;

    const res = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: [],
      familyPmids: baseFamilyPmids(),
      matchesPosition: firstAuthorOnly,
    });

    expect(res.barTotal).toBe(4);
    expect(res.topic.get("T1")).toBe(3);
    expect(res.topic.get("T2")).toBe(2);
    expect(res.topic.get("T3")).toBe(1);

    // Family counts also respect position: F1{p1,p2,p4} ∩ first-author = {p1,p2,p4} = 3;
    // F2{p2,p4,p5} ∩ first-author = {p2,p4,p5} = 3.
    expect(res.family.get("F1")).toBe(3);
    expect(res.family.get("F2")).toBe(3);
  });

  // (e) Family dedupe ---------------------------------------------------------
  it("(e) two selected families sharing pmids → barTotal is the UNION size, not the sum", () => {
    // Select BOTH F1{p1,p2,p4} and F2{p2,p4,p5}. No topic.
    //   union = {p1,p2,p4,p5} -> 4. Naive per-family SUM would be 3 + 3 = 6.
    //   barTotal must be 4 (union), proving the dedupe.
    const res = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: ["F1", "F2"],
      familyPmids: baseFamilyPmids(),
      matchesPosition: ALWAYS,
    });

    expect(res.barTotal).toBe(4); // union size, NOT 6
    expect(res.barTotal).not.toBe(6);

    // pubsForMethodCounts excludes the family selection -> all 6 pubs (no topic
    // either), so each selected family's own count is just its full membership:
    //   F1 ∩ all = 3, F2 ∩ all = 3.
    expect(res.family.get("F1")).toBe(3);
    expect(res.family.get("F2")).toBe(3);

    // Topic counts span the union {p1,p2,p4,p5}:
    //   T1 on p1,p2,p5 -> 3 ; T2 on p1,p4 -> 2 ; T3 on p2 -> 1.
    expect(res.topic.get("T1")).toBe(3);
    expect(res.topic.get("T2")).toBe(2);
    expect(res.topic.get("T3")).toBe(1);
  });

  // (f) Clamp + mismatch ------------------------------------------------------
  it("(f) clamps a numerator above its aggregate denominator and fires onClampMismatch", () => {
    // No filters: live T1 count over all pubs = p1,p2,p3,p5 = 4.
    // Supply a topicTotals denominator of 3 for T1 (a stale/too-small aggregate,
    // the "7 of 6" inversion). The result must clamp to 3 AND report it.
    const onClampMismatch = vi.fn();

    const res = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: [],
      familyPmids: baseFamilyPmids(),
      matchesPosition: ALWAYS,
      topicTotals: new Map([
        ["T1", 3], // smaller than live 4 -> clamp + mismatch
        ["T2", 99], // larger than live 3 -> no clamp, no mismatch
      ]),
      onClampMismatch,
    });

    // Clamped down to the denominator.
    expect(res.topic.get("T1")).toBe(3);
    // T2 (live 3, denom 99) is untouched.
    expect(res.topic.get("T2")).toBe(3);

    // Mismatch fired exactly once, for T1, with the pre-clamp numerator/denominator.
    expect(onClampMismatch).toHaveBeenCalledTimes(1);
    expect(onClampMismatch).toHaveBeenCalledWith("topic", "T1", 4, 3);
  });

  it("(f) clamps a FAMILY numerator above its aggregate denominator and fires onClampMismatch", () => {
    // No filters: live F1 count = full membership {p1,p2,p4} = 3.
    // Aggregate denominator of 2 (too small) -> clamp to 2 + mismatch.
    const onClampMismatch = vi.fn();

    const res = computeFacetCounts({
      publications: baseFixture(),
      selectedUis: [],
      selectedFamilyIds: [],
      familyPmids: baseFamilyPmids(),
      matchesPosition: ALWAYS,
      familyTotals: new Map([["F1", 2]]),
      onClampMismatch,
    });

    expect(res.family.get("F1")).toBe(2);
    expect(onClampMismatch).toHaveBeenCalledTimes(1);
    expect(onClampMismatch).toHaveBeenCalledWith("family", "F1", 3, 2);
  });
});
