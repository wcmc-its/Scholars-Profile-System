/**
 * Search reason-from-doc (commit 4) — the People reason count served from the
 * precomputed people-doc `meshSubtreeCounts` field instead of the
 * publications-index aggregation.
 *
 * The load-bearing new logic is the pure `taggedCountFromDoc` extraction and its
 * PARITY with the agg-derived count: the same number, fed to the same
 * `composeMatchReason`, must produce byte-identical reason text. (The end-to-end
 * query wiring — `_source` inclusion, agg-skip — is exercised by the staging
 * parity diff in the rollout plan §8; here we pin the count + reason contract.)
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
