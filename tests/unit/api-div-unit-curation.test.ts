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
  mockAppointmentFindFirst,
  mockGrantFindMany,
  mockTopicFindMany,
  mockQueryRawUnsafe,
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockFieldOverrideFindMany,
  mockSuppressionFindFirst,
} = vi.hoisted(() => ({
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockAppointmentFindFirst: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
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
    },
    appointment: { findFirst: mockAppointmentFindFirst },
    grant: { findMany: mockGrantFindMany },
    topic: { findMany: mockTopicFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: {
      findFirst: mockSuppressionFindFirst,
      findMany: mockSuppressionFindMany,
    },
    fieldOverride: { findMany: mockFieldOverrideFindMany },
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
  chiefCwid: "etl0002",
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
  mockPublicationAuthorFindMany.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
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

  it("source='ED' does NOT consult DivisionMembership (baseline LDAP-only roster)", async () => {
    defaultBaselineMocks();
    await getDivision("medicine", "cardiology");
    expect(mockDivisionMembershipFindMany).not.toHaveBeenCalled();
  });

  it("source='manual' unions DivisionMembership with LDAP scholars; stats reflect the union (edge 15)", async () => {
    defaultBaselineMocks();
    mockDivisionFindFirst.mockResolvedValue({ ...DIVISION, source: "manual" });
    // LDAP-attached after adoption. Both the top-research-areas member fetch
    // and the stats member fetch issue the same scholar.findMany query, so a
    // shared `mockResolvedValue` covers both.
    mockScholarFindMany.mockResolvedValue([
      { cwid: "ldap0001" },
      { cwid: "shared" },
    ]);
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
    mockScholarFindMany.mockResolvedValue([]); // no LDAP scholars yet
    mockDivisionMembershipFindMany.mockResolvedValue([
      { cwid: "manualA" },
      { cwid: "manualB" },
    ]);
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockGrantFindMany.mockResolvedValue([]);

    const result = await getDivision("medicine", "cardiology");
    expect(result?.stats.scholars).toBe(2);
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
