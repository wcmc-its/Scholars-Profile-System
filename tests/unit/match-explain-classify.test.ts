/**
 * #702 — classifyHitExplain mirrors the people-result-card precedence:
 *   self snippet → pub snippet → MeSH note → "Matched on" chip.
 * The note renders independently of a snippet (so `showsNote` can be true
 * alongside `showsSelf`/`showsPub`); the chip is last-resort (only when nothing
 * else shows). `nonBlank` is the OR — the blank-card metric the eval reports.
 */
import { describe, expect, it } from "vitest";
import { classifyHitExplain } from "@/lib/api/match-explain";

const base = {
  highlight: undefined,
  pubHighlight: undefined,
  matchProvenance: undefined,
  matchedOnFields: undefined,
} as const;

describe("classifyHitExplain (#702)", () => {
  it("self snippet wins over everything", () => {
    const c = classifyHitExplain({
      ...base,
      highlight: ["<mark>x</mark>"],
      pubHighlight: ["<mark>y</mark>"],
      matchedOnFields: ["publications"],
    });
    expect(c.primary).toBe("self");
    expect(c).toMatchObject({ showsSelf: true, showsPub: false, showsChip: false, nonBlank: true });
  });

  it("pub snippet shows when there is no self snippet", () => {
    const c = classifyHitExplain({ ...base, pubHighlight: ["<mark>y</mark>"], matchedOnFields: ["publications"] });
    expect(c.primary).toBe("pub");
    expect(c).toMatchObject({ showsPub: true, showsChip: false, nonBlank: true });
  });

  it("MeSH note shows independently and is primary when no snippet", () => {
    const withSnippet = classifyHitExplain({
      ...base,
      highlight: ["<mark>x</mark>"],
      matchProvenance: { kind: "concept", parentTerm: "Microbiota" },
    });
    expect(withSnippet.primary).toBe("self");
    expect(withSnippet.showsNote).toBe(true);

    const noSnippet = classifyHitExplain({
      ...base,
      matchProvenance: { kind: "concept", parentTerm: "Microbiota" },
      matchedOnFields: ["publications"],
    });
    expect(noSnippet.primary).toBe("note");
    expect(noSnippet.showsChip).toBe(false); // note suppresses the chip
  });

  it("chip is the last resort — only when nothing else explains the match", () => {
    const c = classifyHitExplain({ ...base, matchedOnFields: ["department", "publications"] });
    expect(c.primary).toBe("chip");
    expect(c.nonBlank).toBe(true);
  });

  it("blank when no element and for empty arrays", () => {
    expect(classifyHitExplain(base).primary).toBe("blank");
    expect(classifyHitExplain(base).nonBlank).toBe(false);
    expect(
      classifyHitExplain({ highlight: [], pubHighlight: [], matchProvenance: undefined, matchedOnFields: [] })
        .nonBlank,
    ).toBe(false);
  });
});
