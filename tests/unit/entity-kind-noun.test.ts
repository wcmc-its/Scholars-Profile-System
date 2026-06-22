/**
 * #1168 — the dominant_kind → rail-noun map. Pure; locks the producer `kind` enum
 * to its Surface-B header noun + the null/unknown fallback.
 */
import { describe, expect, it } from "vitest";

import { entityKindNoun, entityKindNounForCount } from "@/lib/methods/entity-kind-noun";

describe("entityKindNoun", () => {
  it("maps each producer kind to its rail noun", () => {
    expect(entityKindNoun("instrument")).toBe("Instruments");
    expect(entityKindNoun("reagent")).toBe("Reagents");
    expect(entityKindNoun("organism_or_cells")).toBe("Cell lines");
    expect(entityKindNoun("assay")).toBe("Assays");
    expect(entityKindNoun("dataset")).toBe("Datasets");
    expect(entityKindNoun("software")).toBe("Software");
    expect(entityKindNoun("method")).toBe("Methods");
    expect(entityKindNoun("model")).toBe("Models");
  });

  it("falls back to 'Entities' for null / undefined / unknown kinds", () => {
    expect(entityKindNoun(null)).toBe("Entities");
    expect(entityKindNoun(undefined)).toBe("Entities");
    expect(entityKindNoun("nonsense")).toBe("Entities");
    expect(entityKindNoun("")).toBe("Entities");
  });
});

describe("entityKindNounForCount", () => {
  it("keeps the plural for any count !== 1", () => {
    expect(entityKindNounForCount("organism_or_cells", 29)).toBe("Cell lines");
    expect(entityKindNounForCount("organism_or_cells", 0)).toBe("Cell lines");
    expect(entityKindNounForCount(null, 7)).toBe("Entities");
  });

  it("depluralizes the closed noun set when count === 1", () => {
    expect(entityKindNounForCount("organism_or_cells", 1)).toBe("Cell line");
    expect(entityKindNounForCount("reagent", 1)).toBe("Reagent");
    expect(entityKindNounForCount("assay", 1)).toBe("Assay");
    expect(entityKindNounForCount("model", 1)).toBe("Model");
    // "ies" → "y", not a bare "s" drop.
    expect(entityKindNounForCount(null, 1)).toBe("Entity");
    // "Software" is uncountable (no trailing "s") → unchanged.
    expect(entityKindNounForCount("software", 1)).toBe("Software");
  });
});
