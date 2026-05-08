/**
 * Tests for lib/api/browse.ts — Phase 4 Browse hub data layer.
 *
 * Mock pattern follows tests/unit/department-api.test.ts (vi.hoisted +
 * vi.mock("@/lib/db")). All Prisma calls are mocked; no DB access.
 *
 * RED while lib/api/browse.ts does not exist; turns GREEN in Plan 02.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockDepartmentFindMany,
  mockScholarFindMany,
  mockDivisionFindMany,
  mockCenterFindMany,
  mockTopicFindMany,
  mockQueryRawUnsafe,
} = vi.hoisted(() => ({
  mockDepartmentFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockCenterFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findMany: mockDepartmentFindMany },
    scholar: { findMany: mockScholarFindMany },
    division: { findMany: mockDivisionFindMany },
    center: { findMany: mockCenterFindMany },
    topic: { findMany: mockTopicFindMany },
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));

import {
  getDepartmentsList,
  getAZBuckets,
  getBrowseData,
} from "@/lib/api/browse";

describe("getDepartmentsList", () => {
  beforeEach(() => {
    mockDepartmentFindMany.mockReset();
    mockScholarFindMany.mockReset();
    mockDivisionFindMany.mockReset().mockResolvedValue([]);
    mockCenterFindMany.mockReset().mockResolvedValue([]);
    mockTopicFindMany.mockReset().mockResolvedValue([]);
    mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
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
    mockTopicFindMany.mockReset().mockResolvedValue([]);
    mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
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

describe("getBrowseData", () => {
  beforeEach(() => {
    mockDepartmentFindMany.mockReset();
    mockScholarFindMany.mockReset();
    mockDivisionFindMany.mockReset().mockResolvedValue([]);
    mockCenterFindMany.mockReset().mockResolvedValue([]);
    mockTopicFindMany.mockReset().mockResolvedValue([]);
    mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
  });

  it("returns composite { departments, departmentsByCategory, centers }", async () => {
    mockDepartmentFindMany.mockResolvedValue([]);
    mockScholarFindMany.mockResolvedValue([]);
    const data = await getBrowseData();
    expect(data).toHaveProperty("departments");
    expect(data).toHaveProperty("departmentsByCategory");
    expect(data).toHaveProperty("centers");
    expect(data).not.toHaveProperty("azBuckets");
    expect(data.centers).toEqual([]);
    expect(Array.isArray(data.departments)).toBe(true);
  });
});
