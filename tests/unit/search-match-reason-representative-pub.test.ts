/**
 * Issue #967 — representative-pub reason line. Unit-tests the two pure helpers
 * extracted from `searchPeople`:
 *   - `parseReasonTopHit`  — pull a RepresentativePub out of a reason filter's
 *                            `top` (top_hits) sub-agg.
 *   - `composeMatchReason` — precedence (tagged → mention → concept), count cap,
 *                            and the #967 representative-pub attach.
 * No live cluster: these are the logic the agg JSON and the render depend on.
 */
import { describe, expect, it } from "vitest";
import {
  composeMatchReason,
  parseReasonTopHit,
  parseReasonTopHits,
  type RepresentativePub,
} from "@/lib/api/search";

type HitArg = { pmid?: string | number; title?: string; year?: number | null; titleHighlight?: string };

function hitOf(args: HitArg) {
  return {
    _source: { pmid: args.pmid, title: args.title, year: args.year },
    ...(args.titleHighlight ? { highlight: { title: [args.titleHighlight] } } : {}),
  };
}

// A top_hits sub-agg result as OpenSearch returns it inside a `filter` agg.
function topHit(args: HitArg) {
  return { top: { hits: { hits: [hitOf(args)] } } };
}

// A multi-hit top_hits sub-agg (rep-papers disclosure shows up to 3).
function topHits(args: HitArg[]) {
  return { top: { hits: { hits: args.map(hitOf) } } };
}

describe("parseReasonTopHit (#967)", () => {
  it("returns the representative pub with a highlighted title fragment when present", () => {
    const rep = parseReasonTopHit(
      topHit({
        pmid: 12345,
        title: "Broadly neutralizing antibodies for HIV-1 prevention",
        year: 2024,
        titleHighlight: "Broadly neutralizing antibodies for <mark>HIV</mark>-1 prevention",
      }),
    );
    expect(rep).toEqual({
      pmid: "12345",
      title: "Broadly neutralizing antibodies for HIV-1 prevention",
      titleHtml: "Broadly neutralizing antibodies for <mark>HIV</mark>-1 prevention",
      year: 2024,
    });
  });

  it("omits titleHtml when the literal query did not appear in the title (descriptor-tagged match)", () => {
    const rep = parseReasonTopHit(
      topHit({ pmid: "999", title: "Antiretroviral therapy outcomes", year: 2019 }),
    );
    expect(rep).toEqual({ pmid: "999", title: "Antiretroviral therapy outcomes", year: 2019 });
    expect(rep?.titleHtml).toBeUndefined();
  });

  it("omits year when the doc has no year", () => {
    const rep = parseReasonTopHit(topHit({ pmid: "1", title: "A paper", year: null }));
    expect(rep).toEqual({ pmid: "1", title: "A paper" });
  });

  it("returns undefined when the sub-agg is absent (flag off)", () => {
    expect(parseReasonTopHit(undefined)).toBeUndefined();
    expect(parseReasonTopHit({})).toBeUndefined();
  });

  it("returns undefined when the filter matched no pub (empty hits)", () => {
    expect(parseReasonTopHit({ top: { hits: { hits: [] } } })).toBeUndefined();
  });

  it("returns undefined when the hit lacks a pmid or title", () => {
    expect(parseReasonTopHit(topHit({ title: "No pmid" }))).toBeUndefined();
    expect(parseReasonTopHit(topHit({ pmid: "1" }))).toBeUndefined();
  });
});

