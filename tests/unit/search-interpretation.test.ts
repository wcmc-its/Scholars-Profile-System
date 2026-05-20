/**
 * Issue #265 Phase 1 — pins the `MeshResolution` → `SearchInterpretation`
 * mapping. The popover client component reads from this shape; drift here
 * would silently swap the popover's body text without a TypeScript error.
 */
import { describe, expect, it } from "vitest";
import { buildSearchInterpretation } from "@/lib/api/search-interpretation";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const RESOLUTION: MeshResolution = {
  descriptorUi: "D057286",
  name: "Electronic Health Records",
  matchedForm: "electronic health records",
  confidence: "exact",
  scopeNote:
    "Media that store digital health information for individuals.",
  entryTerms: ["EHR", "EMR", "Electronic Medical Records"],
  curatedTopicAnchors: ["digital-health", "informatics"],
  descendantUis: ["D057286"],
};

describe("buildSearchInterpretation", () => {
  it("maps a resolved descriptor to mode `mesh-expanded` with a single meshMatches entry", () => {
    const result = buildSearchInterpretation(RESOLUTION);

    expect(result.mode).toBe("mesh-expanded");
    expect(result.meshMatches).toHaveLength(1);

    const match = result.meshMatches[0];
    expect(match.descriptorId).toBe("D057286");
    expect(match.name).toBe("Electronic Health Records");
    expect(match.entryTerms).toEqual([
      "EHR",
      "EMR",
      "Electronic Medical Records",
    ]);
    expect(match.scopeNote).toBe(
      "Media that store digital health information for individuals.",
    );
    expect(match.confidence).toBe("exact");
  });

  it("maps a null resolution to mode `free-text` with an empty meshMatches array", () => {
    const result = buildSearchInterpretation(null);
    expect(result.mode).toBe("free-text");
    expect(result.meshMatches).toEqual([]);
  });

  it("preserves entry-term confidence so the popover can render the `Matched on <form>` line", () => {
    const result = buildSearchInterpretation({
      ...RESOLUTION,
      confidence: "entry-term",
      matchedForm: "EHR",
    });
    expect(result.meshMatches[0].confidence).toBe("entry-term");
  });

  it("preserves a null scope note so the popover can suppress the paragraph", () => {
    const result = buildSearchInterpretation({
      ...RESOLUTION,
      scopeNote: null,
    });
    expect(result.meshMatches[0].scopeNote).toBeNull();
  });

  it("does not invent an `mesh-only` mode (carved to #396)", () => {
    // Phase 1 enum is binary. If a future commit re-introduces `mesh-only`
    // here without resolving #396's MEDLINE-indexed semantic, this assertion
    // will fail and force a re-look.
    const r1 = buildSearchInterpretation(RESOLUTION);
    const r2 = buildSearchInterpretation(null);
    const modes: string[] = [r1.mode, r2.mode];
    expect(modes).not.toContain("mesh-only");
  });
});
