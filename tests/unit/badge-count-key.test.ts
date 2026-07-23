import { describe, it, expect } from "vitest";
import { badgeCountKey } from "@/lib/api/reason-agg-cache";

/**
 * #1409 item-4 — the tab badge-count cache key. The correctness contract: the
 * key must include EXACTLY the inputs that move `hits.total.value` (q, scope,
 * and — publications only — meshOnly) and NOTHING that is count-neutral. The
 * per-corpus count-invariance audit established that user-axis facets live in
 * post_filter (absent from the count body), so they must NOT appear in the key
 * — otherwise toggling a facet would miss the cache, defeating the point.
 */
describe("badgeCountKey (#1409)", () => {
  it("is stable for identical inputs (so a facet toggle — which is not a key input — stays a hit)", () => {
    expect(badgeCountKey("people", "cardiology", "expanded")).toBe(
      badgeCountKey("people", "cardiology", "expanded"),
    );
  });

  it("trims q so surrounding whitespace collapses to one key (the search bodies trim too)", () => {
    expect(badgeCountKey("people", "  cardiology  ", "expanded")).toBe(
      badgeCountKey("people", "cardiology", "expanded"),
    );
  });

  it("splits on q — a different query is a different total", () => {
    expect(badgeCountKey("people", "cardiology", "expanded")).not.toBe(
      badgeCountKey("people", "oncology", "expanded"),
    );
  });

  it("splits on scope — exact/expanded/concept fold in meshOff/meshStrict and move the total", () => {
    const keys = new Set([
      badgeCountKey("funding", "cardiology", "exact"),
      badgeCountKey("funding", "cardiology", "expanded"),
      badgeCountKey("funding", "cardiology", "concept"),
    ]);
    expect(keys.size).toBe(3);
  });

  it("namespaces by corpus — the same (q, scope) is three distinct counts", () => {
    const keys = new Set([
      badgeCountKey("people", "cardiology", "expanded"),
      badgeCountKey("publications", "cardiology", "expanded"),
      badgeCountKey("funding", "cardiology", "expanded"),
    ]);
    expect(keys.size).toBe(3);
  });

  it("splits publications on meshOnly (the one per-request total-mover scope does not capture)", () => {
    expect(
      badgeCountKey("publications", "cardiology", "expanded", { meshOnly: true }),
    ).not.toBe(
      badgeCountKey("publications", "cardiology", "expanded", { meshOnly: false }),
    );
  });

  it("ignores meshOnly for people/funding (it only rides the publications count body)", () => {
    expect(
      badgeCountKey("people", "cardiology", "expanded", { meshOnly: true }),
    ).toBe(badgeCountKey("people", "cardiology", "expanded"));
    expect(
      badgeCountKey("funding", "cardiology", "expanded", { meshOnly: true }),
    ).toBe(badgeCountKey("funding", "cardiology", "expanded"));
  });

  it("treats missing meshOnly as false for publications (a stable default, not undefined)", () => {
    expect(badgeCountKey("publications", "cardiology", "expanded")).toBe(
      badgeCountKey("publications", "cardiology", "expanded", { meshOnly: false }),
    );
  });
});