describe("parseReasonTopHits (rep-papers disclosure — array form)", () => {
  it("maps every hit through the same logic, preserving order, capped at 3", () => {
    const reps = parseReasonTopHits(
      topHits([
        { pmid: 1, title: "First", year: 2024 },
        { pmid: 2, title: "Second", year: 2023 },
        { pmid: 3, title: "Third", year: 2022 },
        { pmid: 4, title: "Fourth (over cap)", year: 2021 },
      ]),
    );
    expect(reps.map((r) => r.pmid)).toEqual(["1", "2", "3"]);
    expect(reps[0]).toEqual({ pmid: "1", title: "First", year: 2024 });
  });

  it("honors a custom limit", () => {
    const reps = parseReasonTopHits(
      topHits([
        { pmid: 1, title: "First", year: 2024 },
        { pmid: 2, title: "Second", year: 2023 },
      ]),
      1,
    );
    expect(reps).toHaveLength(1);
    expect(reps[0].pmid).toBe("1");
  });

  it("carries titleHtml only when the literal query highlighted the title", () => {
    const reps = parseReasonTopHits(
      topHits([
        { pmid: 1, title: "Marked one", titleHighlight: "<mark>Marked</mark> one", year: 2024 },
        { pmid: 2, title: "Plain two", year: 2023 },
      ]),
    );
    expect(reps[0].titleHtml).toBe("<mark>Marked</mark> one");
    expect(reps[1].titleHtml).toBeUndefined();
  });

  it("drops hits missing a pmid or title; keeps the valid ones", () => {
    const reps = parseReasonTopHits(
      topHits([
        { title: "No pmid", year: 2024 },
        { pmid: 2, title: "Valid", year: 2023 },
        { pmid: 3, year: 2022 }, // no title
      ]),
    );
    expect(reps.map((r) => r.pmid)).toEqual(["2"]);
  });

  it("empty / absent sub-agg ⇒ []", () => {
    expect(parseReasonTopHits(undefined)).toEqual([]);
    expect(parseReasonTopHits({})).toEqual([]);
    expect(parseReasonTopHits({ top: { hits: { hits: [] } } })).toEqual([]);
  });
});

const repTagged: RepresentativePub = { pmid: "1", title: "Tagged paper", year: 2024 };
const repMention: RepresentativePub = { pmid: "2", title: "Mention paper", year: 2023 };

describe("composeMatchReason (#967)", () => {
  it("tagged wins and carries its representative pub", () => {
    const r = composeMatchReason({
      counts: { tagged: 14, mention: 3 },
      rep: { tagged: repTagged, mention: repMention },
      pubCount: 372,
      hasProvenance: true,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
    expect(r).toEqual({
      icon: "publications",
      text: "14 of 372 publications tagged HIV",
      pub: repTagged,
    });
  });

  it("caps the count at the scholar's pubCount (index drift)", () => {
    const r = composeMatchReason({
      counts: { tagged: 400, mention: 0 },
      rep: undefined,
      pubCount: 372,
      hasProvenance: true,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
    expect(r?.text).toBe("372 of 372 publications tagged HIV");
  });

  it("falls through to mention (with its pub) when there are no tagged pubs", () => {
    const r = composeMatchReason({
      counts: { tagged: 0, mention: 5 },
      rep: { mention: repMention },
      pubCount: 100,
      hasProvenance: false,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
    expect(r).toEqual({
      icon: "publications",
      text: "5 of 100 publications mention “hiv”",
      pub: repMention,
    });
  });

  it("attaches no pub when the rep map is empty (flag off) even though counts fire", () => {
    const r = composeMatchReason({
      counts: { tagged: 14, mention: 0 },
      rep: undefined,
      pubCount: 372,
      hasProvenance: true,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
    expect(r).toEqual({ icon: "publications", text: "14 of 372 publications tagged HIV" });
    expect(r?.pub).toBeUndefined();
  });

  it("the concept fallback never carries a pub", () => {
    const r = composeMatchReason({
      counts: { tagged: 0, mention: 0 },
      rep: { tagged: repTagged },
      pubCount: 50,
      hasProvenance: true,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
    expect(r).toEqual({ icon: "concept", text: "via related concept HIV" });
  });

  it("returns undefined when there is neither a count nor provenance", () => {
    expect(
      composeMatchReason({
        counts: undefined,
        rep: undefined,
        pubCount: 10,
        hasProvenance: false,
        provenanceParent: "",
        contentQuery: "x",
      }),
    ).toBeUndefined();
  });
});
