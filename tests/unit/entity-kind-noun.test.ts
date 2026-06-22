/**
 * #1168 — the dominant_kind → rail-noun map. Pure; locks the producer `kind` enum
 * to its Surface-B header noun + the null/unknown fallback.
 */
import { describe, expect, it } from "vitest";

import { entityKindNoun } from "@/lib/methods/entity-kind-noun";

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
