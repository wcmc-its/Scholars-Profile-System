/**
 * `normalizeOverviewParams` (#742 Phase A). The trust boundary for a generate
 * request's `params`: unknown enums fall back to the default, the element list is
 * filtered to known keys + de-duped, and `instructions` is coerced + trimmed +
 * clamped. It must NEVER throw — a garbage value normalizes to a usable shape.
 * No DB, no network.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OVERVIEW_PARAMS,
  isOverviewSelectionEmpty,
  OVERVIEW_INSTRUCTIONS_MAX,
  OVERVIEW_SELECTION_MAX_ITEMS,
  OVERVIEW_SELECTION_MAX_TOOLS,
  normalizeOverviewParams,
  normalizeOverviewSelection,
} from "@/lib/edit/overview-params";

/**
 * The shape an empty / garbage input normalizes to: the default ENUMS, but an
 * empty element list — the DEFAULT_OVERVIEW_PARAMS element trio is the UI
 * starting point, NOT a normalization fallback for a missing array (the contract
 * specifies "filter raw array … [] allowed").
 */
const NORMALIZED_EMPTY = {
  voice: DEFAULT_OVERVIEW_PARAMS.voice,
  tone: DEFAULT_OVERVIEW_PARAMS.tone,
  length: DEFAULT_OVERVIEW_PARAMS.length,
  elements: [],
  instructions: "",
};

describe("normalizeOverviewParams — enum defaulting", () => {
  it("returns the default enums + empty elements for an empty object", () => {
    expect(normalizeOverviewParams({})).toEqual(NORMALIZED_EMPTY);
  });

  it("falls back to defaults for unknown voice / tone / length", () => {
    const out = normalizeOverviewParams({
      voice: "fourth",
      tone: "snarky",
      length: "epic",
      elements: [],
    });
    expect(out.voice).toBe(DEFAULT_OVERVIEW_PARAMS.voice);
    expect(out.tone).toBe(DEFAULT_OVERVIEW_PARAMS.tone);
    expect(out.length).toBe(DEFAULT_OVERVIEW_PARAMS.length);
  });

  it("preserves valid non-default enum values", () => {
    const out = normalizeOverviewParams({
      voice: "first",
      tone: "conversational",
      length: "extended",
      elements: [],
    });
    expect(out.voice).toBe("first");
    expect(out.tone).toBe("conversational");
    expect(out.length).toBe("extended");
  });

  it("falls back when an enum is the wrong type (number / object / null)", () => {
    const out = normalizeOverviewParams({ voice: 1, tone: {}, length: null });
    expect(out.voice).toBe(DEFAULT_OVERVIEW_PARAMS.voice);
    expect(out.tone).toBe(DEFAULT_OVERVIEW_PARAMS.tone);
    expect(out.length).toBe(DEFAULT_OVERVIEW_PARAMS.length);
  });
});

describe("normalizeOverviewParams — element filtering", () => {
  it("filters out unknown element keys", () => {
    const out = normalizeOverviewParams({
      elements: ["research_focus", "not_a_theme", "methods", 42, null],
    });
    expect(out.elements).toEqual(["research_focus", "methods"]);
  });

  it("de-dupes repeated keys, preserving first-seen order", () => {
    const out = normalizeOverviewParams({
      elements: ["methods", "research_focus", "methods", "research_focus"],
    });
    expect(out.elements).toEqual(["methods", "research_focus"]);
  });

  it("allows an empty element list", () => {
    expect(normalizeOverviewParams({ elements: [] }).elements).toEqual([]);
  });

  it("treats a non-array elements value as empty", () => {
    expect(normalizeOverviewParams({ elements: "research_focus" }).elements).toEqual([]);
    expect(normalizeOverviewParams({ elements: 7 }).elements).toEqual([]);
  });
});

describe("normalizeOverviewParams — instructions coercion", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeOverviewParams({ instructions: "  emphasize teaching  " }).instructions).toBe(
      "emphasize teaching",
    );
  });

  it("clamps to OVERVIEW_INSTRUCTIONS_MAX characters", () => {
    const long = "a".repeat(OVERVIEW_INSTRUCTIONS_MAX + 250);
    const out = normalizeOverviewParams({ instructions: long });
    expect(out.instructions).toHaveLength(OVERVIEW_INSTRUCTIONS_MAX);
  });

  it("coerces a non-string to text then trims", () => {
    expect(normalizeOverviewParams({ instructions: 1234 }).instructions).toBe("1234");
  });

  it("yields an empty string when instructions is missing or null", () => {
    expect(normalizeOverviewParams({}).instructions).toBe("");
    expect(normalizeOverviewParams({ instructions: null }).instructions).toBe("");
    expect(normalizeOverviewParams({ instructions: undefined }).instructions).toBe("");
  });
});

