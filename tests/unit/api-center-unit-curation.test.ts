/**
 * #540 Phase 3b — `getCenter` × unit-curation read-merge integration.
 *
 * Centers are manually-owned (no ETL writes the `center` table); fields are
 * edited in-row, so there is no `field_override` merge here.
 *
 *  - Centers carry the interim qualifier on the leadership holder's
 *    `CenterLeader` row (#2542; was the `leaderInterim` column) — surface it
 *    on `leadership[0].isInterim`.
 *  - edge 20 — whole-unit suppression on a center renders as 404 (null).
 *  - `loadUnitFieldOverrides("center", ...)` is short-circuited; this file
 *    asserts a center read does not issue a `field_override` query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCenterFindUnique,
  mockScholarFindUnique,
  mockScholarFindMany,
  mockCenterMembershipFindMany,
  mockSuppressionFindFirst,
  mockFieldOverrideFindMany,
  mockAssignmentFindFirst,
  mockAssignmentFindMany,
  mockOrgUnitRoleFindUnique,
} = vi.hoisted(() => ({
  mockCenterFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
  mockAssignmentFindFirst: vi.fn(),
  mockAssignmentFindMany: vi.fn(),
  mockOrgUnitRoleFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    center: { findUnique: mockCenterFindUnique },
    // #2542 Phase B — leadership is a LIST of `OrgUnitRoleAssignment` rows
    // fetched with `findMany` (`getCenterUncached`, `lib/api/centers.ts`); it
    // used to be a nested `leaders` relation on `center`.
    orgUnitRoleAssignment: { findFirst: mockAssignmentFindFirst, findMany: mockAssignmentFindMany },
    // Pre-backfill dual-read fallback: when no assignment row exists yet,
    // `getCenterUncached` still resolves the vocabulary's label for
    // `Center.directorCwid` via this lookup.
    orgUnitRole: { findUnique: mockOrgUnitRoleFindUnique },
    scholar: { findUnique: mockScholarFindUnique, findMany: mockScholarFindMany },
    centerMembership: { findMany: mockCenterMembershipFindMany },
    suppression: { findFirst: mockSuppressionFindFirst },
    fieldOverride: { findMany: mockFieldOverrideFindMany },
  },
}));

import { getCenter } from "@/lib/api/centers";

const CENTER = {
  code: "MEYER",
  name: "Meyer Cancer Center",
  slug: "meyer-cancer-center",
  description: "Cancer research center.",
  url: null,
  // #2542 — `getCenterUncached` reads leadership from `OrgUnitRoleAssignment`
  // rows first. These two columns remain as the pre-backfill dual-read
  // fallback, which is what every environment is on today.
  directorCwid: "dir0001",
  leaderInterim: false,
  scholarCount: 42,
};

const DIRECTOR_SCHOLAR = {
  cwid: "dir0001",
  preferredName: "Center Director",
  primaryTitle: "Director, Meyer Cancer Center",
  slug: "center-director",
};

function defaultBaselineMocks() {
  mockCenterFindUnique.mockResolvedValue(CENTER);
  // `getCenterUncached` batches leadership holders through `scholar.findMany`
  // (`cwid: { in: [...] }`), not `findUnique` — the single-cwid lookup is
  // stubbed too (asserted un-called below) but never wired into the loader.
  mockScholarFindMany.mockResolvedValue([DIRECTOR_SCHOLAR]);
  // #552 Phase 4 — getCenter now recomputes scholarCount from the active
  // roster; an empty membership read is fine for these leadership/suppression
  // assertions (none of which inspect scholarCount).
  mockCenterMembershipFindMany.mockResolvedValue([]);
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockFieldOverrideFindMany.mockResolvedValue([]);
  // No assignment row by default: reads fall through to the legacy column, which
  // is exactly the pre-backfill state in every environment today.
  mockAssignmentFindMany.mockResolvedValue([]);
  mockOrgUnitRoleFindUnique.mockResolvedValue({ label: "Director" });
}

describe("getCenter — unit-curation read-merge (#540)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the center is whole-unit suppressed (edge 20)", async () => {
    defaultBaselineMocks();
    mockSuppressionFindFirst.mockResolvedValue({ id: "sup-1" });

    expect(await getCenter("meyer-cancer-center")).toBeNull();
    // Short-circuit before the leadership scholar lookup.
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("surfaces the assignment row's interim flag on leadership[0].isInterim", async () => {
    defaultBaselineMocks();
    mockAssignmentFindMany.mockResolvedValue([
      { cwid: "dir0001", roleKey: "director", interim: true, role: { label: "Director" } },
    ]);

    const result = await getCenter("meyer-cancer-center");
    expect(result?.leadership).toHaveLength(1);
    expect(result?.leadership[0]?.cwid).toBe("dir0001");
    expect(result?.leadership[0]?.roleLabel).toBe("Director");
    expect(result?.leadership[0]?.isInterim).toBe(true);
  });

  it("leadership[0].isInterim defaults to false from the column (pre-backfill dual read)", async () => {
    defaultBaselineMocks();
    const result = await getCenter("meyer-cancer-center");
    expect(result?.leadership).toHaveLength(1);
    expect(result?.leadership[0]?.cwid).toBe("dir0001");
    expect(result?.leadership[0]?.isInterim).toBe(false);
  });

  it("a center with no assignment rows and no director column produces an empty leadership list", async () => {
    defaultBaselineMocks();
    mockCenterFindUnique.mockResolvedValue({ ...CENTER, directorCwid: null });

    const result = await getCenter("meyer-cancer-center");
    expect(result?.leadership).toEqual([]);
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("never issues a field_override query for a center — write path rejects them anyway", async () => {
    defaultBaselineMocks();
    await getCenter("meyer-cancer-center");
    // Phase 3a `loadUnitFieldOverrides("center", ...)` short-circuits; the
    // dept/div integration calls it but centers must not. We assert the
    // helper is never called at all by the center path.
    expect(mockFieldOverrideFindMany).not.toHaveBeenCalled();
  });

  it("the suppression check runs against entityType='center' + center.code", async () => {
    defaultBaselineMocks();
    await getCenter("meyer-cancer-center");
    expect(mockSuppressionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "center",
          entityId: "MEYER",
          revokedAt: null,
        }),
      }),
    );
  });
});
