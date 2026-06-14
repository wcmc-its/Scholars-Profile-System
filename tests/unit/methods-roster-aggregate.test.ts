/**
 * #974 Phase 2 — `aggregatePublicFamiliesForUnit` (lib/api/methods-roster.ts).
 *
 * The unit-wide "Methods & tools" facet buckets: ONE overlay-gated
 * `scholarFamily.groupBy([supercategory, familyLabel])` over the unit's full active
 * member cwids → FacetOption[] { value: sc::label, label, count: distinct members },
 * count-desc. Asserts: self-gates off/empty (no query); public buckets only (a
 * #800-suppressed AND a #801-sensitive bucket are excluded); value/label/count
 * shape; count-desc + label tie-break ordering.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGroupBy, mockLoadOverlayGate } = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockLoadOverlayGate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { scholarFamily: { groupBy: mockGroupBy } },
}));
vi.mock("@/lib/api/methods-overlay", async () => {
  // Use the REAL key fn + visibility logic so the test exercises the actual gate;
  // only the gate-load (DB) is mocked.
  const actual = await vi.importActual<typeof import("@/lib/api/methods-overlay")>(
    "@/lib/api/methods-overlay",
  );
  return { ...actual, loadFamilyOverlayGate: () => mockLoadOverlayGate() };
});

import { aggregatePublicFamiliesForUnit } from "@/lib/api/methods-roster";

const SC = "imaging_image_analysis";

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
});

describe("aggregatePublicFamiliesForUnit", () => {
  it("returns [] and runs no query when disabled", async () => {
    const out = await aggregatePublicFamiliesForUnit(["a", "b"], { enabled: false });
    expect(out).toEqual([]);
    expect(mockGroupBy).not.toHaveBeenCalled();
    expect(mockLoadOverlayGate).not.toHaveBeenCalled();
  });

  it("returns [] and runs no query when there are no cwids", async () => {
    const out = await aggregatePublicFamiliesForUnit([], { enabled: true });
    expect(out).toEqual([]);
    expect(mockGroupBy).not.toHaveBeenCalled();
  });

  it("maps groupBy rows to FacetOption{ value, label, count } sorted count-desc", async () => {
    mockGroupBy.mockResolvedValue([
      { supercategory: SC, familyLabel: "Deep learning", _count: { cwid: 5 } },
      { supercategory: SC, familyLabel: "Segmentation", _count: { cwid: 9 } },
    ]);
    const out = await aggregatePublicFamiliesForUnit(["c1", "c2"], { enabled: true });
    expect(out).toEqual([
      { value: `${SC}::Segmentation`, label: "Segmentation", count: 9 },
      { value: `${SC}::Deep learning`, label: "Deep learning", count: 5 },
    ]);
    // count == distinct members (the `_count.cwid` aggregate, per @@unique invariant)
    const args = mockGroupBy.mock.calls[0][0];
    expect(args.by).toEqual(["supercategory", "familyLabel"]);
    expect(args._count).toEqual({ cwid: true });
    expect(args.where.cwid.in).toEqual(["c1", "c2"]);
  });

  it("tie-breaks equal counts by label ASC", async () => {
    mockGroupBy.mockResolvedValue([
      { supercategory: SC, familyLabel: "Zebra", _count: { cwid: 4 } },
      { supercategory: SC, familyLabel: "Alpha", _count: { cwid: 4 } },
    ]);
    const out = await aggregatePublicFamiliesForUnit(["c1"], { enabled: true });
    expect(out.map((o) => o.label)).toEqual(["Alpha", "Zebra"]);
  });

  it("excludes a #800-suppressed bucket (HARD CONSTRAINT A)", async () => {
    mockGroupBy.mockResolvedValue([
      { supercategory: SC, familyLabel: "Deep learning", _count: { cwid: 5 } },
      { supercategory: SC, familyLabel: "Secret method", _count: { cwid: 8 } },
    ]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set([`${SC}::Secret method`]),
      sensitive: new Set(),
    });
    const out = await aggregatePublicFamiliesForUnit(["c1"], { enabled: true });
    expect(out.map((o) => o.label)).toEqual(["Deep learning"]);
  });

  it("excludes a #801-sensitive bucket when the sensitivity gate is on", async () => {
    mockGroupBy.mockResolvedValue([
      { supercategory: SC, familyLabel: "Deep learning", _count: { cwid: 5 } },
      { supercategory: SC, familyLabel: "Animal model", _count: { cwid: 8 } },
    ]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set(),
      sensitive: new Set([`${SC}::Animal model`]),
    });
    const out = await aggregatePublicFamiliesForUnit(["c1"], { enabled: true });
    expect(out.map((o) => o.label)).toEqual(["Deep learning"]);
  });
});
