/**
 * #540 Phase 3b — `getDivision` × unit-curation read-merge integration.
 *
 *  - edge 1/6 — description and leaderCwid overrides win at read.
 *  - edge 4   — LDAP-adopted manual division: curated `leaderCwid` /
 *               `leaderInterim` hold (the merge runs every time).
 *  - edge 6   — `leaderCwid: ""` is explicit vacancy; no chief, no auto-detect.
 *  - edge 15  — `Division.source = 'manual'` unions `DivisionMembership` with
 *               LDAP-derived scholars; dedup by CWID.
 *  - edge 20  — suppression returns 404 (null) from `getDivision`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDepartmentFindUnique,
  mockDivisionFindFirst,
  mockDivisionFindMany,
  mockDivisionMembershipFindMany,
  mockScholarFindUnique,
  mockScholarFindMany,
  mockScholarCount,
  mockAppointmentFindFirst,
  mockGrantFindMany,
  mockTopicFindMany,
  mockQueryRawUnsafe,
  mockPublicationAuthorFindMany,
  mockPublicationCount,
  mockSuppressionFindMany,
  mockFieldOverrideFindMany,
  mockSuppressionFindFirst,
  mockOrgUnitRoleFindUnique,
  mockOrgUnitRoleAssignmentFindFirst,
} = vi.hoisted(() => ({
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarCount: vi.fn(),
  mockAppointmentFindFirst: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockPublicationCount: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockOrgUnitRoleFindUnique: vi.fn(),
  mockOrgUnitRoleAssignmentFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: mockDepartmentFindUnique },
    division: {
      findFirst: mockDivisionFindFirst,
      findMany: mockDivisionFindMany,
    },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
    scholar: {
      findUnique: mockScholarFindUnique,
      findMany: mockScholarFindMany,
      count: mockScholarCount,
    },
    appointment: { findFirst: mockAppointmentFindFirst },
    grant: { findMany: mockGrantFindMany },
    topic: { findMany: mockTopicFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    publication: { count: mockPublicationCount },
    suppression: {
      findFirst: mockSuppressionFindFirst,
      findMany: mockSuppressionFindMany,
    },
    fieldOverride: { findMany: mockFieldOverrideFindMany },
    orgUnitRole: { findUnique: mockOrgUnitRoleFindUnique },
    orgUnitRoleAssignment: { findFirst: mockOrgUnitRoleAssignmentFindFirst },
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));

import { getDivision } from "@/lib/api/divisions";

const DEPT = {
  code: "MED",
  name: "Department of Medicine",
  slug: "medicine",
};

const DIVISION = {
  code: "CARDIO",
  deptCode: "MED",
  name: "Cardiology",
  slug: "cardiology",
  description: "ETL-seeded division blurb.",
  url: null,
  scholarCount: 50,
  source: "ED",
};

function defaultBaselineMocks() {
  mockDepartmentFindUnique.mockResolvedValue(DEPT);
  mockDivisionFindFirst.mockResolvedValue(DIVISION);
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockFieldOverrideFindMany.mockResolvedValue([]);
  mockScholarFindUnique.mockResolvedValue({
    cwid: "etl0002",
    preferredName: "ETL Chief",
    slug: "etl-chief",
    primaryTitle: "Chief of Cardiology",
  });
  mockAppointmentFindFirst.mockResolvedValue({ title: "Chief, Cardiology" });
  mockDivisionFindMany.mockResolvedValue([]);
  mockQueryRawUnsafe.mockResolvedValue([]);
  mockTopicFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
  // #2202 — `stats.scholars` is now a carved `scholar.count` over the union
  // rather than `memberCwids.length`, because the roster it labels drops hidden
  // identity classes. No fixture here carries one, so the count is the union
  // size and every edge-13/15/19 expectation below is unchanged.
  mockScholarCount.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
    Promise.resolve(args?.where?.cwid?.in?.length ?? 0),
  );
  mockPublicationAuthorFindMany.mockResolvedValue([]);
  mockPublicationCount.mockResolvedValue(0);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  // #2542 contract A — no vocabulary row by default; the chief resolves
  // through the `OrgUnitRoleAssignment` row (`Division.chiefCwid` no longer
  // exists as a read source), matching the `etl0002` identity these tests
  // were originally written against.
  mockOrgUnitRoleFindUnique.mockResolvedValue(null);
  mockOrgUnitRoleAssignmentFindFirst.mockResolvedValue({
    cwid: "etl0002",
    interim: false,
    role: { label: "Chief" },
  });
}

describe("getDivision — unit-curation read-merge (#540)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the division is whole-unit suppressed (edge 20)", async () => {
    defaultBaselineMocks();
    mockSuppressionFindFirst.mockResolvedValue({ id: "sup-1" });

    expect(await getDivision("medicine", "cardiology")).toBeNull();
    // Short-circuit before any chief / topic / stats query.
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("description override wins over the ETL seed (edge 1)", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "description", value: "Curated division blurb." },
    ]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.division.description).toBe("Curated division blurb.");
  });

  it("leaderCwid override drives the chief lookup (edge 6)", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderCwid", value: "ovr0002" },
    ]);
    mockScholarFindUnique.mockResolvedValue({
      cwid: "ovr0002",
      preferredName: "Curated Chief",
      slug: "curated-chief",
      primaryTitle: "Professor",
    });

    const result = await getDivision("medicine", "cardiology");
    expect(result?.chief?.cwid).toBe("ovr0002");
    expect(mockScholarFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: "ovr0002" } }),
    );
  });

  it("leaderCwid override of \"\" is explicit vacancy; no chief, no auto-detect fallback (edge 6)", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderCwid", value: "" },
    ]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.chief).toBeNull();
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
    expect(mockAppointmentFindFirst).not.toHaveBeenCalled();
  });

  it("leaderInterim override surfaces as chief.isInterim", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderInterim", value: "true" },
    ]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.chief?.isInterim).toBe(true);
  });

  // #2542 — the render-layer repoint. Before this, `division-page.tsx`
  // hardcoded `role="Chief"` with no vocabulary at all; now the label comes
  // from the assignment's own vocabulary-joined `role.label`, so a steward
  // rename via /edit/roles must show up here without a code change.
  it("resolves chief.role from the assignment's vocabulary-joined label, not the hardcoded 'Chief' literal", async () => {
    defaultBaselineMocks();
    mockOrgUnitRoleAssignmentFindFirst.mockResolvedValue({
      cwid: "etl0002",
      interim: false,
      role: { label: "Division Head" },
    });

    const result = await getDivision("medicine", "cardiology");
    expect(result?.chief?.role).toBe("Division Head");
  });

  // `fallbackLabel` is consulted only on the OVERRIDE branch — the assignment
  // branch's label always comes from the joined `OrgUnitRole` row.
  it("falls back to 'Chief' when no vocabulary row exists yet (override branch, pre-seed behavior)", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderCwid", value: "ovr0002" },
    ]);
    mockOrgUnitRoleFindUnique.mockResolvedValue(null);
    mockScholarFindUnique.mockResolvedValue({
      cwid: "ovr0002",
      preferredName: "Curated Chief",
      slug: "curated-chief",
      primaryTitle: "Professor",
    });
    const result = await getDivision("medicine", "cardiology");
    expect(result?.chief?.role).toBe("Chief");
  });

  // #2542 — the full override > assignment precedence, mirroring the
  // department-side test in `api-dept-unit-curation.test.ts`.
  it("leaderCwid override wins over an existing OrgUnitRoleAssignment row, which is never even queried", async () => {
    defaultBaselineMocks();
    mockFieldOverrideFindMany.mockResolvedValue([
      { fieldName: "leaderCwid", value: "ovr0002" },
    ]);
    mockScholarFindUnique.mockResolvedValue({
      cwid: "ovr0002",
      preferredName: "Curated Chief",
      slug: "curated-chief",
      primaryTitle: "Professor",
    });

    const result = await getDivision("medicine", "cardiology");
    expect(result?.chief?.cwid).toBe("ovr0002");
    expect(mockOrgUnitRoleAssignmentFindFirst).not.toHaveBeenCalled();
  });

  it("with no override, the OrgUnitRoleAssignment row is the sole source of the chief", async () => {
    defaultBaselineMocks();
    mockOrgUnitRoleAssignmentFindFirst.mockResolvedValue({
      cwid: "assign002",
      interim: true,
      role: { label: "Chief" },
    });
    mockScholarFindUnique.mockResolvedValue({
      cwid: "assign002",
      preferredName: "Assignment-Table Chief",
      slug: "assignment-table-chief",
      primaryTitle: "Professor",
    });

    const result = await getDivision("medicine", "cardiology");
    // The scholar lookup went to THIS assignment's cwid, not the baseline
    // fixture's default assignment cwid ("etl0002").
    expect(result?.chief?.cwid).toBe("assign002");
    expect(result?.chief?.isInterim).toBe(true);
  });

  it("source='ED' does NOT consult DivisionMembership (baseline LDAP-only roster)", async () => {
    defaultBaselineMocks();
    await getDivision("medicine", "cardiology");
    expect(mockDivisionMembershipFindMany).not.toHaveBeenCalled();
  });

  it("source='manual' unions DivisionMembership with LDAP scholars; stats reflect the union (edge 15)", async () => {
    defaultBaselineMocks();
    mockDivisionFindFirst.mockResolvedValue({ ...DIVISION, source: "manual" });
    // #540 Phase 8 — `loadDivisionMemberCwids` issues two distinct
    // scholar.findMany shapes:
    //   - `where.divCode` for the LDAP attach lookup
    //   - `where.cwid.in` for the activity gate on roster-only CWIDs (edge 19:
    //     a rostered CWID with no active Scholar row does not surface).
    // The shared mock routes by where shape so a single fixture covers both
    // `getDivision` stats and `getDivisionTopResearchAreas` (each calls the
    // helper independently in this test path).
    const ALL_CWIDS = ["ldap0001", "shared", "manual0001"];
    mockScholarFindMany.mockImplementation((args?: {
      where?: { divCode?: string; cwid?: { in?: string[] } };
    }) => {
      if (args?.where?.divCode) {
        return Promise.resolve([{ cwid: "ldap0001" }, { cwid: "shared" }]);
      }
      if (args?.where?.cwid?.in) {
        const ins = args.where.cwid.in;
        return Promise.resolve(
          ins.filter((c) => ALL_CWIDS.includes(c)).map((cwid) => ({ cwid })),
        );
      }
      return Promise.resolve([]);
    });
    // Manual roster — `shared` already in LDAP, so dedup keeps it once.
    mockDivisionMembershipFindMany.mockResolvedValue([
      { cwid: "shared" },
      { cwid: "manual0001" },
    ]);
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockGrantFindMany.mockResolvedValue([]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.stats.scholars).toBe(3);
    expect(mockDivisionMembershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ divisionCode: "CARDIO" }),
      }),
    );
  });

  it("source='manual' with empty LDAP attaches the manual roster wholesale (pre-adoption, edge 13)", async () => {
    defaultBaselineMocks();
    mockDivisionFindFirst.mockResolvedValue({ ...DIVISION, source: "manual" });
    const ALL_CWIDS = ["manualA", "manualB"];
    mockScholarFindMany.mockImplementation((args?: {
      where?: { divCode?: string; cwid?: { in?: string[] } };
    }) => {
      if (args?.where?.divCode) return Promise.resolve([]); // no LDAP scholars yet
      if (args?.where?.cwid?.in) {
        const ins = args.where.cwid.in;
        return Promise.resolve(
          ins.filter((c) => ALL_CWIDS.includes(c)).map((cwid) => ({ cwid })),
        );
      }
      return Promise.resolve([]);
    });
    mockDivisionMembershipFindMany.mockResolvedValue([
      { cwid: "manualA" },
      { cwid: "manualB" },
    ]);
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockGrantFindMany.mockResolvedValue([]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.stats.scholars).toBe(2);
  });

  it("source='manual' drops a rostered CWID with no active Scholar row (edge 19)", async () => {
    // The membership table has no Scholar FK; a roster row for an incoming
    // hire is stored but does NOT surface on public reads until the Scholar
    // record lands. Phase 8's activity gate is what enforces that.
    defaultBaselineMocks();
    mockDivisionFindFirst.mockResolvedValue({ ...DIVISION, source: "manual" });
    mockScholarFindMany.mockImplementation((args?: {
      where?: { divCode?: string; cwid?: { in?: string[] } };
    }) => {
      if (args?.where?.divCode) return Promise.resolve([{ cwid: "ldap0001" }]);
      if (args?.where?.cwid?.in) {
        // Only `ldap0001` has an active Scholar row; `incomingHire0001` does not.
        const ins = args.where.cwid.in;
        return Promise.resolve(
          ins.filter((c) => c === "ldap0001").map((cwid) => ({ cwid })),
        );
      }
      return Promise.resolve([]);
    });
    mockDivisionMembershipFindMany.mockResolvedValue([
      { cwid: "incomingHire0001" },
    ]);
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockGrantFindMany.mockResolvedValue([]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.stats.scholars).toBe(1);
  });

  it("the suppression check runs against entityType='division' + division.code", async () => {
    defaultBaselineMocks();
    await getDivision("medicine", "cardiology");
    expect(mockSuppressionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "division",
          entityId: "CARDIO",
          revokedAt: null,
        }),
      }),
    );
  });
});
