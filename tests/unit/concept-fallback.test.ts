/**
 * Issue #298 §3/§6/§8 — the concept-fallback co-render decision and its
 * sparse-arm kill-switch. `computeConceptFallback` is the pure rule shared by
 * the SSR page (render branch) and the route handler (telemetry), so the
 * acceptance matrix lives here against the function rather than the rendered
 * page.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeConceptFallback,
  resolveConceptFallbackSparseEnabled,
  CONCEPT_FALLBACK_SPARSE_THRESHOLD,
  CONCEPT_FALLBACK_SPARSE_RATIO,
} from "@/lib/api/search-flags";

// Convenience: a resolved-concept, strict-shape, first-page candidate that the
// individual cases mutate. Defaults represent "co-render would be considered".
const base = {
  meshResolved: true,
  meshOff: false,
  chipMode: "strict" as const,
  total: 0,
  broadCount: 0,
  page: 0,
  sparseEnabled: true,
};

describe("computeConceptFallback (§3 acceptance + §8 edge cases)", () => {
  it("threshold/ratio defaults match the SPEC §6 literals", () => {
    expect(CONCEPT_FALLBACK_SPARSE_THRESHOLD).toBe(5);
    expect(CONCEPT_FALLBACK_SPARSE_RATIO).toBe(5);
  });

  it("#1 zero-trigger: primary=0, broad=1 → fire 'zero', not 'sparse'", () => {
    expect(
      computeConceptFallback({ ...base, total: 0, broadCount: 1 }),
    ).toEqual({ shown: true, trigger: "zero" });
  });

  it("#2 sparse-trigger: primary=3, broad=47 (ratio 15.7 ≥ 5) → fire 'sparse'", () => {
    expect(
      computeConceptFallback({ ...base, total: 3, broadCount: 47 }),
    ).toEqual({ shown: true, trigger: "sparse" });
  });

  it("#3 below ratio: primary=4, broad=12 (ratio 3 < 5) → no trigger", () => {
    expect(
      computeConceptFallback({ ...base, total: 4, broadCount: 12 }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("#4 above threshold: primary=6, broad=200 → no trigger", () => {
    expect(
      computeConceptFallback({ ...base, total: 6, broadCount: 200 }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("§8 #9 ratio exactly 1.0 (primary=5, broad=5) → no trigger", () => {
    expect(
      computeConceptFallback({ ...base, total: 5, broadCount: 5 }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("sparse boundary: primary=5, broad=25 (ratio exactly 5) → fire 'sparse'", () => {
    expect(
      computeConceptFallback({ ...base, total: 5, broadCount: 25 }),
    ).toEqual({ shown: true, trigger: "sparse" });
  });

  it("acceptance #3: expanded_default (OR-of-evidence) shape → never shown, even at total=0", () => {
    expect(
      computeConceptFallback({
        ...base,
        chipMode: "expanded_default",
        total: 0,
        broadCount: 50,
      }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("expanded_narrow (chip-engaged narrow) still co-renders — it gates on the concept", () => {
    expect(
      computeConceptFallback({
        ...base,
        chipMode: "expanded_narrow",
        total: 0,
        broadCount: 50,
      }),
    ).toEqual({ shown: true, trigger: "zero" });
  });

  it("acceptance #4 / §8 #1,#7: meshOff (scope=exact opt-out) → never shown", () => {
    expect(
      computeConceptFallback({
        ...base,
        meshOff: true,
        total: 0,
        broadCount: 50,
      }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("no descriptor resolved → never shown (nothing to fall back from)", () => {
    expect(
      computeConceptFallback({
        ...base,
        meshResolved: false,
        total: 0,
        broadCount: 50,
      }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("§4.3 broadCount=0 → block not rendered (zero-trigger with empty broad)", () => {
    expect(
      computeConceptFallback({ ...base, total: 0, broadCount: 0 }),
    ).toEqual({ shown: false, trigger: null });
  });

  it("§8 #10 page > 0 → fallback fires once on page 0 only", () => {
    expect(
      computeConceptFallback({ ...base, total: 5, broadCount: 500, page: 2 }),
    ).toEqual({ shown: false, trigger: null });
    // Same inputs on page 0 DO fire, proving the page guard is the only blocker.
    expect(
      computeConceptFallback({ ...base, total: 5, broadCount: 500, page: 0 }),
    ).toEqual({ shown: true, trigger: "sparse" });
  });

  it("sparse kill-switch off → sparse arm suppressed, zero arm preserved", () => {
    // Sparse would fire, but the arm is disabled.
    expect(
      computeConceptFallback({
        ...base,
        sparseEnabled: false,
        total: 3,
        broadCount: 47,
      }),
    ).toEqual({ shown: false, trigger: null });
    // Zero-trigger is unconditional — still fires with the sparse arm off.
    expect(
      computeConceptFallback({
        ...base,
        sparseEnabled: false,
        total: 0,
        broadCount: 47,
      }),
    ).toEqual({ shown: true, trigger: "zero" });
  });
});

describe("resolveConceptFallbackSparseEnabled (§6 kill-switch)", () => {
  const original = process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF;
  beforeEach(() => {
    delete process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF;
    else process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF = original;
  });

  it("defaults to true (sparse arm on) when unset", () => {
    expect(resolveConceptFallbackSparseEnabled()).toBe(true);
  });

  it("is false only for exactly '1' (the documented rollback literal)", () => {
    process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF = "1";
    expect(resolveConceptFallbackSparseEnabled()).toBe(false);
  });

  it("stays on for '0' and any other value (unrecognized warns, stays on)", () => {
    process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF = "0";
    expect(resolveConceptFallbackSparseEnabled()).toBe(true);
    process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF = "off";
    expect(resolveConceptFallbackSparseEnabled()).toBe(true);
    process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF = "true";
    expect(resolveConceptFallbackSparseEnabled()).toBe(true);
  });
});
