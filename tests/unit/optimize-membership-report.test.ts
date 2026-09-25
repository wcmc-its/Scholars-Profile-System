/**
 * Report 1's pure half (`lib/edit/optimize-membership-report.ts`): URL params
 * (parse, defaults left out), the three lists (recruit exclusive of
 * collaborators; filters narrow every list), rule text, header sort by
 * surname, the download note (withheld above the cap), the Criteria rows.
 */
import { describe, expect, it } from "vitest";

import {
  bucketLists,
  clampThreshold,
  DEFAULT_OPTIMIZE_PARAMS,
  describeOptimizeCriteria,
  filterRows,
  formatRefreshed,
  institutionOptions,
  listWithheldNote,
  optimizeDownloadNote,
  optimizeQueryString,
  optimizeSheetRow,
  parseOptimizeParams,
  ruleText,
  sortRows,
  type CollabRow,
  type OptimizeParams,
} from "@/lib/edit/optimize-membership-report";

function row(over: Partial<CollabRow> & { cwid: string }): CollabRow {
  return {
    surname: over.cwid,
    givenName: "G",
    primaryDepartment: "Medicine",
    institution: "Weill Cornell Medicine",
    totalPapersPostCutoff: 10,
    collaborationsWithCenter: 0,
    cancerRelatedPapers: 0,
    isCurrentMember: false,
    currentProgramCode: null,
    programLabel: null,
    ...over,
  };
}

const ROWS = [
  row({
    cwid: "m1",
    surname: "Member",
    isCurrentMember: true,
    currentProgramCode: "CB",
    programLabel: "Cancer Biology",
  }),
  row({ cwid: "m2", surname: "Linked", isCurrentMember: true, collaborationsWithCenter: 4 }),
  row({ cwid: "c1", surname: "Collab", collaborationsWithCenter: 3, cancerRelatedPapers: 5 }),
  row({
    cwid: "r1",
    surname: "Recruit",
    collaborationsWithCenter: 1,
    cancerRelatedPapers: 4,
    institution: "NewYork-Presbyterian",
  }),
  row({ cwid: "n1", surname: "Neither", collaborationsWithCenter: 1, cancerRelatedPapers: 1 }),
];

const P = (over: Partial<OptimizeParams> = {}): OptimizeParams => ({
  ...DEFAULT_OPTIMIZE_PARAMS,
  ...over,
});

describe("parseOptimizeParams / optimizeQueryString", () => {
  it("defaults to 2 papers / 3 papers on the Remove tab", () => {
    expect(parseOptimizeParams(new URLSearchParams())).toEqual(DEFAULT_OPTIMIZE_PARAMS);
    expect(DEFAULT_OPTIMIZE_PARAMS).toMatchObject({
      c: 2,
      cmode: "count",
      x: 3,
      xmode: "count",
      tab: "remove",
    });
  });

  it("reads every param and round-trips, leaving defaults out", () => {
    const sp = new URLSearchParams(
      "c=15&cmode=percent&x=5&xmode=count&tab=recruit&q=smith&inst=NewYork-Presbyterian",
    );
    const p = parseOptimizeParams(sp);
    expect(p).toEqual({
      c: 15,
      cmode: "percent",
      x: 5,
      xmode: "count",
      tab: "recruit",
      q: "smith",
      inst: "NewYork-Presbyterian",
    });
    expect(parseOptimizeParams(new URLSearchParams(optimizeQueryString(p)))).toEqual(p);
    expect(optimizeQueryString(DEFAULT_OPTIMIZE_PARAMS)).toBe("");
    // A percent mode at its own default (10) carries only the mode.
    expect(optimizeQueryString(P({ cmode: "percent", c: 10 }))).toBe("cmode=percent");
  });

  it("uses the unit's default when a value is missing or junk, and caps percent at 100", () => {
    expect(parseOptimizeParams(new URLSearchParams("cmode=percent&xmode=percent"))).toMatchObject({
      c: 10,
      x: 20,
    });
    expect(
      parseOptimizeParams(new URLSearchParams("c=-3&x=abc&tab=bogus&cmode=nope")),
    ).toMatchObject({
      c: 2,
      x: 3,
      tab: "remove",
      cmode: "count",
    });
    expect(parseOptimizeParams(new URLSearchParams("c=250&cmode=percent")).c).toBe(100);
    expect(clampThreshold("7.9", "count", 0)).toBe(7);
    expect(clampThreshold("", "count", 4)).toBe(4);
  });

  it("leaves the tab out of the download's query string", () => {
    expect(optimizeQueryString(P({ tab: "collab", c: 4 }), false)).toBe("c=4");
  });
});

