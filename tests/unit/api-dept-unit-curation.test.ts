/**
 * #540 Phase 3b — `getDepartment` × unit-curation read-merge integration.
 *
 * The Phase 3a helpers (`isUnitSuppressed`, `loadUnitFieldOverrides`,
 * `mergeUnitFields`) are wired into `lib/api/departments.ts`; this file
 * exercises the dept-side surfaces, mapped to the SPEC § Edge-case test
 * table so a failure names the risk.
 *
 *  - edge 1  — description override survives ETL (verified at read).
 *  - edge 6  — leaderCwid override beats ADR-002 detection; `op:"clear"` (""=
 *              explicit vacancy) does NOT fall back to auto-detection.
 *  - edge 20 — whole-unit suppression on a department renders as a 404.
 *  - leaderInterim — surfaced through `DepartmentChair.isInterim`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDepartmentFindUnique,
  mockScholarFindUnique,
  mockScholarFindMany,
  mockScholarCount,
  mockScholarGroupBy,
  mockAppointmentFindFirst,
  mockPublicationTopicGroupBy,
  mockPublicationTopicCount,
  mockTopicFindMany,
  mockDivisionFindMany,
  mockGrantCount,
  mockGrantFindMany,
  mockFieldOverrideFindMany,
  mockSuppressionFindFirst,
  mockSuppressionFindMany,
} = vi.hoisted(() => ({
  mockDepartmentFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarCount: vi.fn(),
  mockScholarGroupBy: vi.fn(),
  mockAppointmentFindFirst: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationTopicCount: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockGrantCount: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: mockDepartmentFindUnique },
    scholar: {
      findUnique: mockScholarFindUnique,
      findMany: mockScholarFindMany,
      count: mockScholarCount,
      groupBy: mockScholarGroupBy,
    },
    appointment: { findFirst: mockAppointmentFindFirst },
    publicationTopic: {
      groupBy: mockPublicationTopicGroupBy,
      count: mockPublicationTopicCount,
    },
    topic: { findMany: mockTopicFindMany },
    division: { findMany: mockDivisionFindMany },
    grant: { count: mockGrantCount, findMany: mockGrantFindMany },
    fieldOverride: { findMany: mockFieldOverrideFindMany },
    suppression: {
      findFirst: mockSuppressionFindFirst,
      findMany: mockSuppressionFindMany,
    },
  },
}));

import { getDepartment } from "@/lib/api/departments";

const DEPT = {
  code: "MED",
  name: "Department of Medicine",
  slug: "medicine",
  description: "The ETL-seeded description.",
  chairCwid: "etl0001",
  category: "clinical",
  scholarCount: 200,
};

function defaultBaselineMocks() {
  mockDepartmentFindUnique.mockResolvedValue(DEPT);
  mockScholarFindUnique.mockResolvedValue({
    cwid: "etl0001",
    preferredName: "ETL Chair",
    slug: "etl-chair",
    primaryTitle: "Professor",
  });
  mockAppointmentFindFirst.mockResolvedValue({ title: "Chairman" });
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockTopicFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
  mockScholarCount.mockResolvedValue(200);
  mockScholarGroupBy.mockResolvedValue([]);
  mockPublicationTopicCount.mockResolvedValue(1500);
  mockGrantCount.mockResolvedValue(25);
  // activeGrants now uses grant.findMany + #160 suppression resolution; these
  // #540 read-merge tests don't assert the count, just need the call mocked.
  mockGrantFindMany.mockResolvedValue([]);
  mockFieldOverrideFindMany.mockResolvedValue([]);
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockSuppressionFindMany.mockResolvedValue([]);
}

describe("getDepartment — unit-curation read-merge (#540)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the department is whole-unit suppressed (edge 20)", async () => {
    defaultBaselineMocks();
    mockSuppressionFindFirst.mockResolvedValue({ id: "sup-1" });

    expect(await getDepartment("medicine")).toBeNull();
    // Short-circuit before the leader lookup runs.
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("description override wins over the ETL-seeded value (edge 1)", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "description", value: "Curator-edited description." },
    ]);

    const result = await getDepartment("medicine");
    expect(result?.dept.description).toBe("Curator-edited description.");
  });

  it("leaderCwid override beats the ETL chairCwid; chair lookup uses the override (edge 6)", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderCwid", value: "ovr0001" },
    ]);
    mockScholarFindUnique.mockResolvedValue({
      cwid: "ovr0001",
      preferredName: "Curator-Set Chair",
      slug: "curator-set-chair",
      primaryTitle: "Professor of Medicine",
    });

    const result = await getDepartment("medicine");
    expect(result?.chair?.cwid).toBe("ovr0001");
    expect(result?.chair?.preferredName).toBe("Curator-Set Chair");
    // The lookup query went to the override CWID, not the ETL's.
    expect(mockScholarFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: "ovr0001" } }),
    );
  });

  it("leaderCwid override of \"\" is explicit vacancy; no chair, no auto-detect fallback (edge 6 — third state)", async () => {
    // SPEC § 1 three-state model: an explicit "" clears the leader and must
    // NOT re-engage ADR-002 detection — that's the whole point of the override.
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderCwid", value: "" },
    ]);

    const result = await getDepartment("medicine");
    expect(result?.chair).toBeNull();
    // No scholar/appointment lookup at all — vacancy is final.
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
    expect(mockAppointmentFindFirst).not.toHaveBeenCalled();
  });

  it("with no override and no chairCwid, no chair is returned (baseline)", async () => {
    defaultBaselineMocks();
    mockDepartmentFindUnique.mockResolvedValue({ ...DEPT, chairCwid: null });

    const result = await getDepartment("medicine");
    expect(result?.chair).toBeNull();
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("leaderInterim override surfaces as chair.isInterim = true", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderInterim", value: "true" },
    ]);

    const result = await getDepartment("medicine");
    expect(result?.chair?.isInterim).toBe(true);
  });

  it("no leaderInterim override defaults isInterim to false", async () => {
    defaultBaselineMocks();
    const result = await getDepartment("medicine");
    expect(result?.chair?.isInterim).toBe(false);
  });

  it("the suppression check runs against entityType='department' + dept.code", async () => {
    defaultBaselineMocks();
    await getDepartment("medicine");
    expect(mockSuppressionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "department",
          entityId: "MED",
          revokedAt: null,
        }),
      }),
    );
  });

  it("the override loader runs against entityType='department' + dept.code", async () => {
    defaultBaselineMocks();
    await getDepartment("medicine");
    expect(mockFieldOverrideFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "department",
          entityId: "MED",
        }),
      }),
    );
  });
});
