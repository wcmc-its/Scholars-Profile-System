/**
 * #1168 follow-up — `getSupercategoryFamilyEntitySummaries`: the per-family
 * specific-entity rollup that drives the supercategory page's enriched
 * "View full … method page" signpost.
 *
 * Locks the three things the signpost depends on: the flag gate (no DB read when
 * the entity layer is off), the evidenced && !generic filter, and the per-
 * familyLabel aggregation (sum counts, dominant-kind = largest group). Mirrors the
 * Prisma + lens-flag mock pattern in `methods-rollup.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGroupBy, mockEntityLayerOn } = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockEntityLayerOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { familyEntity: { groupBy: mockGroupBy } },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensEntityLayerOn: () => mockEntityLayerOn(),
}));

import { getSupercategoryFamilyEntitySummaries } from "@/lib/api/methods";

const SC = "animal_cell_models";

beforeEach(() => {
  vi.clearAllMocks();
  mockEntityLayerOn.mockReturnValue(true);
});

describe("getSupercategoryFamilyEntitySummaries", () => {
  it("returns {} without querying when the entity layer is off", async () => {
    mockEntityLayerOn.mockReturnValue(false);
    const out = await getSupercategoryFamilyEntitySummaries(SC);
    expect(out).toEqual({});
    expect(mockGroupBy).not.toHaveBeenCalled();
  });

  it("groups only evidenced, non-generic entities for the supercategory", async () => {
    mockGroupBy.mockResolvedValue([]);
    await getSupercategoryFamilyEntitySummaries(SC);
    expect(mockGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["familyLabel", "dominantKind"],
        where: { supercategory: SC, evidenced: true, isGeneric: false },
        _count: { _all: true },
      }),
    );
  });

  it("sums counts per familyLabel and keeps the largest group's dominantKind", async () => {
    mockGroupBy.mockResolvedValue([
      { familyLabel: "Immortalized cell lines", dominantKind: "organism_or_cells", _count: { _all: 29 } },
      { familyLabel: "Immortalized cell lines", dominantKind: "reagent", _count: { _all: 3 } },
      { familyLabel: "Antibodies", dominantKind: "reagent", _count: { _all: 7 } },
    ]);
    const out = await getSupercategoryFamilyEntitySummaries(SC);
    expect(out["Immortalized cell lines"]).toEqual({
      entityCount: 32,
      entityKind: "organism_or_cells",
    });
    expect(out["Antibodies"]).toEqual({ entityCount: 7, entityKind: "reagent" });
  });

  it("returns {} when there are no matching entities", async () => {
    mockGroupBy.mockResolvedValue([]);
    expect(await getSupercategoryFamilyEntitySummaries(SC)).toEqual({});
  });
});
