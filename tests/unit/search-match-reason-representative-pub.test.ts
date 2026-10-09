/**
 * Issue #967 — representative publications on the People evidence line. Unit-tests
 * the pure `parseReasonTopHits` helper extracted from `searchPeople`: pull up to N
 * RepresentativePubs out of a reason filter's `top` (top_hits) sub-agg. (The
 * single-pub `parseReasonTopHit` / `composeMatchReason` legacy chain was deleted in
 * #1440 / #967 Phase 3.) No live cluster: this is the logic the agg JSON and the
 * render depend on.
 */
import { describe, expect, it } from "vitest";
import { parseReasonTopHits } from "@/lib/api/search";

type HitArg = { pmid?: string | number; title?: string; year?: number | null; titleHighlight?: string };

function hitOf(args: HitArg) {
  return {
    _source: { pmid: args.pmid, title: args.title, year: args.year },
    ...(args.titleHighlight ? { highlight: { title: [args.titleHighlight] } } : {}),
  };
}

// A multi-hit top_hits sub-agg (rep-papers disclosure shows up to 3).
function topHits(args: HitArg[]) {
  return { top: { hits: { hits: args.map(hitOf) } } };
}

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
