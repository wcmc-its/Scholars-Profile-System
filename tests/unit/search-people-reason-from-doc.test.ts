/**
 * Search reason-from-doc (commit 4) — the People reason count served from the
 * precomputed people-doc `meshSubtreeCounts` field instead of the
 * publications-index aggregation.
 *
 * The load-bearing new logic is the pure `taggedCountFromDoc` extraction. For
 * concepts within the resolver's DESCENDANT_HARD_CAP (≤200 descendants) the
 * doc count equals the agg count and the reason text matches. For BROAD concepts
 * (>200 descendants) the doc count is INTENTIONALLY larger and more accurate: the
 * legacy agg only filters on the first 200 descendants (capped) and undercounts,
 * while the precomputed doc count reflects the full subtree. This file pins both
 * the equal-case parity AND the intentional broad-concept divergence (no 200-cap
 * on the doc value). The end-to-end query wiring — `_source` inclusion, agg-skip —
 * is exercised by the staging parity diff in the rollout plan §8.
 */
import { describe, expect, it } from "vitest";
import { taggedCountFromDoc, composeMatchReason } from "@/lib/api/search";

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

describe("reason-from-doc vs agg parity (identical matchReason text)", () => {
  // The doc count is the SAME distinct-pub number the publications-index `tagged`
  // filter agg would return; both flow through `composeMatchReason`, so the text
  // is identical. This is the flag-on==flag-off output contract.
  function reasonFor(taggedCount: number) {
    return composeMatchReason({
      counts: { tagged: taggedCount, mention: 0 },
      rep: undefined, // doc path omits the pub; key paper arrives lazily (commit 5)
      pubCount: 372,
      hasProvenance: true,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
  }

  it("doc-sourced count produces the same tagged reason line as the agg count", () => {
    const docCount = taggedCountFromDoc({ D006678: 14 }, "D006678");
    const aggCount = 14; // what the publications-index `tagged` filter would report
    expect(docCount).toBe(aggCount);
    expect(reasonFor(docCount)).toEqual(reasonFor(aggCount));
    expect(reasonFor(docCount)).toEqual({
      icon: "publications",
      text: "14 of 372 publications tagged HIV",
    });
  });

  it("zero doc count falls through to the concept fallback (mention may still fire at runtime)", () => {
    // When the doc count is 0 the tagged branch never fires; with no mention the
    // reason is the concept fallback — identical to the agg path returning 0.
    const docCount = taggedCountFromDoc({ D007239: 3 }, "D006678");
    expect(docCount).toBe(0);
    expect(reasonFor(docCount)).toEqual({ icon: "concept", text: "via related concept HIV" });
  });

  it("caps an over-count at the scholar's pubCount, same as the agg path", () => {
    // Index drift (counts > pubCount) is capped in composeMatchReason regardless
    // of source.
    const r = composeMatchReason({
      counts: { tagged: taggedCountFromDoc({ D006678: 400 }, "D006678"), mention: 0 },
      rep: undefined,
      pubCount: 372,
      hasProvenance: true,
      provenanceParent: "HIV",
      contentQuery: "hiv",
    });
    expect(r?.text).toBe("372 of 372 publications tagged HIV");
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

  it("the broad-concept reason text reflects the true count (capped only at pubCount)", () => {
    const docCount = taggedCountFromDoc({ D009369: 1626 }, "D009369");
    const reason = composeMatchReason({
      counts: { tagged: docCount, mention: 0 },
      rep: undefined,
      pubCount: 2072,
      hasProvenance: true,
      provenanceParent: "Neoplasms",
      contentQuery: "cancer",
    });
    // Legacy capped agg would have shown a smaller "N" here; the doc path is exact.
    expect(reason).toEqual({
      icon: "publications",
      text: "1626 of 2072 publications tagged Neoplasms",
    });
  });
});
