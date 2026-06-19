import { describe, it, expect } from "vitest";
import {
  assignProgramColors,
  buildPeopleEdges,
  buildProgramEdges,
  computeCoPubCounts,
  countOmittedHyperauthored,
  nodeRadius,
  paperInYear,
  programKey,
  yearExtent,
  OKABE_ITO,
  UNCLASSIFIED_COLOR,
  UNCLASSIFIED_KEY,
} from "@/lib/center-collaboration/graph";
import type { CollabPaper } from "@/lib/center-collaboration/types";

// Fixture: 5 members, programs CB/CB/CPC/null/CT at indices 0..4.
const programOf = (idx: number): string | null =>
  [["CB"], ["CB"], ["CPC"], [null], ["CT"]][idx]?.[0] ?? null;

const papers: CollabPaper[] = [
  { pmid: "1", year: 2020, m: [0, 1] }, // CB-CB
  { pmid: "2", year: 2021, m: [0, 1, 2] }, // CB,CB,CPC
  { pmid: "3", year: 2019, m: [2, 3] }, // CPC,null
  { pmid: "4", year: null, m: [0, 4] }, // CB,CT
];

describe("assignProgramColors", () => {
  it("assigns Okabe-Ito by sortOrder and gray for the null group", () => {
    const out = assignProgramColors([
      { code: "CB", label: "Cancer Biology" },
      { code: "CPC", label: "Prevention" },
      { code: null, label: "Unclassified" },
      { code: "CT", label: "Therapeutics" },
    ]);
    expect(out[0].color).toBe(OKABE_ITO[0]);
    expect(out[1].color).toBe(OKABE_ITO[1]);
    expect(out[2].color).toBe(UNCLASSIFIED_COLOR); // null does not consume a slot
    expect(out[3].color).toBe(OKABE_ITO[2]); // CT gets slot 2, unaffected by null
  });
});

describe("paperInYear", () => {
  const p = (year: number | null): CollabPaper => ({ pmid: "x", year, m: [0, 1] });
  it("includes everything when no range is given", () => {
    expect(paperInYear(p(2000))).toBe(true);
    expect(paperInYear(p(null))).toBe(true);
  });
  it("respects inclusive bounds and drops null-year under a filter", () => {
    expect(paperInYear(p(2020), [2019, 2021])).toBe(true);
    expect(paperInYear(p(2018), [2019, 2021])).toBe(false);
    expect(paperInYear(p(2022), [2019, 2021])).toBe(false);
    expect(paperInYear(p(null), [2019, 2021])).toBe(false);
    expect(paperInYear(p(null), [null, null])).toBe(true); // open range = no filter
  });
});

describe("buildPeopleEdges", () => {
  it("counts shared papers pairwise", () => {
    const edges = buildPeopleEdges(papers);
    const w = new Map(edges.map((e) => [`${e.a}-${e.b}`, e.weight]));
    expect(w.get("0-1")).toBe(2); // p1 + p2
    expect(w.get("0-2")).toBe(1);
    expect(w.get("1-2")).toBe(1);
    expect(w.get("2-3")).toBe(1);
    expect(w.get("0-4")).toBe(1);
    expect(edges).toHaveLength(5);
  });

  it("applies Newman 1/(k-1) to strength but keeps raw weight", () => {
    const edges = buildPeopleEdges(papers, { newman: true });
    const ab = edges.find((e) => e.a === 0 && e.b === 1)!;
    expect(ab.weight).toBe(2); // raw count unchanged
    expect(ab.strength).toBeCloseTo(1 + 0.5); // p1 (k2 → 1) + p2 (k3 → 0.5)
  });

  it("excludes hyper-authored papers above the member cap", () => {
    const edges = buildPeopleEdges(papers, { maxMembersPerPaper: 2 });
    const keys = edges.map((e) => `${e.a}-${e.b}`).sort();
    expect(keys).toEqual(["0-1", "0-4", "2-3"]); // p2 (k=3) dropped → no 0-2/1-2
    expect(edges.find((e) => e.a === 0 && e.b === 1)!.weight).toBe(1); // only p1
  });

  it("filters by year range", () => {
    const edges = buildPeopleEdges(papers, { yearRange: [2020, 2021] });
    const keys = edges.map((e) => `${e.a}-${e.b}`).sort();
    expect(keys).toEqual(["0-1", "0-2", "1-2"]); // p1 + p2 only
  });

  it("keeps only within-program edges when asked", () => {
    const edges = buildPeopleEdges(papers, {
      withinProgramOnly: true,
      programOf: programOf,
    });
    const keys = edges.map((e) => `${e.a}-${e.b}`).sort();
    expect(keys).toEqual(["0-1"]); // only the CB-CB pair (0,1); 0-2/2-3/0-4 cross programs
    expect(edges[0].weight).toBe(2); // p1 + p2
  });
});

