import { describe, expect, it } from "vitest";
import {
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
