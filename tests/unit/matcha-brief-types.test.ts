import { describe, expect, it } from "vitest";
import { briefAngle, briefSourceLabel } from "@/lib/edit/matcha-brief-types";

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
