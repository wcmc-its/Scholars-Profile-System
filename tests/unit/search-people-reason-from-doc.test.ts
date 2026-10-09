/**
 * Search reason-from-doc (commit 4) — the People reason count served from the
 * precomputed people-doc `meshSubtreeCounts` field instead of the
 * publications-index aggregation.
 *
 * The load-bearing new logic is the pure `taggedCountFromDoc` extraction. For
 * concepts within the resolver's DESCENDANT_HARD_CAP (≤200 descendants) the
 * doc count equals the agg count. For BROAD concepts
 * (>200 descendants) the doc count is INTENTIONALLY larger and more accurate: the
 * legacy agg only filters on the first 200 descendants (capped) and undercounts,
 * while the precomputed doc count reflects the full subtree. This file pins both
 * the equal-case parity AND the intentional broad-concept divergence (no 200-cap
 * on the doc value). The rendered "N of M publications tagged under X" text is
 * pinned at the `searchPeople` level in search-people-result-evidence.test.ts
 * (the legacy `composeMatchReason` it used to go through was deleted in #1440).
 * The end-to-end query wiring — `_source` inclusion, agg-skip —
 * is exercised by the staging parity diff in the rollout plan §8.
 */
import { describe, expect, it } from "vitest";
import { taggedCountFromDoc } from "@/lib/api/search";

describe("taggedCountFromDoc (doc-sourced tagged count)", () => {
  const counts = { D006678: 14, D007239: 3 };

  it("reads the resolved concept's distinct-pub count", () => {
    expect(taggedCountFromDoc(counts, "D006678")).toBe(14);
  });

  it("returns 0 when the concept is absent from the map (no on-topic pub)", () => {
    expect(taggedCountFromDoc(counts, "D000000")).toBe(0);
  });

  it("returns 0 when the field is absent (a not-yet-reindexed doc)", () => {
    expect(taggedCountFromDoc(undefined, "D006678")).toBe(0);
  });

  it("returns 0 for an empty resolved concept ui (free-text-only query)", () => {
    expect(taggedCountFromDoc(counts, "")).toBe(0);
  });
});

describe("reason-from-doc broad-concept divergence (intentional, more accurate)", () => {
  // For a concept with >200 descendants the legacy `tagged` agg undercounts —
  // computeDescendants truncates `descendantUis` at DESCENDANT_HARD_CAP (200), so
  // the agg only filters on the first 200 descendants. The doc count is folded up
  // the FULL ancestor chain at index time, so it is exact. taggedCountFromDoc must
  // return that exact value verbatim — NO re-application of the 200 cap.
  it("returns the full precomputed subtree count, not bounded by DESCENDANT_HARD_CAP", () => {
    // D009369 = Neoplasms, a broad concept whose true subtree far exceeds 200.
    // A prolific oncologist's doc legitimately carries a count well above what a
    // 200-descendant-capped agg would report.
    const broad = taggedCountFromDoc({ D009369: 1626 }, "D009369");
    expect(broad).toBe(1626); // NOT clamped to 200 or to the legacy capped count
  });
});
