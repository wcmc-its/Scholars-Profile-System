import { describe, expect, it } from "vitest";
import {
  briefAngle,
  briefAngleRole,
  briefDataSources,
  briefSourceLabel,
  dedupeMethods,
  normalizeMethodName,
  splitMethods,
} from "@/lib/edit/matcha-brief-types";

describe("briefAngle", () => {
  const generated = { why: "w", topics: [], removedCount: 0 };
  it("prefers the edit, then the generated angle", () => {
    expect(briefAngle({ generated: { ...generated, angle: "Gen." }, edited: null })).toBe("Gen.");
    expect(
      briefAngle({ generated: { ...generated, angle: "Gen." }, edited: { angle: "Mine." } }),
    ).toBe("Mine.");
  });
  it('treats a brief stored before angles existed as ""', () => {
    expect(briefAngle({ generated, edited: null })).toBe("");
    expect(briefAngle({ generated, edited: { why: "x" } })).toBe("");
  });
});

describe("briefSourceLabel — PubMed markup in pub titles", () => {
  it("strips tags and decodes entities before the word cut", () => {
    const label = briefSourceLabel({
      kind: "pub",
      pmid: "1",
      year: 2023,
      title: "<i>Mycobacterium tuberculosis</i> drives disease in adults aged &lt;18 years",
    });
    expect(label).toBe("2023 · Mycobacterium tuberculosis drives disease in adults…");
    expect(label).not.toMatch(/[<>]|&lt;/);
  });

  it("decodes an entity that survives the cut", () => {
    expect(
      briefSourceLabel({ kind: "pub", pmid: "2", year: null, title: "Children &lt;5 years" }),
    ).toBe("Children <5 years");
  });
});

describe("briefAngleRole / briefDataSources", () => {
  const generated = { why: "w", topics: [], removedCount: 0 };
  it("prefers the edited role, then the generated one", () => {
    const g = { ...generated, angleRole: "Trial lead" };
    expect(briefAngleRole({ generated: g, edited: null })).toBe("Trial lead");
    expect(briefAngleRole({ generated: g, edited: { angleRole: "Consultant" } })).toBe("Consultant");
    // An officer who cleared the role keeps it cleared.
    expect(briefAngleRole({ generated: g, edited: { angleRole: "" } })).toBe("");
  });
  it("an older brief has no role and no data sources", () => {
    expect(briefAngleRole({ generated, edited: { angle: "x" } })).toBe("");
    expect(briefDataSources({ generated })).toEqual([]);
    expect(briefDataSources({ generated: { ...generated, dataSources: ["A registry"] } })).toEqual([
      "A registry",
    ]);
  });
});

describe("method helpers", () => {
  const methods = [
    { name: "Regional Cancer Registry", papers: 12 },
    { name: "RNA-seq", papers: 8 },
    { name: "Mouse models", papers: 5 },
    { name: "RNA seq", papers: 3 },
    { name: "mouse models.", papers: 9 },
  ];

  it("normalizes case, whitespace and punctuation", () => {
    expect(normalizeMethodName("  RNA-Seq ")).toBe("rna seq");
    expect(normalizeMethodName("Mouse   models.")).toBe("mouse models");
  });

  it("dedupes by normalized name, keeping the higher paper count in the first position", () => {
    expect(dedupeMethods(methods)).toEqual([
      { name: "Regional Cancer Registry", papers: 12 },
      { name: "RNA-seq", papers: 8 },
      { name: "mouse models.", papers: 9 },
    ]);
  });

  it("splits data sources from methods, case-insensitively, keeping order", () => {
    const { dataSources, methods: rest } = splitMethods(methods, ["regional cancer registry"]);
    expect(dataSources.map((m) => m.name)).toEqual(["Regional Cancer Registry"]);
    expect(rest.map((m) => m.name)).toEqual(["RNA-seq", "Mouse models", "RNA seq", "mouse models."]);
  });

  it("no data-source names (an older brief): everything is a method", () => {
    const { dataSources, methods: rest } = splitMethods(methods, []);
    expect(dataSources).toEqual([]);
    expect(rest).toEqual(methods);
  });
});
