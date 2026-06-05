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
  OVERVIEW_INSTRUCTIONS_MAX,
  normalizeOverviewParams,
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