describe("buildProgramEdges", () => {
  it("counts cross-program distinct papers and within-program internals", () => {
    const { edges, internal } = buildProgramEdges(papers, programOf);
    const w = new Map(edges.map((e) => [`${e.a}|${e.b}`, e.weight]));
    expect(w.get("CB|CPC")).toBe(1); // p2
    expect(w.get(`CPC|${UNCLASSIFIED_KEY}`)).toBe(1); // p3
    expect(w.get("CB|CT")).toBe(1); // p4
    expect(internal.get("CB")).toBe(1); // p1 entirely within CB
    expect(edges).toHaveLength(3);
  });

  it("ignores the member cap (rollup is bounded by program count)", () => {
    const { edges } = buildProgramEdges(papers, programOf, { maxMembersPerPaper: 2 });
    expect(edges.find((e) => `${e.a}|${e.b}` === "CB|CPC")?.weight).toBe(1);
  });
});

describe("computeCoPubCounts", () => {
  it("counts within-center co-authored papers per node", () => {
    expect(computeCoPubCounts(papers, 5)).toEqual([3, 2, 2, 1, 1]);
  });
  it("respects year filter and member cap", () => {
    expect(computeCoPubCounts(papers, 5, { yearRange: [2020, 2021] })).toEqual([2, 2, 1, 0, 0]);
    expect(computeCoPubCounts(papers, 5, { maxMembersPerPaper: 2 })).toEqual([2, 1, 1, 1, 1]);
  });
  it("counts only same-program co-authorship under withinProgramOnly", () => {
    expect(
      computeCoPubCounts(papers, 5, { withinProgramOnly: true, programOf }),
    ).toEqual([2, 2, 0, 0, 0]); // only CB members 0,1 have a same-program co-author
  });
});

describe("countOmittedHyperauthored", () => {
  it("counts filtered papers over the cap", () => {
    expect(countOmittedHyperauthored(papers, { maxMembersPerPaper: 2 })).toBe(1); // p2
    expect(countOmittedHyperauthored(papers)).toBe(0); // default cap 25
  });
});

describe("nodeRadius", () => {
  it("floors, scales by sqrt, and caps", () => {
    expect(nodeRadius(0)).toBe(6);
    expect(nodeRadius(4)).toBe(12); // 6 + 3*2
    expect(nodeRadius(10000)).toBe(40); // capped
  });
});

describe("yearExtent", () => {
  it("returns min/max ignoring null years", () => {
    expect(yearExtent(papers)).toEqual([2019, 2021]);
  });
  it("returns null when no paper has a year", () => {
    expect(yearExtent([{ pmid: "x", year: null, m: [0, 1] }])).toBeNull();
  });
});

describe("programKey", () => {
  it("maps null to the unclassified key", () => {
    expect(programKey(null)).toBe(UNCLASSIFIED_KEY);
    expect(programKey("CB")).toBe("CB");
  });
});
