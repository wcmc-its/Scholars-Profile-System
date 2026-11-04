import { describe, expect, it } from "vitest";
import { briefSourceLabel } from "@/lib/edit/matcha-brief-types";

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
