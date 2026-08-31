/**
 * Tests for lib/api/browse.ts — Phase 4 Browse hub data layer.
 *
 * Mock pattern follows tests/unit/department-api.test.ts (vi.hoisted +
 * vi.mock("@/lib/db")). All Prisma calls are mocked; no DB access.
 *
 * RED while lib/api/browse.ts does not exist; turns GREEN in Plan 02.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const {
  mockDepartmentFindMany,
  mockScholarFindMany,
  mockDivisionFindMany,
  mockCenterFindMany,
  mockCoreFindMany,
  mockTopicFindMany,
  mockQueryRawUnsafe,
  mockOrgUnitRoleFindMany,
  mockOrgUnitRoleAssignmentFindMany,
} = vi.hoisted(() => ({
  mockDepartmentFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockCenterFindMany: vi.fn(),
  mockCoreFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
  mockOrgUnitRoleFindMany: vi.fn(),
  mockOrgUnitRoleAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findMany: mockDepartmentFindMany },
    scholar: { findMany: mockScholarFindMany },
    division: { findMany: mockDivisionFindMany },
    center: { findMany: mockCenterFindMany },
    core: { findMany: mockCoreFindMany },
    topic: { findMany: mockTopicFindMany },
    orgUnitRole: { findMany: mockOrgUnitRoleFindMany },
    orgUnitRoleAssignment: { findMany: mockOrgUnitRoleAssignmentFindMany },
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));

import {
  getDepartmentsList,
  getAZBuckets,
  getBrowseData,
  getCoresList,
} from "@/lib/api/browse";

describe("getDepartmentsList", () => {
  beforeEach(() => {
    mockDepartmentFindMany.mockReset();
    mockScholarFindMany.mockReset();
    mockDivisionFindMany.mockReset().mockResolvedValue([]);
    mockCenterFindMany.mockReset().mockResolvedValue([]);
    mockCoreFindMany.mockReset().mockResolvedValue([]);
    mockTopicFindMany.mockReset().mockResolvedValue([]);
    mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
    mockOrgUnitRoleFindMany.mockReset().mockResolvedValue([]);
    mockOrgUnitRoleAssignmentFindMany.mockReset().mockResolvedValue([]);
  });

  it("returns empty array when no departments", async () => {
    mockDepartmentFindMany.mockResolvedValue([]);
    const result = await getDepartmentsList();
    expect(result).toEqual([]);
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("maps chair name + slug from batch-fetched scholars", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "MED", name: "Medicine", slug: "medicine", scholarCount: 312, chairCwid: "abc1234" },
    ]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "abc1234", preferredName: "Jane Smith", slug: "jane-smith" },
    ]);
    const result = await getDepartmentsList();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "MED",
      name: "Medicine",
      slug: "medicine",
      scholarCount: 312,
      chairName: "Jane Smith",
      chairSlug: "jane-smith",
    });
  });

  it("falls back to the external-leader name when the chair is not a WCM scholar", async () => {
    // N1540 (Rehabilitation Medicine) is in lib/external-leaders.ts -> Joel
    // Stein (jos7021), who has no scholar row (Columbia primary appointment).
    // Browse must still show the chair (rendered as plain text, no link).
    mockDepartmentFindMany.mockResolvedValue([
      {
        code: "N1540",
        name: "Rehabilitation Medicine",
        slug: "rehabilitation-medicine",
        scholarCount: 123,
        chairCwid: "jos7021",
      },
    ]);
    mockScholarFindMany.mockResolvedValue([]); // jos7021 is not a scholar
    const result = await getDepartmentsList();
    expect(result[0].chairName).toBe("Joel Stein");
    expect(result[0].chairSlug).toBeNull();
  });

  // #2542 Phase D — MUST DO #6/#3: the browse card gets the same
  // assignment-then-column dual-read `getCentersList` already has, plus a
  // vocabulary-resolved `chairLabel` so `departments-grid.tsx` no longer
  // re-derives "Chair"/"Director" from `category` itself.
  it("chairLabel defaults to 'Chair' for a non-administrative dept with no vocabulary row seeded yet", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "MED", name: "Medicine", slug: "medicine", category: "clinical", scholarCount: 312, chairCwid: "abc1234" },
    ]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "abc1234", preferredName: "Jane Smith", slug: "jane-smith" },
    ]);
    const result = await getDepartmentsList();
    expect(result[0].chairLabel).toBe("Chair");
  });

  it("chairLabel defaults to 'Director' for an administrative dept with no vocabulary row seeded yet", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "LIB", name: "Library", slug: "library", category: "administrative", scholarCount: 5, chairCwid: "dir1234" },
    ]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "dir1234", preferredName: "Dir Person", slug: "dir-person" },
    ]);
    const result = await getDepartmentsList();
    expect(result[0].chairLabel).toBe("Director");
  });

  it("chairLabel is null exactly when chairName is null", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "PED", name: "Pediatrics", slug: "pediatrics", category: "clinical", scholarCount: 80, chairCwid: null },
    ]);
    mockScholarFindMany.mockResolvedValue([]);
    const result = await getDepartmentsList();
    expect(result[0].chairLabel).toBeNull();
  });

  it("uses the vocabulary label over the category default when a steward has renamed the role", async () => {
    mockOrgUnitRoleFindMany.mockResolvedValue([
      { key: "chair", label: "Chairperson" },
    ]);
    mockDepartmentFindMany.mockResolvedValue([
      { code: "MED", name: "Medicine", slug: "medicine", category: "clinical", scholarCount: 312, chairCwid: "abc1234" },
    ]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "abc1234", preferredName: "Jane Smith", slug: "jane-smith" },
    ]);
    const result = await getDepartmentsList();
    expect(result[0].chairLabel).toBe("Chairperson");
  });

  it("an OrgUnitRoleAssignment row wins over the legacy chairCwid column (dual-read)", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "MED", name: "Medicine", slug: "medicine", category: "clinical", scholarCount: 312, chairCwid: "stale-column" },
    ]);
    mockOrgUnitRoleAssignmentFindMany.mockResolvedValue([
      { entityId: "MED", cwid: "assigned001" },
    ]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "assigned001", preferredName: "Assignment Chair", slug: "assignment-chair" },
      { cwid: "stale-column", preferredName: "Stale Chair", slug: "stale-chair" },
    ]);
    const result = await getDepartmentsList();
    expect(result[0].chairName).toBe("Assignment Chair");
    // The scholar batch-fetch was scoped to the ASSIGNED cwid, not the column.
    expect(mockScholarFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: { in: ["assigned001"] } } }),
    );
  });

  it("returns chairName: null when chairCwid is null (absence-as-default)", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "PED", name: "Pediatrics", slug: "pediatrics", scholarCount: 80, chairCwid: null },
    ]);
    mockScholarFindMany.mockResolvedValue([]);
    const result = await getDepartmentsList();
    expect(result[0].chairName).toBeNull();
    expect(result[0].chairSlug).toBeNull();
  });

  it("does not query scholars when no chair cwids present", async () => {
    mockDepartmentFindMany.mockResolvedValue([
      { code: "PED", name: "Pediatrics", slug: "pediatrics", scholarCount: 80, chairCwid: null },
    ]);
    const result = await getDepartmentsList();
    expect(result).toHaveLength(1);
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });
});

describe("getAZBuckets", () => {
  beforeEach(() => {
    mockDepartmentFindMany.mockReset();
    mockScholarFindMany.mockReset();
    mockDivisionFindMany.mockReset().mockResolvedValue([]);
    mockCenterFindMany.mockReset().mockResolvedValue([]);
    mockCoreFindMany.mockReset().mockResolvedValue([]);
    mockTopicFindMany.mockReset().mockResolvedValue([]);
    mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
    mockOrgUnitRoleFindMany.mockReset().mockResolvedValue([]);
    mockOrgUnitRoleAssignmentFindMany.mockReset().mockResolvedValue([]);
  });

  it("groups scholars by last-name initial (last token of preferredName)", async () => {
    mockScholarFindMany.mockResolvedValue([
      { preferredName: "David Aaronson", slug: "david-aaronson", primaryDepartment: "Cardiology" },
      { preferredName: "Fatima Abbas", slug: "fatima-abbas", primaryDepartment: "Oncology" },
      { preferredName: "John Brown", slug: "john-brown", primaryDepartment: "Surgery" },
    ]);
    const buckets = await getAZBuckets();
    const a = buckets.find((b) => b.letter === "A");
    const b = buckets.find((bk) => bk.letter === "B");
    expect(a).toBeDefined();
    expect(a!.count).toBe(2);
    expect(a!.scholars).toHaveLength(2);
    expect(a!.scholars[0].name).toBe("Aaronson, David");
    expect(a!.scholars[0].department).toBe("Cardiology");
    expect(b).toBeDefined();
    expect(b!.count).toBe(1);
  });

  it("caps scholars list at 10 per letter; count reflects full total", async () => {
    const fifteenZ = Array.from({ length: 15 }, (_, i) => ({
      preferredName: `Z${i.toString().padStart(2, "0")} Zwicky`,
      slug: `z${i}-zwicky`,
      primaryDepartment: "Physics",
    }));
    mockScholarFindMany.mockResolvedValue(fifteenZ);
    const buckets = await getAZBuckets();
    const z = buckets.find((b) => b.letter === "Z");
    expect(z).toBeDefined();
    expect(z!.count).toBe(15);
    expect(z!.scholars).toHaveLength(10);
  });

  it("returns empty array when no active scholars", async () => {
    mockScholarFindMany.mockResolvedValue([]);
    const buckets = await getAZBuckets();
    expect(buckets).toEqual([]);
  });
});

describe("getCoresList", () => {
  beforeEach(() => {
    mockCoreFindMany.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns [] without querying the DB when CORE_PAGES is off", async () => {
    // CORE_PAGES unstubbed here => isCorePagesEnabled() reads the real
    // (unset) process.env, i.e. the default-off posture.
    const result = await getCoresList();
    expect(result).toEqual([]);
    expect(mockCoreFindMany).not.toHaveBeenCalled();
  });

  it("selects only visible:true cores when CORE_PAGES is on", async () => {
    vi.stubEnv("CORE_PAGES", "on");
    mockCoreFindMany.mockResolvedValue([
      { id: "2", name: "Biomedical Imaging", facility: "Citigroup Biomedical Imaging Center", description: null },
    ]);
    const result = await getCoresList();
    expect(result).toEqual([
      { id: "2", name: "Biomedical Imaging", facility: "Citigroup Biomedical Imaging Center", description: null },
    ]);
    expect(mockCoreFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { visible: true } }),
    );
  });

  it("does NOT filter on confirmed-publication-count (directory, not evidence surface)", async () => {
    vi.stubEnv("CORE_PAGES", "on");
    mockCoreFindMany.mockResolvedValue([
      { id: "3", name: "Flow Cytometry", facility: null, description: null },
    ]);
    const result = await getCoresList();
    expect(result).toHaveLength(1);
    const [call] = mockCoreFindMany.mock.calls[0];
    expect(call.where).toEqual({ visible: true });
    expect(call.select).not.toHaveProperty("publications");
  });
});

describe("getBrowseData", () => {
  beforeEach(() => {
    mockDepartmentFindMany.mockReset();
    mockScholarFindMany.mockReset();
    mockDivisionFindMany.mockReset().mockResolvedValue([]);
    mockCenterFindMany.mockReset().mockResolvedValue([]);
    mockCoreFindMany.mockReset().mockResolvedValue([]);
    mockTopicFindMany.mockReset().mockResolvedValue([]);
    mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
    mockOrgUnitRoleFindMany.mockReset().mockResolvedValue([]);
    mockOrgUnitRoleAssignmentFindMany.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns composite { departments, centers, cores }", async () => {
    mockDepartmentFindMany.mockResolvedValue([]);
    mockScholarFindMany.mockResolvedValue([]);
    const data = await getBrowseData();
    expect(data).toHaveProperty("departments");
    expect(data).toHaveProperty("centers");
    expect(data).toHaveProperty("cores");
    expect(data).not.toHaveProperty("departmentsByCategory");
    expect(data).not.toHaveProperty("azBuckets");
    expect(data.centers).toEqual([]);
    // CORE_PAGES unstubbed (default off) => cores is [] without a DB call.
    expect(data.cores).toEqual([]);
    expect(mockCoreFindMany).not.toHaveBeenCalled();
    expect(Array.isArray(data.departments)).toBe(true);
  });

  it("includes cores from getCoresList when CORE_PAGES is on", async () => {
    vi.stubEnv("CORE_PAGES", "on");
    mockDepartmentFindMany.mockResolvedValue([]);
    mockScholarFindMany.mockResolvedValue([]);
    mockCoreFindMany.mockResolvedValue([
      { id: "2", name: "Biomedical Imaging", facility: null, description: null },
    ]);
    const data = await getBrowseData();
    expect(data.cores).toEqual([
      { id: "2", name: "Biomedical Imaging", facility: null, description: null },
    ]);
  });
});
