/**
 * Tests for lib/api/departments.ts — getDepartment + getDepartmentFaculty.
 *
 * Spec gates exercised:
 *   - D-01/D-03 — department row + chair resolution (OrgUnitRoleAssignment → Scholar + Appointment)
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
  mockPublicationAuthorGroupBy,
  mockTopAreasQueryRaw,
  mockPublicationTopicCount,
  mockTopicFindMany,
  mockDivisionFindMany,
  mockDivisionFindFirst,
  mockGrantCount,
  mockGrantGroupBy,
  mockGrantFindMany,
  mockFieldOverrideFindMany,
  mockSuppressionFindFirst,
  mockSuppressionFindMany,
  mockScholarFamilyGroupBy,
  mockScholarFamilyFindMany,
  mockLoadOverlayGate,
  mockChipsEnabled,
  mockFacetEnabled,
  mockOrgUnitRoleFindUnique,
  mockOrgUnitRoleAssignmentFindFirst,
  mockDivChiefAssignmentFindFirst,
  mockMeshSearch,
} = vi.hoisted(() => ({
  mockMeshSearch: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarCount: vi.fn(),
  mockScholarGroupBy: vi.fn(),
  mockAppointmentFindFirst: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationAuthorGroupBy: vi.fn(),
  mockTopAreasQueryRaw: vi.fn(),
  mockPublicationTopicCount: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockGrantCount: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockScholarFamilyGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockLoadOverlayGate: vi.fn(),
  mockChipsEnabled: vi.fn(),
  mockFacetEnabled: vi.fn(),
  mockOrgUnitRoleFindUnique: vi.fn(),
  mockOrgUnitRoleAssignmentFindFirst: vi.fn(),
  mockDivChiefAssignmentFindFirst: vi.fn(),
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
    scholarFamily: {
      groupBy: mockScholarFamilyGroupBy,
      findMany: mockScholarFamilyFindMany,
    },
    appointment: { findFirst: mockAppointmentFindFirst },
    publicationTopic: {
      groupBy: mockPublicationTopicGroupBy,
      count: mockPublicationTopicCount,
    },
    publicationAuthor: { groupBy: mockPublicationAuthorGroupBy },
    topic: { findMany: mockTopicFindMany },
    division: {
      findMany: mockDivisionFindMany,
      findFirst: mockDivisionFindFirst,
    },
    grant: {
      count: mockGrantCount,
      groupBy: mockGrantGroupBy,
      findMany: mockGrantFindMany,
    },
    fieldOverride: { findMany: mockFieldOverrideFindMany },
    // Top research areas: COUNT(DISTINCT pmid) raw query (Prisma.sql).
    $queryRaw: mockTopAreasQueryRaw,
    suppression: {
      findFirst: mockSuppressionFindFirst,
      findMany: mockSuppressionFindMany,
    },
    orgUnitRole: { findUnique: mockOrgUnitRoleFindUnique },
    // #2542 contract A — `resolveUnitLeader` calls this once for the
    // department's own chair/director AND once per division (the department
    // page's division-summary chief + the faculty list's chief-first
    // ordering), so the dispatcher routes by `where.entityType`.
    orgUnitRoleAssignment: {
      findFirst: (args: { where?: { entityType?: string } }) =>
        args?.where?.entityType === "division"
          ? mockDivChiefAssignmentFindFirst(args)
          : mockOrgUnitRoleAssignmentFindFirst(args),
      // The department page's division list resolves every chief in ONE
      // batched read (`resolveUnitLeaderCwids`); it serves each requested
      // division the row `mockDivChiefAssignmentFindFirst` would have.
      findMany: async (args: { where: { entityId: { in: string[] } } }) => {
        const row = await mockDivChiefAssignmentFindFirst(args);
        return row
          ? args.where.entityId.in.map((entityId) => ({ entityId, cwid: row.cwid }))
          : [];
      },
    },
  },
}));
// #974 — the roster chips loader (Phase 1) + facet aggregation (Phase 2) read the
// overlay gate + the methods flags. Default both flags OFF so the existing cases
// are byte-identical; the Phase-2 cases flip the facet flag on explicitly.
vi.mock("@/lib/api/methods-overlay", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/methods-overlay")>(
    "@/lib/api/methods-overlay",
  );
  return { ...actual, loadFamilyOverlayGate: () => mockLoadOverlayGate() };
});
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isOrgUnitMethodsChipsEnabled: () => mockChipsEnabled(),
  isOrgUnitMethodsFacetEnabled: () => mockFacetEnabled(),
  isMethodsLensEnabled: () => false,
  isMethodsLensSensitiveGateOn: () => false,
}));

// Unit Page v2 TOPICS chips — the roster wrapper reads `topMeshTerms` from the
// people index; mock the search client (no OpenSearch in unit tests).
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({ search: mockMeshSearch }),
}));

import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";

const DEPT = {
  code: "MED",
  name: "Department of Medicine",
  slug: "medicine",
  description: "The department of medicine.",
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
  // #540 — manual-layer reads default to no overrides + not suppressed.
  mockFieldOverrideFindMany.mockResolvedValue([]);
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockTopAreasQueryRaw.mockResolvedValue([
    { parentTopicId: "cancer_genomics", pubCount: BigInt(42) },
    { parentTopicId: "cardiovascular_disease", pubCount: 38 },
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
  // #481(b)/#2066 — activeGrants derives from grant.findMany + #160 suppression,
  // then groups by funding PROJECT (`coreProjectNum ?? accountNumber`) via the
  // shared `loadUnitGrantProjects`, not from grant.count and not from a row
  // count. 25 rows on 25 distinct NIH core projects, none suppressed → 25.
  mockGrantFindMany.mockResolvedValue(
    Array.from({ length: 25 }, (_, i) => grantRow(i)),
  );
  mockSuppressionFindMany.mockResolvedValue([]);
  // #2542 contract A — no vocabulary row by default; the department's own
  // chair/director + the division's chief both resolve through the
  // `OrgUnitRoleAssignment` row now (`Department.chairCwid` /
  // `Division.chiefCwid` no longer exist as read sources).
  mockOrgUnitRoleFindUnique.mockResolvedValue(null);
  mockOrgUnitRoleAssignmentFindFirst.mockResolvedValue({
    cwid: "chair001",
    interim: false,
    role: { label: "Chair" },
  });
  mockDivChiefAssignmentFindFirst.mockResolvedValue({
    cwid: "chief001",
    interim: false,
    role: { label: "Chief" },
  });
}

/** One active grant row shaped like `UNIT_GRANT_SELECT`. `i` gives it its own
 *  Account_Number, cwid, and NIH core project, so N rows fold to N projects. */
