import { describe, expect, it } from "vitest";
import {
  collapseResearchTypeChildren,
  parseResearchTypeValue,
  researchTypeChildRows,
  researchTypeLabel,
  toggleResearchTypeValue,
  isClinicalPub,
  isLabPub,
  researchTypesFrom,
  researchVolumeByCwid,
  type NihTriangleRow,
} from "@/lib/research-type";

const nih = (o: Partial<NihTriangleRow>): NihTriangleRow => ({
  year: 2024,
  is_research_article: "True",
  is_clinical: "False",
  human: 0,
  animal: 0,
  molecular_cellular: 0,
  ...o,
});

describe("isLabPub / isClinicalPub", () => {
  it("lab = molecular_cellular + animal ≥ 0.5 on a research article", () => {
    expect(isLabPub(nih({ molecular_cellular: 0.3, animal: 0.2 }))).toBe(true);
    expect(isLabPub(nih({ molecular_cellular: 0.3, animal: 0.1 }))).toBe(false);
    expect(isLabPub(nih({ molecular_cellular: 1, is_research_article: "False" }))).toBe(false);
  });
  it("clinical = human ≥ 0.5 or is_clinical on a research article", () => {
    expect(isClinicalPub(nih({ human: 0.5 }))).toBe(true);
    expect(isClinicalPub(nih({ human: 0.1, is_clinical: "True" }))).toBe(true);
    expect(isClinicalPub(nih({ human: 0.4 }))).toBe(false);
    expect(isClinicalPub(nih({ human: 1, is_research_article: "False" }))).toBe(false);
  });
});

describe("researchVolumeByCwid", () => {
  const byPmid = new Map<number, NihTriangleRow>([
    [1, nih({ molecular_cellular: 0.9 })],
    [2, nih({ human: 0.9 })],
    [3, nih({ molecular_cellular: 0.5, human: 0.5 })], // counts toward both
    [4, nih({ molecular_cellular: 0.9, year: 2019 })], // out of window
  ]);
  const a = (pmid: string, cwid: string, isFirst = true, isLast = false) => ({ pmid, cwid, isFirst, isLast });

  it("counts first/last-author in-window papers, dedupes, zero-fills every cwid", () => {
    const v = researchVolumeByCwid(
      [a("1", "x"), a("1", "x"), a("2", "x", false, true), a("3", "x"), a("4", "x"), a("1", "y", false, false)],
      byPmid,
      ["x", "y", "z"],
      2021,
    );
    expect(v.get("x")).toEqual({ lab: 2, clinical: 2 });
    expect(v.get("y")).toEqual({ lab: 0, clinical: 0 }); // middle author only
    expect(v.get("z")).toEqual({ lab: 0, clinical: 0 });
  });

  it("ignores non-numeric (external article_id) pmids and cwids outside the set", () => {
    const v = researchVolumeByCwid([a("ext-abc", "x"), a("1", "q")], byPmid, ["x"], 2021);
    expect(v.get("x")).toEqual({ lab: 0, clinical: 0 });
    expect(v.has("q")).toBe(false);
  });
});

describe("researchTypesFrom", () => {
  it("applies the ≥3 threshold independently; NULL yields nothing", () => {
    expect(researchTypesFrom(3, 2)).toEqual(["lab"]);
    expect(researchTypesFrom(2, 3)).toEqual(["clinical"]);
    expect(researchTypesFrom(7, 12)).toEqual(["lab", "clinical"]);
    expect(researchTypesFrom(null, null)).toEqual([]);
  });
});

describe("nested research type values", () => {
  it("parses parents and children; rejects anything else", () => {
    expect(parseResearchTypeValue("lab")).toEqual({ kind: "lab" });
    expect(parseResearchTypeValue("clinical:physician")).toEqual({
      kind: "clinical",
      child: "physician",
    });
    expect(parseResearchTypeValue("lab:other")).toEqual({ kind: "lab", child: "other" });
    for (const bad of ["", "toString", "lab:md", "lab:physician:x", "other"]) {
      expect(parseResearchTypeValue(bad)).toBeNull();
    }
  });

  it("chip labels: parent alone, child as 'Parent: Child', unknown passes through", () => {
    expect(researchTypeLabel("lab")).toBe("Laboratory research");
    expect(researchTypeLabel("lab:physician")).toBe("Laboratory research: Physician-scientist");
    expect(researchTypeLabel("lab:other")).toBe("Laboratory research: Basic scientist");
    expect(researchTypeLabel("clinical:physician")).toBe("Clinical research: Physician-scientist");
    expect(researchTypeLabel("clinical:other")).toBe(
      "Clinical research: Clinical or population researcher",
    );
    expect(researchTypeLabel("bogus")).toBe("bogus");
  });

  it("collapse maps children to their parent, deduped, order kept", () => {
    expect(collapseResearchTypeChildren(["lab:physician", "clinical", "lab", "lab:other"])).toEqual([
      "lab",
      "clinical",
    ]);
    expect(collapseResearchTypeChildren(["bogus"])).toEqual(["bogus"]);
  });

  it("toggle: a parent replaces its children, other kinds kept", () => {
    expect(toggleResearchTypeValue(["lab:physician", "lab:other", "clinical:other"], "lab")).toEqual([
      "clinical:other",
      "lab",
    ]);
    // Ticking the second child is the parent.
    expect(toggleResearchTypeValue(["lab:physician", "clinical"], "lab:other")).toEqual([
      "clinical",
      "lab",
    ]);
    // Unticking a child of a ticked parent leaves its sibling.
    expect(toggleResearchTypeValue(["lab", "clinical"], "lab:physician")).toEqual([
      "clinical",
      "lab:other",
    ]);
    expect(toggleResearchTypeValue(["clinical"], "clinical:other")).toEqual(["clinical:physician"]);
    // Unticking removes only that value.
    expect(toggleResearchTypeValue(["lab:physician", "clinical"], "lab:physician")).toEqual([
      "clinical",
    ]);
    // Old plain links keep working.
    expect(toggleResearchTypeValue([], "lab")).toEqual(["lab"]);
  });

  it("child rows: physician first, hidden without counts (flag off) or when both are 0 (pre-reindex)", () => {
    expect(researchTypeChildRows({ value: "lab", physician: 3, other: 5 }, ["lab:other"])).toEqual([
      { value: "lab:physician", label: "Physician-scientist", count: 3, isActive: false },
      { value: "lab:other", label: "Basic scientist", count: 5, isActive: true },
    ]);
    expect(researchTypeChildRows({ value: "clinical", physician: 0, other: 2 }, [])).toEqual([
      {
        value: "clinical:other",
        label: "Clinical or population researcher",
        count: 2,
        isActive: false,
      },
    ]);
    // A ticked zero-count child stays visible so it can be unticked.
    expect(
      researchTypeChildRows({ value: "clinical", physician: 0, other: 2 }, ["clinical:physician"]),
    ).toHaveLength(2);
    // A ticked parent ticks both children.
    expect(
      researchTypeChildRows({ value: "lab", physician: 3, other: 5 }, ["lab"]).map((r) => r.isActive),
    ).toEqual([true, true]);
    expect(researchTypeChildRows({ value: "lab" }, [])).toEqual([]);
    expect(researchTypeChildRows({ value: "lab", physician: 0, other: 0 }, [])).toEqual([]);
    expect(researchTypeChildRows({ value: "bogus", physician: 1, other: 1 }, [])).toEqual([]);
  });
});