describe("normalizeOverviewParams — never throws on garbage", () => {
  it.each([null, undefined, 42, "a string", true, [], [1, 2, 3], NaN])(
    "returns the default-enum shape for top-level garbage: %p",
    (garbage) => {
      expect(() => normalizeOverviewParams(garbage as unknown)).not.toThrow();
      expect(normalizeOverviewParams(garbage as unknown)).toEqual(NORMALIZED_EMPTY);
    },
  );

  // A bare Symbol is its own case — vitest's `%p` title interpolation can't
  // stringify a Symbol, so it can't ride in the `it.each` table above.
  it("returns the default-enum shape for a top-level Symbol", () => {
    const sym = Symbol("x");
    expect(() => normalizeOverviewParams(sym as unknown)).not.toThrow();
    expect(normalizeOverviewParams(sym as unknown)).toEqual(NORMALIZED_EMPTY);
  });

  it("does not throw when nested fields are hostile types", () => {
    const hostile = {
      voice: [],
      tone: new Date(),
      length: () => "x",
      elements: { 0: "research_focus" },
      instructions: { toString: () => "coerced" },
    };
    expect(() => normalizeOverviewParams(hostile)).not.toThrow();
    const out = normalizeOverviewParams(hostile);
    expect(out.voice).toBe(DEFAULT_OVERVIEW_PARAMS.voice);
    expect(out.elements).toEqual([]); // a non-array object is not iterable as elements
    expect(out.instructions).toBe("coerced");
  });
});

// ---------------------------------------------------------------------------
// #742 v3.1 — normalizeOverviewSelection (the source-picker trust boundary).
// ---------------------------------------------------------------------------

describe("normalizeOverviewSelection — coercion + dedupe", () => {
  it("returns all-empty buckets for an empty object", () => {
    expect(normalizeOverviewSelection({})).toEqual({ pmids: [], grantIds: [], toolNames: [] });
  });

  it("trims, drops empties, and de-dupes within each bucket (first-seen order)", () => {
    const out = normalizeOverviewSelection({
      pmids: [" 111 ", "222", "111", "", "  "],
      grantIds: ["g1", "g1", " g2 "],
      toolNames: ["AAV vectors", "AAV vectors", "PET imaging"],
    });
    expect(out.pmids).toEqual(["111", "222"]);
    expect(out.grantIds).toEqual(["g1", "g2"]);
    expect(out.toolNames).toEqual(["AAV vectors", "PET imaging"]);
  });

  it("drops non-string members from every bucket", () => {
    const out = normalizeOverviewSelection({
      pmids: ["111", 222, null, { pmid: "x" }, "333"],
      grantIds: [true, "g1"],
      toolNames: [42, "Microscopy"],
    });
    expect(out.pmids).toEqual(["111", "333"]);
    expect(out.grantIds).toEqual(["g1"]);
    expect(out.toolNames).toEqual(["Microscopy"]);
  });

  it("treats a non-array bucket as empty", () => {
    const out = normalizeOverviewSelection({ pmids: "111", grantIds: 7, toolNames: {} });
    expect(out).toEqual({ pmids: [], grantIds: [], toolNames: [] });
  });
});

describe("normalizeOverviewSelection — caps", () => {
  it("clamps pmids + grantIds to a COMBINED maxItems (pmids keep priority)", () => {
    const pmids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const grantIds = Array.from({ length: 30 }, (_, i) => `g${i}`);
    const out = normalizeOverviewSelection({ pmids, grantIds });
    expect(out.pmids).toHaveLength(OVERVIEW_SELECTION_MAX_ITEMS); // 25 — publications fill the budget first
    expect(out.grantIds).toHaveLength(0); // none left
    expect(out.pmids.length + out.grantIds.length).toBe(OVERVIEW_SELECTION_MAX_ITEMS);
  });

  it("lets funding fill the remainder of the combined budget", () => {
    const pmids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const grantIds = Array.from({ length: 20 }, (_, i) => `g${i}`);
    const out = normalizeOverviewSelection({ pmids, grantIds });
    expect(out.pmids).toHaveLength(20);
    expect(out.grantIds).toHaveLength(5); // 25 - 20
  });

  it("clamps toolNames to its own maxTools, independent of the 25 budget", () => {
    const pmids = Array.from({ length: 25 }, (_, i) => `p${i}`);
    const toolNames = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const out = normalizeOverviewSelection({ pmids, toolNames });
    expect(out.pmids).toHaveLength(25);
    expect(out.toolNames).toHaveLength(OVERVIEW_SELECTION_MAX_TOOLS); // 10 — tools never count against the 25
  });

  it("honours explicit cap overrides", () => {
    const pmids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const toolNames = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const out = normalizeOverviewSelection({ pmids, toolNames }, { maxItems: 3, maxTools: 2 });
    expect(out.pmids).toHaveLength(3);
    expect(out.toolNames).toHaveLength(2);
  });
});

describe("normalizeOverviewSelection — never throws on garbage", () => {
  it.each([null, undefined, 42, "a string", true, [], [1, 2, 3], NaN])(
    "returns all-empty buckets for top-level garbage: %p",
    (garbage) => {
      expect(() => normalizeOverviewSelection(garbage as unknown)).not.toThrow();
      expect(normalizeOverviewSelection(garbage as unknown)).toEqual({
        pmids: [],
        grantIds: [],
        toolNames: [],
      });
    },
  );
});

describe("isOverviewSelectionEmpty", () => {
  it("is true only when every bucket is empty", () => {
    expect(isOverviewSelectionEmpty({ pmids: [], grantIds: [], toolNames: [] })).toBe(true);
    expect(isOverviewSelectionEmpty({ pmids: ["1"], grantIds: [], toolNames: [] })).toBe(false);
    expect(isOverviewSelectionEmpty({ pmids: [], grantIds: ["g"], toolNames: [] })).toBe(false);
    expect(isOverviewSelectionEmpty({ pmids: [], grantIds: [], toolNames: ["t"] })).toBe(false);
  });
});
