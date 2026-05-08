/**
 * Tests for lib/api/departments.ts — getDepartment + getDepartmentFaculty.
 *
 * Spec gates exercised:
 *   - D-01/D-03 — department row + chair resolution (chairCwid → Scholar + Appointment)
 *   - D-10 — distinct scholar count for topic (via lib/api/topics.ts; separate test)
 *   - D-12 — faculty list with optional division filter + chief-first ordering
 *   - Pagination: 20 per page, page param respected
 *   - No eligibility carve — all roles shown per UI-SPEC §6.10
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDepartmentFindUnique,
  mockScholarFindUnique,
  mockScholarFindFirst,
  mockScholarFindMany,
  mockScholarCount,
  mockScholarGroupBy,
  mockAppointmentFindFirst,
  mockPublicationTopicGroupBy,
  mockPublicationTopicCount,
  mockTopicFindMany,
  mockDivisionFindMany,
  mockDivisionFindFirst,
  mockGrantCount,
  mockGrantGroupBy,
} = vi.hoisted(() => ({
  mockDepartmentFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarCount: vi.fn(),
  mockScholarGroupBy: vi.fn(),
  mockAppointmentFindFirst: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationTopicCount: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockGrantCount: vi.fn(),
  mockGrantGroupBy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: mockDepartmentFindUnique },
    scholar: {
      findUnique: mockScholarFindUnique,
      findFirst: mockScholarFindFirst,
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
    division: {
      findMany: mockDivisionFindMany,
      findFirst: mockDivisionFindFirst,
    },
    grant: {
      count: mockGrantCount,
      groupBy: mockGrantGroupBy,
    },
  },
}));

import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";

const DEPT = {
  code: "MED",
  name: "Department of Medicine",
  slug: "medicine",
  description: "The department of medicine.",
  chairCwid: "chair001",
  scholarCount: 200,
  source: "ED",
  refreshedAt: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const CHAIR_SCHOLAR = {
  cwid: "chair001",
  preferredName: "Dr. Chair Person",
  slug: "dr-chair-person",
};

const CHAIR_APPT = {
  title: "Chairman and Stephen and Suzanne Weiss Professor",
};

const DIVISION_A = {
  code: "CARDIO",
  deptCode: "MED",
  name: "Cardiology",
  slug: "cardiology",
  description: "Heart stuff.",
  chiefCwid: "chief001",
  scholarCount: 50,
  source: "ED",
  refreshedAt: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const CHIEF_SCHOLAR = {
  cwid: "chief001",
  preferredName: "Dr. Division Chief",
  slug: "dr-division-chief",
};

function mockDefaultDeptSetup() {
  mockDepartmentFindUnique.mockResolvedValue(DEPT);
  mockScholarFindUnique.mockResolvedValue(CHAIR_SCHOLAR);
  mockAppointmentFindFirst.mockResolvedValue(CHAIR_APPT);
  mockPublicationTopicGroupBy.mockResolvedValue([
    { parentTopicId: "cancer_genomics", _count: { pmid: 42 } },
    { parentTopicId: "cardiovascular_disease", _count: { pmid: 38 } },
  ]);
  mockTopicFindMany.mockResolvedValue([
    { id: "cancer_genomics", label: "Cancer Genomics" },
    { id: "cardiovascular_disease", label: "Cardiovascular Disease" },
  ]);
  mockDivisionFindMany.mockResolvedValue([DIVISION_A]);
  mockScholarFindMany.mockResolvedValue([CHIEF_SCHOLAR]);
  mockScholarCount.mockResolvedValue(200);
  mockScholarGroupBy.mockResolvedValue([]);
  mockPublicationTopicCount.mockResolvedValue(1500);
  mockGrantCount.mockResolvedValue(25);
}

describe("getDepartment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for unknown department slug", async () => {
    mockDepartmentFindUnique.mockResolvedValue(null);
    const result = await getDepartment("not-a-real-dept");
    expect(result).toBeNull();
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("returns department with chairCwid populated when chair appointment exists", async () => {
    mockDefaultDeptSetup();
    const result = await getDepartment("medicine");

    expect(result).not.toBeNull();
    expect(result!.chair).not.toBeNull();
    expect(result!.chair!.cwid).toBe("chair001");
    expect(result!.chair!.preferredName).toBe("Dr. Chair Person");
    expect(result!.chair!.slug).toBe("dr-chair-person");
    expect(result!.chair!.chairTitle).toBe("Chairman and Stephen and Suzanne Weiss Professor");
    // identityImageEndpoint is a URL containing the CWID
    expect(result!.chair!.identityImageEndpoint).toContain("chair001");
  });

  it("returns chair with fallback title 'Chair' when no chairman appointment found", async () => {
    mockDefaultDeptSetup();
    mockAppointmentFindFirst.mockResolvedValue(null);

    const result = await getDepartment("medicine");
    expect(result!.chair!.chairTitle).toBe("Chair");
  });

  it("returns null chair when chairCwid is null in dept row", async () => {
    mockDepartmentFindUnique.mockResolvedValue({ ...DEPT, chairCwid: null });
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockTopicFindMany.mockResolvedValue([]);
    mockDivisionFindMany.mockResolvedValue([]);
    mockScholarFindMany.mockResolvedValue([]);
    mockScholarCount.mockResolvedValue(100);
    mockPublicationTopicCount.mockResolvedValue(500);
    mockGrantCount.mockResolvedValue(10);

    const result = await getDepartment("medicine");
    expect(result).not.toBeNull();
    expect(result!.chair).toBeNull();
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("includes top research areas (top 8-10 parent topics by pub count)", async () => {
    mockDefaultDeptSetup();
    const result = await getDepartment("medicine");

    expect(result!.topResearchAreas).toHaveLength(2);
    expect(result!.topResearchAreas[0].topicId).toBe("cancer_genomics");
    expect(result!.topResearchAreas[0].topicLabel).toBe("Cancer Genomics");
    expect(result!.topResearchAreas[0].topicSlug).toBe("cancer_genomics");
    expect(result!.topResearchAreas[0].pubCount).toBe(42);
    expect(result!.topResearchAreas[1].topicId).toBe("cardiovascular_disease");
    expect(result!.topResearchAreas[1].pubCount).toBe(38);
  });

  it("groupBy for top research areas uses deptCode WHERE clause", async () => {
    mockDefaultDeptSetup();
    await getDepartment("medicine");

    expect(mockPublicationTopicGroupBy).toHaveBeenCalled();
    const call = mockPublicationTopicGroupBy.mock.calls[0][0];
    expect(call.where.scholar.deptCode).toBe("MED");
    expect(call.where.scholar.deletedAt).toBeNull();
    expect(call.where.scholar.status).toBe("active");
    expect(call.take).toBe(10);
  });

  it("returns divisions sorted by scholarCount desc, with chief name resolved", async () => {
    mockDefaultDeptSetup();
    const result = await getDepartment("medicine");

    expect(result!.divisions).toHaveLength(1);
    const div = result!.divisions[0];
    expect(div.code).toBe("CARDIO");
    expect(div.name).toBe("Cardiology");
    expect(div.chiefCwid).toBe("chief001");
    expect(div.chiefName).toBe("Dr. Division Chief");
    expect(div.chiefSlug).toBe("dr-division-chief");
    expect(div.scholarCount).toBe(50);
  });

  it("returns stats with scholars, divisions, publications, activeGrants", async () => {
    mockDefaultDeptSetup();
    const result = await getDepartment("medicine");

    expect(result!.stats.scholars).toBe(200);
    expect(result!.stats.divisions).toBe(1);
    expect(result!.stats.publications).toBe(1500);
    expect(result!.stats.activeGrants).toBe(25);
  });

  it("returns dept shape with code, name, slug, description", async () => {
    mockDefaultDeptSetup();
    const result = await getDepartment("medicine");

    expect(result!.dept.code).toBe("MED");
    expect(result!.dept.name).toBe("Department of Medicine");
    expect(result!.dept.slug).toBe("medicine");
    expect(result!.dept.description).toBe("The department of medicine.");
  });
});

// Helper: make a Scholar row with department + division includes
function makeScholarRow(overrides: {
  cwid: string;
  preferredName?: string;
  slug?: string;
  primaryTitle?: string | null;
  roleCategory?: string | null;
  divisionName?: string | null;
  departmentName?: string;
  primaryDepartment?: string | null;
}) {
  return {
    cwid: overrides.cwid,
    preferredName: overrides.preferredName ?? `Scholar ${overrides.cwid}`,
    slug: overrides.slug ?? `scholar-${overrides.cwid}`,
    primaryTitle: overrides.primaryTitle ?? "Professor",
    roleCategory: overrides.roleCategory ?? "full_time_faculty",
    primaryDepartment: overrides.primaryDepartment ?? "Department of Medicine",
    status: "active",
    deletedAt: null,
    department: { name: overrides.departmentName ?? "Department of Medicine" },
    division: overrides.divisionName ? { name: overrides.divisionName } : null,
  };
}

describe("getDepartmentFaculty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty result when deptCode has no scholars", async () => {
    mockScholarCount.mockResolvedValue(0);

    const result = await getDepartmentFaculty("UNKNOWN", {});
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(20);
  });

  it("filters faculty by deptCode", async () => {
    mockScholarCount.mockResolvedValue(2);
    mockDivisionFindFirst.mockResolvedValue(null); // no divCode filter
    mockScholarFindMany.mockResolvedValue([
      makeScholarRow({ cwid: "s1111111" }),
      makeScholarRow({ cwid: "s2222222" }),
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", {});
    expect(result.total).toBe(2);
    expect(result.hits).toHaveLength(2);
    // Verify deptCode was passed in the where clause
    const whereArg = mockScholarCount.mock.calls[0][0].where;
    expect(whereArg.deptCode).toBe("MED");
    expect(whereArg.deletedAt).toBeNull();
    expect(whereArg.status).toBe("active");
  });

  it("optionally filters by divCode when provided", async () => {
    mockScholarCount.mockResolvedValue(5);
    mockDivisionFindFirst.mockResolvedValue({ chiefCwid: null });
    mockScholarFindMany.mockResolvedValue([makeScholarRow({ cwid: "div00001" })]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    await getDepartmentFaculty("MED", { divCode: "CARDIO" });

    const whereArg = mockScholarCount.mock.calls[0][0].where;
    expect(whereArg.divCode).toBe("CARDIO");
  });

  it("paginates 20 per page", async () => {
    mockScholarCount.mockResolvedValue(100);
    mockDivisionFindFirst.mockResolvedValue(null);
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeScholarRow({ cwid: `pg${String(i).padStart(6, "0")}` }),
    );
    mockScholarFindMany.mockResolvedValue(rows);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", { page: 1 });
    expect(result.pageSize).toBe(20);
    expect(result.page).toBe(1);
    expect(result.total).toBe(100);

    // Verify skip was applied for page 1
    const findManyCall = mockScholarFindMany.mock.calls[0][0];
    expect(findManyCall.skip).toBe(20);
    expect(findManyCall.take).toBe(20);
  });

  it("places chief-of-division first when divCode provided and chief is in page 0", async () => {
    mockScholarCount.mockResolvedValue(3);
    mockDivisionFindFirst.mockResolvedValue({ chiefCwid: "chief001" });

    const chiefRow = makeScholarRow({
      cwid: "chief001",
      preferredName: "Dr. Chief",
      divisionName: "Cardiology",
    });
    const otherRow1 = makeScholarRow({ cwid: "other001", preferredName: "A Scholar" });
    const otherRow2 = makeScholarRow({ cwid: "other002", preferredName: "B Scholar" });

    // findFirst is called for the chief row; findMany for the rest
    mockScholarFindFirst.mockResolvedValue(chiefRow);
    mockScholarFindMany.mockResolvedValue([otherRow1, otherRow2]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", { divCode: "CARDIO", page: 0 });
    expect(result.hits[0].cwid).toBe("chief001");
    expect(result.hits[0].preferredName).toBe("Dr. Chief");
    // Other rows follow
    expect(result.hits[1].cwid).toBe("other001");
    expect(result.hits[2].cwid).toBe("other002");
  });

  it("each hit contains the expected fields including identityImageEndpoint", async () => {
    mockScholarCount.mockResolvedValue(1);
    mockDivisionFindFirst.mockResolvedValue(null);
    mockScholarFindMany.mockResolvedValue([
      makeScholarRow({
        cwid: "abc12345",
        preferredName: "Dr. Test Scholar",
        primaryTitle: "Associate Professor",
        roleCategory: "full_time_faculty",
        divisionName: "Cardiology",
        departmentName: "Department of Medicine",
      }),
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([{ cwid: "abc12345", _count: { pmid: 15 } }]);
    mockGrantGroupBy.mockResolvedValue([{ cwid: "abc12345", _count: { _all: 3 } }]);

    const result = await getDepartmentFaculty("MED", {});
    const hit = result.hits[0];
    expect(hit.cwid).toBe("abc12345");
    expect(hit.preferredName).toBe("Dr. Test Scholar");
    expect(hit.primaryTitle).toBe("Associate Professor");
    expect(hit.roleCategory).toBe("Full-time faculty");
    expect(hit.divisionName).toBe("Cardiology");
    expect(hit.departmentName).toBe("Department of Medicine");
    expect(hit.identityImageEndpoint).toContain("abc12345");
    expect(hit.pubCount).toBe(15);
    expect(hit.grantCount).toBe(3);
  });

  it("export exists and is a function (GREEN: implementation present)", () => {
    expect(typeof getDepartment).toBe("function");
    expect(typeof getDepartmentFaculty).toBe("function");
  });
});
