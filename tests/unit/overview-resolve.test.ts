/**
 * `lib/edit/overview-resolve.ts` (#742 §2.5 / Phase 2). The client resolver
 * between the durable three-state deltas and the snapshot the generator consumes:
 * `resolveOverviewSelection` layers pins (first, for cap protection) and vetoes
 * onto the auto-set; `selectionToDeltas` maps a restored snapshot back to deltas
 * (#765 "Use these settings").
 */
import { describe, expect, it } from "vitest";

import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import { DEFAULT_OVERVIEW_SELECTION_DELTAS } from "@/lib/edit/overview-params";
import { resolveOverviewSelection, selectionToDeltas } from "@/lib/edit/overview-resolve";

const OPTIONS: OverviewSourceOptions = {
  publications: [
    { pmid: "a", title: "A", venue: null, year: 2024, impact: 9, isFirstOrLast: true, authorPosition: "first", defaultSelected: true },
    { pmid: "b", title: "B", venue: null, year: 2023, impact: 8, isFirstOrLast: true, authorPosition: "last", defaultSelected: true },
    { pmid: "c", title: "C", venue: null, year: 2022, impact: 4, isFirstOrLast: false, authorPosition: "middle", defaultSelected: false },
  ],
  funding: [
    { id: "g1", role: "PI", funder: "NIH", title: "G1", award: null, endYear: 2027, defaultSelected: true },
    { id: "g2", role: "Co-I", funder: "NIH", title: "G2", award: null, endYear: 2026, defaultSelected: false },
  ],
  tools: [
    { toolName: "t1", category: null, pmidCount: 3, maxConfidence: 0.9, defaultSelected: true },
  ],
};

const d = (over: Partial<typeof DEFAULT_OVERVIEW_SELECTION_DELTAS> = {}) => ({
  ...DEFAULT_OVERVIEW_SELECTION_DELTAS,
  ...over,
});

describe("resolveOverviewSelection", () => {
  it("equals the pure auto-set when there are no deltas", () => {
    expect(resolveOverviewSelection(OPTIONS, d())).toEqual({
      pmids: ["a", "b"],
      grantIds: ["g1"],
      toolNames: ["t1"],
    });
  });

  it("orders pins FIRST (cap protection) and then the default order", () => {
    const sel = resolveOverviewSelection(OPTIONS, d({ pinned: { publication: ["c"] } }));
    expect(sel.pmids).toEqual(["c", "a", "b"]);
  });

  it("drops a vetoed default", () => {
    const sel = resolveOverviewSelection(OPTIONS, d({ excluded: { publication: ["a"] } }));
    expect(sel.pmids).toEqual(["b"]);
  });

  it("ignores a pin that no longer matches a candidate (stale delta)", () => {
    const sel = resolveOverviewSelection(OPTIONS, d({ pinned: { publication: ["zzz"] } }));
    expect(sel.pmids).toEqual(["a", "b"]);
  });
});

describe("selectionToDeltas (#765 restore)", () => {
  it("maps a kept non-default to a pin and a dropped default to a veto", () => {
    // Snapshot: keep c (non-default), drop a (default), keep b.
    const restored = selectionToDeltas(
      OPTIONS,
      { pmids: ["b", "c"], grantIds: ["g1"], toolNames: ["t1"] },
      DEFAULT_OVERVIEW_SELECTION_DELTAS,
    );
    expect(restored.pinned.publication).toEqual(["c"]);
    expect(restored.excluded.publication).toEqual(["a"]);
  });

  it("round-trips: resolving the mapped deltas reproduces the snapshot membership", () => {
    const snapshot = { pmids: ["b", "c"], grantIds: ["g2"], toolNames: [] as string[] };
    const mapped = selectionToDeltas(OPTIONS, snapshot, DEFAULT_OVERVIEW_SELECTION_DELTAS);
    const resolved = resolveOverviewSelection(OPTIONS, mapped);
    expect(new Set(resolved.pmids)).toEqual(new Set(snapshot.pmids));
    expect(new Set(resolved.grantIds)).toEqual(new Set(snapshot.grantIds));
    expect(new Set(resolved.toolNames)).toEqual(new Set(snapshot.toolNames));
  });
});
