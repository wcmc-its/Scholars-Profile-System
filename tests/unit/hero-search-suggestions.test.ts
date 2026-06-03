/**
 * Unit tests for lib/hero-search-suggestions.ts — the homepage "Try:" chip pool.
 *
 * Two jobs:
 *  1. Keep the runtime pool (HERO_SEARCH_SUGGESTIONS, the lay-term strings) in
 *     sync with the curated master at data/suggested-searches.json, and re-check
 *     the master's own integrity (contiguous ids, no duplicate labels).
 *  2. Pin the sampler's contract: distinct draws, broad range (no length filter),
 *     and pool-size edge cases.
 *
 * If you edit the master, regenerate the array (see docs/suggested-search-chips.md
 * § 0) — this test fails when the two drift.
 */
import { describe, expect, it } from "vitest";
import {
  HERO_SEARCH_SUGGESTIONS,
  sampleHeroSuggestions,
} from "@/lib/hero-search-suggestions";
import master from "@/data/suggested-searches.json";

type Chip = {
  id: number;
  area: string;
  label: string;
  mesh: string;
  wcm_pubs_2023_present: number;
  replaces: string;
  notes: string;
};

const chips = master as Chip[];

describe("suggested-searches.json — master integrity", () => {
  it("has contiguous ids 1..N", () => {
    expect(chips.map((c) => c.id)).toEqual(
      Array.from({ length: chips.length }, (_, i) => i + 1),
    );
  });

  it("has no duplicate chip labels", () => {
    const labels = chips.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has a non-empty label on every chip", () => {
    expect(chips.filter((c) => !c.label?.trim())).toEqual([]);
  });
});

describe("HERO_SEARCH_SUGGESTIONS — synced to the master", () => {
  it("is the master's label column, in master order", () => {
    expect([...HERO_SEARCH_SUGGESTIONS]).toEqual(chips.map((c) => c.label));
  });

  it("contains no duplicates", () => {
    expect(new Set(HERO_SEARCH_SUGGESTIONS).size).toBe(
      HERO_SEARCH_SUGGESTIONS.length,
    );
  });
});

describe("sampleHeroSuggestions", () => {
  it("returns n distinct entries drawn from the pool", () => {
    const out = sampleHeroSuggestions(6);
    expect(out).toHaveLength(6);
    expect(new Set(out).size).toBe(6);
    for (const s of out) expect(HERO_SEARCH_SUGGESTIONS).toContain(s);
  });

  it("returns the whole pool (as a set) when n equals pool size — nothing is filtered out", () => {
    const out = sampleHeroSuggestions(HERO_SEARCH_SUGGESTIONS.length);
    expect(out).toHaveLength(HERO_SEARCH_SUGGESTIONS.length);
    expect(new Set(out)).toEqual(new Set(HERO_SEARCH_SUGGESTIONS));
  });

  it("samples a broad range of lengths — short and long terms are both eligible", () => {
    // The whole pool is reachable, so both the punchy short chips (<12 chars,
    // e.g. "Sepsis"/"Melanoma") and the long descriptive ones (>22 chars) are
    // present — the old 12–22 "balanced length" band (#214) is gone.
    const lengths = sampleHeroSuggestions(HERO_SEARCH_SUGGESTIONS.length).map(
      (s) => s.length,
    );
    expect(lengths.some((l) => l < 12)).toBe(true);
    expect(lengths.some((l) => l > 22)).toBe(true);
  });

  it("clamps n to the pool size and never returns negatives", () => {
    expect(sampleHeroSuggestions(HERO_SEARCH_SUGGESTIONS.length + 50)).toHaveLength(
      HERO_SEARCH_SUGGESTIONS.length,
    );
    expect(sampleHeroSuggestions(0)).toEqual([]);
    expect(sampleHeroSuggestions(-3)).toEqual([]);
  });

  it("does not mutate the source pool", () => {
    const before = [...HERO_SEARCH_SUGGESTIONS];
    sampleHeroSuggestions(10);
    expect([...HERO_SEARCH_SUGGESTIONS]).toEqual(before);
  });
});