function grantRow(i: number, over: Record<string, unknown> = {}) {
  const n = String(i).padStart(4, "0");
  return {
    cwid: `cw${n}`,
    title: `Grant ${i}`,
    role: "PI",
    funder: "NCI",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2029-12-31"),
    externalId: `INFOED-ACC${n}-cw${n}`,
    awardNumber: `1R01CA30${n}-01`,
    applId: null,
    ...over,
  };
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

  it("returns department with the chair assignment resolved when chair appointment exists", async () => {
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

  it("returns null chair when there is no override and no assignment", async () => {
    mockDepartmentFindUnique.mockResolvedValue({ ...DEPT });
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockTopicFindMany.mockResolvedValue([]);
    mockDivisionFindMany.mockResolvedValue([]);
    mockScholarFindMany.mockResolvedValue([]);
    mockScholarCount.mockResolvedValue(100);
    mockPublicationTopicCount.mockResolvedValue(500);
    mockGrantCount.mockResolvedValue(10);
    mockGrantFindMany.mockResolvedValue([]);
    mockFieldOverrideFindMany.mockResolvedValue([]);
    mockSuppressionFindFirst.mockResolvedValue(null);
    mockSuppressionFindMany.mockResolvedValue([]);
    mockOrgUnitRoleFindUnique.mockResolvedValue(null);
    mockOrgUnitRoleAssignmentFindFirst.mockResolvedValue(null);

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

  it("top research areas count DISTINCT pmids for active dept scholars, top 10", async () => {
    mockDefaultDeptSetup();
    await getDepartment("medicine");

    // A paper with several department authors has several publication_topic
    // rows (PK pmid, cwid, parent_topic_id); a row count would count it once
    // per author. The ranking must count it once.
    expect(mockTopAreasQueryRaw).toHaveBeenCalledTimes(1);
    const sql = mockTopAreasQueryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    const text = sql.sql.replace(/\s+/g, " ");
    expect(text).toContain("COUNT(DISTINCT pt.pmid)");
    expect(text).toContain("s.dept_code = ?");
    expect(text).toContain("s.deleted_at IS NULL");
    expect(text).toContain("s.status = 'active'");
    expect(text).toContain("LIMIT 10");
    expect(sql.values).toEqual(["MED"]);
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

  it("activeGrants excludes #160-suppressed active grants (#481(b))", async () => {
    mockDefaultDeptSetup();
    // 4 active grant rows on 4 distinct projects; one is #160-suppressed → the
    // hero stat must drop it so it agrees with the Grants-tab list/badge.
    mockGrantFindMany.mockResolvedValue([0, 1, 2, 3].map((i) => grantRow(i)));
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "INFOED-ACC0002-cw0002" },
    ]);

    const result = await getDepartment("medicine");

    expect(result!.stats.activeGrants).toBe(3);
    // the suppression lookup is scoped to active (non-revoked) grant suppressions
    const supCall = mockSuppressionFindMany.mock.calls[0][0];
    expect(supCall.where.entityType).toBe("grant");
    expect(supCall.where.revokedAt).toBeNull();
  });

  it("counts active grants by funding PROJECT, not investigator-award row (#2066)", async () => {
    mockDefaultDeptSetup();
    // 4 rows, 2 projects: a two-PD/PI award on one Account_Number, and a renewal
    // pair whose award-number spellings differ but share one coreProjectNum.
    // `externalId` embeds the cwid, so a row count reports 4 — the defect #2066
    // exists to remove (Medicine measured 1005 rows vs 520 projects).
    mockGrantFindMany.mockResolvedValue([
      grantRow(1, { cwid: "mpi001", externalId: "INFOED-A100-mpi001", awardNumber: "1R01CA245678-01" }),
      grantRow(2, { cwid: "mpi002", role: "Co-PI", externalId: "INFOED-A100-mpi002", awardNumber: "1R01CA245678-01" }),
      grantRow(3, { cwid: "ren001", externalId: "INFOED-A600-ren001", awardNumber: "1R01CA333333-01" }),
      grantRow(4, { cwid: "ren001", externalId: "INFOED-A700-ren001", awardNumber: "5 R01 CA333333-02" }),
    ]);

    const result = await getDepartment("medicine");
    expect(result!.stats.activeGrants).toBe(2);
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
  divCode?: string | null;
}) {
  return {
    cwid: overrides.cwid,
    divCode: overrides.divCode ?? null,
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
    // #974 — default both methods flags OFF (off-path = byte-identical to pre-#974)
    // and the overlay gate empty (public) for the cases that flip a flag on.
    mockChipsEnabled.mockReturnValue(false);
    mockFacetEnabled.mockReturnValue(false);
    mockLoadOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
    // #2542 contract A — the divCode-scoped chief-first ordering resolves the
    // chief via `resolveUnitLeader` (override > assignment) now, not a direct
    // `Division.chiefCwid` column read. No-op for tests that pass no divCode.
    mockFieldOverrideFindMany.mockResolvedValue([]);
    mockDivChiefAssignmentFindFirst.mockResolvedValue(null);
    mockMeshSearch.mockResolvedValue({ body: { hits: { hits: [] } } });
    // Roster pub counts: confirmed authorships minus #356 per-author hides.
    mockPublicationAuthorGroupBy.mockResolvedValue([]);
    mockSuppressionFindMany.mockResolvedValue([]);
  });

  // Unit Page v2 — the roster ranks from the index (a `select` findMany over the
  // whole carved dept) and hydrates one page (an `include` findMany over that
  // page's cwids). Route the mock by `include` so each call sees the right rows.
  function routeScholarFindMany(rows: ReturnType<typeof makeScholarRow>[]) {
    mockScholarFindMany.mockImplementation(
      (args: { include?: unknown; where: { cwid?: { in: string[] } } }) =>
        Promise.resolve(
          "include" in args && args.where.cwid
            ? rows.filter((r) => args.where.cwid!.in.includes(r.cwid))
            : rows,
        ),
    );
  }

  it("returns empty result when deptCode has no scholars", async () => {
    mockScholarFindMany.mockResolvedValue([]);

    const result = await getDepartmentFaculty("UNKNOWN", {});
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(20);
  });

  it("Unit Page v2 — attaches TOPICS `topMesh` after the roster read, in ONE lookup", async () => {
    routeScholarFindMany([
      makeScholarRow({ cwid: "s1111111" }),
      makeScholarRow({ cwid: "s2222222" }),
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);
    mockMeshSearch.mockResolvedValue({
      body: {
        hits: {
          hits: [
            { _id: "s1111111", _source: { topMeshTerms: [{ ui: "D000001", label: "Alpha" }] } },
          ],
        },
      },
    });

    const result = await getDepartmentFaculty("MED", {});
    expect(mockMeshSearch).toHaveBeenCalledTimes(1);
    const byCwid = new Map(result.hits.map((h) => [h.cwid, h]));
    expect(byCwid.get("s1111111")?.topMesh).toEqual([{ ui: "D000001", label: "Alpha" }]);
    expect(byCwid.get("s2222222")).not.toHaveProperty("topMesh");
  });

  it("Unit Page v2 — an OpenSearch failure still returns the roster, without chips", async () => {
    routeScholarFindMany([makeScholarRow({ cwid: "s1111111" })]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);
    mockMeshSearch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getDepartmentFaculty("MED", {});
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).not.toHaveProperty("topMesh");
    warn.mockRestore();
  });

  it("filters faculty by deptCode, carving the member query", async () => {
    routeScholarFindMany([
      makeScholarRow({ cwid: "s1111111" }),
      makeScholarRow({ cwid: "s2222222" }),
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", {});
    expect(result.total).toBe(2);
    expect(result.hits).toHaveLength(2);
    // The index (member) query carries the dept + the active/not-deleted carve.
    const indexCall = mockScholarFindMany.mock.calls.find((c) => !("include" in c[0]))![0];
    expect(indexCall.where.deptCode).toBe("MED");
    expect(indexCall.where.deletedAt).toBeNull();
    expect(indexCall.where.status).toBe("active");
  });

  it("optionally filters by divCode when provided", async () => {
    routeScholarFindMany([
      makeScholarRow({ cwid: "div00001", divCode: "CARDIO" }),
      makeScholarRow({ cwid: "div00002", divCode: "CARDIO" }),
      makeScholarRow({ cwid: "oth00001", divCode: "ONCO" }),
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", { divCode: "CARDIO" });
    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.cwid).sort()).toEqual(["div00001", "div00002"]);
  });

  it("paginates 20 per page in SURNAME order across the page boundary (Unit Page v2 default)", async () => {
    // 25 scholars; "Given<i> Surname<letter>" — first names sort the opposite way.
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeScholarRow({
        cwid: `pg${String(i).padStart(6, "0")}`,
        preferredName: `${String.fromCharCode(90 - i)}given ${String.fromCharCode(65 + i)}surname`,
      }),
    );
    routeScholarFindMany([...rows].reverse());
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const p0 = await getDepartmentFaculty("MED", { page: 0 });
    const p1 = await getDepartmentFaculty("MED", { page: 1 });
    expect(p0.total).toBe(25);
    expect(p1.page).toBe(1);
    expect(p0.hits).toHaveLength(20);
    expect(p1.hits).toHaveLength(5);
    const order = [...p0.hits, ...p1.hits].map((h) => h.cwid);
    expect(order).toEqual(rows.map((r) => r.cwid));
    // Only the page's cwids are hydrated.
    const hydrate = mockScholarFindMany.mock.calls.filter((c) => "include" in c[0]).at(-1)![0];
    expect(hydrate.where.cwid.in).toEqual(rows.slice(20).map((r) => r.cwid));
  });

  it("sort=pubs ranks by the displayed pub count, surname tiebreak", async () => {
    routeScholarFindMany([
      makeScholarRow({ cwid: "a0000001", preferredName: "Amy Adams" }),
      makeScholarRow({ cwid: "b0000001", preferredName: "Bob Baker" }),
      makeScholarRow({ cwid: "c0000001", preferredName: "Cy Clark" }),
    ]);
    mockPublicationAuthorGroupBy.mockResolvedValue([
      { cwid: "b0000001", _count: { _all: 9 } },
      { cwid: "c0000001", _count: { _all: 9 } },
      { cwid: "a0000001", _count: { _all: 2 } },
    ]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", { sort: "pubs" });
    expect(result.hits.map((h) => h.cwid)).toEqual(["b0000001", "c0000001", "a0000001"]);
    expect(result.hits.map((h) => h.pubCount)).toEqual([9, 9, 2]);
  });

  it("sort=pubs counts each paper once: confirmed authorships minus hides, never publication_topic rows", async () => {
    routeScholarFindMany([
      makeScholarRow({ cwid: "a0000001", preferredName: "Amy Adams" }),
      makeScholarRow({ cwid: "b0000001", preferredName: "Bob Baker" }),
    ]);
    // publication_topic is keyed (pmid, cwid, parentTopicId): one paper on two
    // parent topics is two rows. If the roster counted these rows, Amy would
    // rank first with 2 "papers" — she has 1.
    mockPublicationTopicGroupBy.mockResolvedValue([
      { cwid: "a0000001", _count: { pmid: 2 } },
    ]);
    mockPublicationAuthorGroupBy.mockResolvedValue([
      { cwid: "a0000001", _count: { _all: 1 } },
      { cwid: "b0000001", _count: { _all: 3 } },
    ]);
    // Bob hid one of his three authorships (#356).
    mockSuppressionFindMany.mockResolvedValue([{ contributorCwid: "b0000001" }]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", { sort: "pubs" });
    expect(result.hits.map((h) => [h.cwid, h.pubCount])).toEqual([
      ["b0000001", 2],
      ["a0000001", 1],
    ]);
    expect(mockPublicationTopicGroupBy).not.toHaveBeenCalled();
    expect(mockPublicationAuthorGroupBy.mock.calls[0][0].where).toMatchObject({ isConfirmed: true });
  });

  it("places chief-of-division first when divCode provided (surname sort only)", async () => {
    mockDivChiefAssignmentFindFirst.mockResolvedValue({
      cwid: "chief001",
      interim: false,
      role: { label: "Chief" },
    });
    routeScholarFindMany([
      makeScholarRow({ cwid: "chief001", preferredName: "Dr. Zed", divCode: "CARDIO", divisionName: "Cardiology" }),
      makeScholarRow({ cwid: "other001", preferredName: "A Scholar", divCode: "CARDIO" }),
      makeScholarRow({ cwid: "other002", preferredName: "B Scholar", divCode: "CARDIO" }),
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", { divCode: "CARDIO", page: 0 });
    expect(result.hits[0].cwid).toBe("chief001");
    expect(result.hits[0].preferredName).toBe("Dr. Zed");
    // Other rows follow in surname order ("scholar" ties → preferredName).
    expect(result.hits[1].cwid).toBe("other001");
    expect(result.hits[2].cwid).toBe("other002");

    // A count sort is an explicit ranking — no pin.
    const byGrants = await getDepartmentFaculty("MED", { divCode: "CARDIO", sort: "grants" });
    expect(byGrants.hits[0].cwid).toBe("other001");
  });

  it("each hit contains the expected fields including identityImageEndpoint", async () => {
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
    mockPublicationAuthorGroupBy.mockResolvedValue([{ cwid: "abc12345", _count: { _all: 15 } }]);
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

  it("#974 — facet flag OFF: no methodFacet key, no scholarFamily.groupBy, no extra cwid query", async () => {
    mockScholarCount.mockResolvedValue(1);
    mockDivisionFindFirst.mockResolvedValue(null);
    mockScholarFindMany.mockResolvedValue([makeScholarRow({ cwid: "off00001" })]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);

    const result = await getDepartmentFaculty("MED", {});

    // `methodFacet` is undefined → JSON.stringify omits it, so the SERIALIZED
    // payload (what reaches the client/CloudFront) is byte-identical to pre-#974.
    expect(result.methodFacet).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("methodFacet");
    expect(mockScholarFamilyGroupBy).not.toHaveBeenCalled();
    // Only the index select + the page hydration ran — no extra
    // full-member-cwid findMany for the facet.
    expect(mockScholarFindMany).toHaveBeenCalledTimes(2);
  });

  it("#974 — facet flag ON: methodFacet populated from a PUBLIC-only aggregation", async () => {
    mockFacetEnabled.mockReturnValue(true);
    mockScholarCount.mockResolvedValue(2);
    mockDivisionFindFirst.mockResolvedValue(null);
    // index member select (call 1) then the page hydration (call 2).
    mockScholarFindMany
      .mockResolvedValueOnce([
        makeScholarRow({ cwid: "on000001" }),
        makeScholarRow({ cwid: "on000002" }),
      ])
      .mockResolvedValueOnce([{ cwid: "on000001" }, { cwid: "on000002" }]);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockGrantGroupBy.mockResolvedValue([]);
    // A public bucket (count 7) and a #800-suppressed one (count 9, must drop).
    mockScholarFamilyGroupBy.mockResolvedValue([
      { supercategory: "imaging_x", familyLabel: "Deep learning", _count: { cwid: 7 } },
      { supercategory: "imaging_x", familyLabel: "Secret", _count: { cwid: 9 } },
    ]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set(["imaging_x::Secret"]),
      sensitive: new Set(),
    });

    const result = await getDepartmentFaculty("MED", {});

    expect(mockScholarFamilyGroupBy).toHaveBeenCalledTimes(1);
    // The facet reuses the index's member set — still just index + hydration.
    expect(mockScholarFindMany).toHaveBeenCalledTimes(2);
    expect(result.methodFacet).toEqual([
      { value: "imaging_x::Deep learning", label: "Deep learning", count: 7 },
    ]);
  });

  it("export exists and is a function (GREEN: implementation present)", () => {
    expect(typeof getDepartment).toBe("function");
    expect(typeof getDepartmentFaculty).toBe("function");
  });
});
