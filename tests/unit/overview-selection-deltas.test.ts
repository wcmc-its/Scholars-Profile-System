import { describe, expect, it } from "vitest";

import {
  applyDeltas,
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  isOverviewSelectionDeltasEmpty,
  normalizeOverviewSelectionDeltas,
  OVERVIEW_DELTA_MAX_PER_BAG,
  summarizeOverviewDeltas,
} from "@/lib/edit/overview-params";

describe("normalizeOverviewSelectionDeltas — trust boundary", () => {
  it("coerces garbage to the default deltas", () => {
    expect(normalizeOverviewSelectionDeltas(undefined)).toEqual(DEFAULT_OVERVIEW_SELECTION_DELTAS);
    expect(normalizeOverviewSelectionDeltas(42)).toEqual(DEFAULT_OVERVIEW_SELECTION_DELTAS);
    expect(normalizeOverviewSelectionDeltas([1, 2])).toEqual(DEFAULT_OVERVIEW_SELECTION_DELTAS);
  });

  it("falls back to 'led' for unknown toggle values", () => {
    const d = normalizeOverviewSelectionDeltas({ publicationPositions: "everything", fundingRoles: 7 });
    expect(d.publicationPositions).toBe("led");
    expect(d.fundingRoles).toBe("led");
  });

  it("keeps valid toggles", () => {
    const d = normalizeOverviewSelectionDeltas({ publicationPositions: "all", fundingRoles: "all" });
    expect(d.publicationPositions).toBe("all");
    expect(d.fundingRoles).toBe("all");
  });

  it("filters unknown record types, trims, de-dupes, and drops non-strings", () => {
    const d = normalizeOverviewSelectionDeltas({
      pinned: {
        publication: [" 1 ", "1", "2", 3, null],
        bogusType: ["x"],
        funding: "not-an-array",
      },
    });
    expect(d.pinned.publication).toEqual(["1", "2"]);
    expect(d.pinned).not.toHaveProperty("bogusType");
    expect(d.pinned.funding).toBeUndefined();
  });

  it("caps each bag at OVERVIEW_DELTA_MAX_PER_BAG", () => {
    const many = Array.from({ length: OVERVIEW_DELTA_MAX_PER_BAG + 50 }, (_, i) => `p${i}`);
    const d = normalizeOverviewSelectionDeltas({ excluded: { publication: many } });
    expect(d.excluded.publication).toHaveLength(OVERVIEW_DELTA_MAX_PER_BAG);
  });

  it("omits a type key entirely when its bag is empty", () => {
    const d = normalizeOverviewSelectionDeltas({ pinned: { publication: [] } });
    expect(d.pinned).toEqual({});
  });
});

describe("isOverviewSelectionDeltasEmpty", () => {
  it("is true for the default deltas", () => {
    expect(isOverviewSelectionDeltasEmpty(DEFAULT_OVERVIEW_SELECTION_DELTAS)).toBe(true);
  });

  it("is false when anything diverges", () => {
    expect(
      isOverviewSelectionDeltasEmpty(
        normalizeOverviewSelectionDeltas({ pinned: { publication: ["1"] } }),
      ),
    ).toBe(false);
    expect(
      isOverviewSelectionDeltasEmpty(
        normalizeOverviewSelectionDeltas({ excluded: { method: ["x"] } }),
      ),
    ).toBe(false);
    expect(
      isOverviewSelectionDeltasEmpty(normalizeOverviewSelectionDeltas({ publicationPositions: "all" })),
    ).toBe(false);
  });
});

describe("applyDeltas — (featured ∪ pinned) \\ excluded", () => {
  it("returns the auto-set unchanged when there are no deltas", () => {
    expect(applyDeltas(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("removes excluded ids, preserving auto-set order", () => {
    expect(applyDeltas(["a", "b", "c"], [], ["b"])).toEqual(["a", "c"]);
  });

  it("appends pinned-but-not-featured ids at the tail", () => {
    expect(applyDeltas(["a", "b"], ["z"])).toEqual(["a", "b", "z"]);
  });

  it("does not duplicate a pin that is already featured", () => {
    expect(applyDeltas(["a", "b"], ["a"])).toEqual(["a", "b"]);
  });

  it("lets exclude win over a conflicting pin", () => {
    expect(applyDeltas(["a"], ["b"], ["b"])).toEqual(["a"]);
  });

  it("de-dupes a repeated featured id", () => {
    expect(applyDeltas(["a", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("summarizeOverviewDeltas — status-line counts", () => {
  it("counts pins and hides across all types", () => {
    const d = normalizeOverviewSelectionDeltas({
      pinned: { publication: ["1"], method: ["x", "y"] },
      excluded: { funding: ["g1"], title: ["t1"], education: ["e1"] },
    });
    expect(summarizeOverviewDeltas(d)).toEqual({ pinned: 3, hidden: 3 });
  });

  it("is zero for the default deltas", () => {
    expect(summarizeOverviewDeltas(DEFAULT_OVERVIEW_SELECTION_DELTAS)).toEqual({ pinned: 0, hidden: 0 });
  });
});
