/**
 * Issue #692 — generic-term stripping + mode flag.
 *
 * `stripDeprioritized` is the contract: split a query into a generic-free
 * content query + the removed tokens, never stripping to empty, never touching
 * the caution group. Real anchor: "Microbiome Research" → content "Microbiome"
 * (which is what lets it resolve to Microbiota and fire #688).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import groups from "@/data/search/deprioritized-terms.json";
import { normalizeForMatch } from "@/lib/api/normalize";
import {
  loadDeprioritizedSet,
  stripDeprioritized,
  _resetDeprioritizedCacheForTests,
} from "@/lib/api/deprioritized-terms";
import { resolveGenericTermMode } from "@/lib/api/search-flags";

describe("stripDeprioritized (#692)", () => {
  it("strips a trailing generic term (the Microbiome Research case)", () => {
    expect(stripDeprioritized("Microbiome Research")).toEqual({
      contentQuery: "Microbiome",
      removed: ["Research"],
    });
  });

  it("strips multiple generics, preserves content order", () => {
    expect(
      stripDeprioritized("cancer immunotherapy research methods"),
    ).toEqual({ contentQuery: "cancer immunotherapy", removed: ["research", "methods"] });
  });

  it("strips an interior generic", () => {
    expect(stripDeprioritized("novel cancer treatment")).toEqual({
      contentQuery: "cancer",
      removed: ["novel", "treatment"],
    });
  });

  it("returns removed:[] when nothing is generic", () => {
    expect(stripDeprioritized("cancer immunotherapy")).toEqual({
      contentQuery: "cancer immunotherapy",
      removed: [],
    });
  });

  it("NEVER strips to empty — an all-generic query is left intact", () => {
    // "clinical" (clinical_medical) + "trial" (research_methodology)
    expect(stripDeprioritized("clinical trial")).toEqual({
      contentQuery: "clinical trial",
      removed: [],
    });
  });

  it("is case-insensitive and collapses whitespace", () => {
    expect(stripDeprioritized("  Microbiome   RESEARCH  ")).toEqual({
      contentQuery: "Microbiome",
      removed: ["RESEARCH"],
    });
  });

  it("matches hyphenated entries via normalization (long-term)", () => {
    expect(stripDeprioritized("long-term cancer")).toEqual({
      contentQuery: "cancer",
      removed: ["long-term"],
    });
  });

  it("strips default-set terms but never the caution group", () => {
    // "disease" is default (clinical_medical); "model" is caution → kept.
    expect(stripDeprioritized("disease model")).toEqual({
      contentQuery: "model",
      removed: ["disease"],
    });
  });

  it("returns empty for an empty/whitespace query", () => {
    expect(stripDeprioritized("   ")).toEqual({ contentQuery: "", removed: [] });
  });
});

describe("loadDeprioritizedSet (#692)", () => {
  beforeEach(() => _resetDeprioritizedCacheForTests());

  it("holds the caution group out of the default set", () => {
    const { default: def, caution } = loadDeprioritizedSet();
    for (const t of ["system", "systems", "model", "models"]) {
      expect(caution.has(t)).toBe(true);
      expect(def.has(t)).toBe(false);
    }
    expect(caution.size).toBe(4);
  });

  it("loads every non-caution group into the default set", () => {
    const { default: def } = loadDeprioritizedSet();
    const expected = new Set(
      Object.entries(groups as Record<string, string[]>)
        .filter(([k]) => k !== "_caution_subdomain_dependent")
        .flatMap(([, v]) => v)
        .map(normalizeForMatch),
    );
    expect(def.size).toBe(expected.size);
    expect(def.has("research")).toBe(true);
    expect(def.has("study")).toBe(true);
  });
});

describe("resolveGenericTermMode (#692)", () => {
  const original = process.env.SEARCH_GENERIC_TERM_DEMOTE;
  beforeEach(() => delete process.env.SEARCH_GENERIC_TERM_DEMOTE);
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_GENERIC_TERM_DEMOTE;
    else process.env.SEARCH_GENERIC_TERM_DEMOTE = original;
  });

  it("defaults to off", () => {
    expect(resolveGenericTermMode()).toBe("off");
  });

  it("accepts resolve and on; rejects anything else (case-sensitive)", () => {
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "resolve";
    expect(resolveGenericTermMode()).toBe("resolve");
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "on";
    expect(resolveGenericTermMode()).toBe("on");
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "ON";
    expect(resolveGenericTermMode()).toBe("off");
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "true";
    expect(resolveGenericTermMode()).toBe("off");
  });
});