describe("bucketLists", () => {
  it("Remove = members with zero collaboration; recruit is exclusive of collaborators", () => {
    const l = bucketLists(ROWS, P());
    expect(l.remove.map((r) => r.cwid)).toEqual(["m1"]);
    expect(l.collab.map((r) => r.cwid)).toEqual(["c1"]);
    expect(l.recruit.map((r) => r.cwid)).toEqual(["r1"]);
  });

  it("thresholds move people between the Add lists; Remove never moves", () => {
    const l = bucketLists(ROWS, P({ c: 1 }));
    expect(l.collab.map((r) => r.cwid).sort()).toEqual(["c1", "r1"]);
    expect(l.recruit).toEqual([]);
    expect(l.remove.map((r) => r.cwid)).toEqual(["m1"]);
    // Percent mode: 30% co-authored clears c1 (3/10) but not r1 (1/10).
    const pc = bucketLists(ROWS, P({ cmode: "percent", c: 30 }));
    expect(pc.collab.map((r) => r.cwid)).toEqual(["c1"]);
  });

  it("the search box and institution select narrow every list", () => {
    expect(bucketLists(ROWS, P({ inst: "NewYork-Presbyterian" }))).toMatchObject({
      remove: [],
      collab: [],
    });
    expect(bucketLists(ROWS, P({ q: "recr" })).recruit.map((r) => r.cwid)).toEqual(["r1"]);
    expect(filterRows(ROWS, { q: "medicine", inst: "" })).toHaveLength(ROWS.length);
  });
});

describe("ruleText", () => {
  it("states the live thresholds, in count or percent wording", () => {
    expect(ruleText("collab", P())).toContain("at least 2 co-authored papers with members");
    expect(ruleText("collab", P())).toContain("at least 3 cancer-related papers");
    expect(ruleText("recruit", P({ cmode: "percent", c: 15, x: 1 }))).toBe(
      "Not members and not yet connected (fewer than 15% of papers co-authored with members), but have at least 1 cancer-related paper. Candidates for outreach.",
    );
    expect(ruleText("remove", P())).toMatch(/^Current members who haven.t co-authored/);
  });
});

describe("sortRows", () => {
  it("sorts names by surname and numbers with a name tiebreak, either direction", () => {
    const rows = [
      row({ cwid: "a", surname: "Zed", givenName: "Amy", totalPapersPostCutoff: 5 }),
      row({ cwid: "b", surname: "Abe", givenName: "Zoe", totalPapersPostCutoff: 5 }),
      row({ cwid: "c", surname: "Moe", totalPapersPostCutoff: 9 }),
    ];
    expect(sortRows(rows, "name", 1).map((r) => r.cwid)).toEqual(["b", "c", "a"]);
    expect(sortRows(rows, "name", -1).map((r) => r.cwid)).toEqual(["a", "c", "b"]);
    expect(sortRows(rows, "papers", -1).map((r) => r.cwid)).toEqual(["c", "b", "a"]);
  });
});

describe("downloads", () => {
  it("the note says a list over the cap is withheld, naming it", () => {
    const lists = bucketLists(ROWS, P());
    expect(optimizeDownloadNote(lists, 50)).toEqual({
      text: "One sheet per list, plus a Criteria sheet with the thresholds.",
      withheld: false,
    });
    const note = optimizeDownloadNote(
      { ...lists, recruit: Array.from({ length: 51 }, (_, i) => row({ cwid: `x${i}` })) },
      50,
    );
    expect(note.withheld).toBe(true);
    expect(note.text).toContain("withheld");
    expect(note.text).toContain("Add: recruits (51)");
    expect(listWithheldNote("Remove", 60, 50)).toContain(
      "60 people exceeds the 50-person export limit",
    );
  });

  it("Criteria records every threshold and filter, All when unset", () => {
    const rows = describeOptimizeCriteria(
      P({ c: 4, xmode: "percent", x: 25, inst: "NewYork-Presbyterian" }),
      "Meyer",
      new Date("2026-09-25T12:00:00Z"),
      "2026-09-20T12:05:00.000Z",
      50,
    );
    const m = new Map(rows);
    expect(m.get("Center")).toBe("Meyer");
    expect(m.get("Collaboration threshold")).toBe("At least 4 co-authored with members (count)");
    expect(m.get("Cancer-relevance threshold")).toBe("At least 25% of papers cancer-related");
    expect(m.get("Search")).toBe("All");
    expect(m.get("Institution")).toBe("NewYork-Presbyterian");
    expect(m.get("Data last refreshed")).toBe("2026-09-20T12:05:00.000Z");
    expect(m.get("Export limit")).toContain("more than 50 people is withheld");
  });

  it("a sheet row carries the table's columns, program name included", () => {
    expect(optimizeSheetRow(ROWS[0])).toEqual([
      "m1",
      "G Member",
      "Medicine",
      "Weill Cornell Medicine",
      10,
      0,
      0,
      0,
      0,
      "CB",
      "Cancer Biology",
    ]);
  });
});

describe("helpers", () => {
  it("institution options are distinct, non-empty, sorted", () => {
    expect(institutionOptions([...ROWS, row({ cwid: "z", institution: "" })])).toEqual([
      "NewYork-Presbyterian",
      "Weill Cornell Medicine",
    ]);
  });

  it("formats the refreshed stamp in New York time, en-US", () => {
    expect(formatRefreshed("2026-09-20T12:05:00Z")).toBe("Sep 20, 2026, 8:05 AM");
  });
});
