/**
 * Matcha report v2: coverage cells, totals, gaps, and the theme-output validator.
 * All fixtures are invented.
 */
import { describe, expect, it } from "vitest";
import {
  PRIMARY_RANK,
  bestRank,
  computeCoverage,
  coverageMark,
  joinWords,
  numberWord,
  validateThemes,
} from "@/lib/edit/matcha-report-coverage";

const THEMES = [
  { label: "Widget biology", terms: ["widgets", "gizmo signalling"] },
  { label: "Sprocket outcomes", terms: ["sprockets"] },
  { label: "Doohickey models", terms: ["doohickeys"] },
];

describe("coverage marks", () => {
  it("is primary at the K boundary, related just past it, none when absent", () => {
    expect(PRIMARY_RANK).toBe(10);
    expect(coverageMark(1)).toBe("primary");
    expect(coverageMark(PRIMARY_RANK)).toBe("primary");
    expect(coverageMark(PRIMARY_RANK + 1)).toBe("related");
    expect(coverageMark(null)).toBe("none");
  });

  it("takes the best (lowest) rank over the theme's concepts", () => {
    const contributions = [
      { term: "widgets", rank: 40 },
      { term: "gizmo signalling", rank: 7 },
      { term: "sprockets", rank: 2 },
    ];
    expect(bestRank(contributions, THEMES[0].terms)).toBe(7);
    expect(bestRank(contributions, THEMES[2].terms)).toBeNull();
  });
});

describe("computeCoverage", () => {
  const pis = [
    {
      cwid: "aaa1001",
      contributions: [
        { term: "widgets", rank: 10 },
        { term: "sprockets", rank: 30 },
      ],
    },
    {
      cwid: "bbb2002",
      contributions: [
        { term: "gizmo signalling", rank: 11 },
        { term: "sprockets", rank: 12 },
      ],
    },
    { cwid: "ccc3003", contributions: [] },
  ];

  it("builds marks per PI and theme", () => {
    const { rows } = computeCoverage(pis, THEMES);
    expect(rows.map((r) => r.marks)).toEqual([
      ["primary", "related", "none"],
      ["related", "related", "none"],
      ["none", "none", "none"],
    ]);
  });

  it("totals count PIs with any mark, with None for an empty theme", () => {
    expect(computeCoverage(pis, THEMES).totals).toEqual(["2", "2", "None"]);
  });

  it("gaps are exactly the themes with no primary cell; closest = best related rank", () => {
    const { gaps } = computeCoverage(pis, THEMES);
    expect(gaps).toEqual([
      { label: "Sprocket outcomes", closestCwid: "bbb2002" },
      { label: "Doohickey models", closestCwid: null },
    ]);
  });

  it("ties for closest go to the PI listed first", () => {
    const tied = [
      { cwid: "x1", contributions: [{ term: "doohickeys", rank: 20 }] },
      { cwid: "x2", contributions: [{ term: "doohickeys", rank: 20 }] },
    ];
    const gap = computeCoverage(tied, THEMES).gaps.find((g) => g.label === "Doohickey models");
    expect(gap?.closestCwid).toBe("x1");
  });
});

describe("validateThemes", () => {
  const terms = ["widgets", "gizmo signalling", "sprockets", "doohickeys"];

  it("accepts a full, exact assignment and canonicalises spelling", () => {
    const out = validateThemes(
      {
        themes: [
          { label: " Widget  biology ", terms: ["Widgets", "gizmo signalling "] },
          { label: "Other parts", terms: ["sprockets", "doohickeys"] },
        ],
      },
      terms,
    );
    expect(out).toEqual([
      { label: "Widget biology", terms: ["widgets", "gizmo signalling"] },
      { label: "Other parts", terms: ["sprockets", "doohickeys"] },
    ]);
  });

  it("rejects a missing term", () => {
    expect(
      validateThemes(
        { themes: [{ label: "A", terms: ["widgets", "gizmo signalling", "sprockets"] }] },
        terms,
      ),
    ).toBeNull();
  });

  it("rejects an unknown term", () => {
    expect(
      validateThemes({ themes: [{ label: "A", terms: [...terms, "thingamajig"] }] }, terms),
    ).toBeNull();
  });

  it("rejects a term assigned twice", () => {
    expect(
      validateThemes(
        {
          themes: [
            { label: "A", terms },
            { label: "B", terms: ["widgets"] },
          ],
        },
        terms,
      ),
    ).toBeNull();
  });

  it("rejects zero themes, more than six, an empty theme and an over-long label", () => {
    expect(validateThemes({ themes: [] }, terms)).toBeNull();
    const seven = Array.from({ length: 7 }, (_, i) => ({ label: `T${i}`, terms: [] as string[] }));
    terms.forEach((t, i) => seven[i].terms.push(t));
    expect(validateThemes({ themes: seven }, terms)).toBeNull();
    expect(
      validateThemes(
        {
          themes: [
            { label: "A", terms },
            { label: "Empty", terms: [] },
          ],
        },
        terms,
      ),
    ).toBeNull();
    expect(
      validateThemes({ themes: [{ label: "one two three four five six seven", terms }] }, terms),
    ).toBeNull();
    expect(validateThemes(null, terms)).toBeNull();
    expect(validateThemes({ themes: [{ label: 3, terms }] }, terms)).toBeNull();
  });
});

describe("words", () => {
  it("spells small counts", () => {
    expect(numberWord(1)).toBe("one");
    expect(numberWord(11)).toBe("eleven");
    expect(numberWord(23)).toBe("twenty-three");
    expect(numberWord(50)).toBe("fifty");
    expect(numberWord(75)).toBe("75");
    expect(joinWords(["a", "b", "c"], "or")).toBe("a, b or c");
  });
});
