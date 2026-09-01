/**
 * #1105 / #2558 — `getCenterProgram` loader: dedicated per-program page data.
 *
 *  - resolves center (by slug) + program (by code), active members only;
 *  - ZY (and any excluded code) → null (never a page);
 *  - unknown center / unknown program → null;
 *  - leaders resolution (#1117 — 0..N): each `OrgUnitRoleAssignment` cwid
 *    (`entityType: "center_program"`, #2558 — migrated off the retired
 *    per-program leader table) → WCM scholar (profile-linked); else the
 *    external-leaders fallback keyed `<centerCode>:<programCode>` (slug null)
 *    when it names that cwid; an unresolvable cwid is dropped;
 *  - `roleLabel` / `expansion` come from the joined `OrgUnitRole` vocabulary
 *    row, not a hardcoded ternary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCenterFindUnique,
  mockSuppressionFindFirst,
  mockSuppressionFindMany,
  mockCenterMembershipFindMany,
  mockScholarFindUnique,
  mockScholarFindMany,
  mockScholarCount,
  mockCenterProgramFindUnique,
  mockCenterProgramFindMany,
  mockAssignmentFindMany,
  mockPublicationTopicGroupBy,
  mockGrantFindMany,
} = vi.hoisted(() => ({
  mockCenterFindUnique: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarCount: vi.fn(),
  mockCenterProgramFindUnique: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockAssignmentFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    center: { findUnique: mockCenterFindUnique },
    // #2542 / #2558 — leadership is an `OrgUnitRoleAssignment` row fetched with
    // its own query; it used to be a nested `leaders` relation on `center` /
    // `centerProgram`.
    orgUnitRoleAssignment: { findMany: mockAssignmentFindMany },
    suppression: { findFirst: mockSuppressionFindFirst, findMany: mockSuppressionFindMany },
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: {
      findUnique: mockScholarFindUnique,
      findMany: mockScholarFindMany,
      count: mockScholarCount,
    },
    centerProgram: {
      findUnique: mockCenterProgramFindUnique,
      findMany: mockCenterProgramFindMany,
    },
    publicationTopic: { groupBy: mockPublicationTopicGroupBy },
    grant: { findMany: mockGrantFindMany },
  },
}));

vi.mock("@/lib/external-leaders", () => ({
  EXTERNAL_LEADERS: {
    // keyed <centerCode>:<programCode> for the program-page fallback
    "MEYER:CPC": { cwid: "ext1234", name: "External PI", primaryTitle: "Program Lead" },
  },
}));

import {
  getCenterProgram,
  getCenterPrograms,
  isProgramPageEligible,
} from "@/lib/api/centers";

/** scholar.findMany routes one active row per requested cwid (none dormant). */
function routeScholarFindMany(args?: { where?: { cwid?: { in?: string[] } } }) {
  const ins = args?.where?.cwid?.in ?? [];
  return Promise.resolve(
    ins.map((cwid) => ({
      cwid,
      preferredName: cwid.toUpperCase(),
      slug: cwid,
      primaryTitle: null,
      primaryDepartment: "Medicine",
      roleCategory: "full_time_faculty",
      overview: null,
      department: { name: "Department of Medicine" },
      division: null,
    })),
  );
}

/** Shapes an `orgUnitRoleAssignment.findMany` row the way the join select does. */
function assignmentRow(
  cwid: string,
  roleKey: "leader" | "coe_liaison",
  opts: { interim?: boolean; sortOrder?: number } = {},
) {
  return {
    cwid,
    interim: opts.interim ?? false,
    roleKey,
    sortOrder: opts.sortOrder ?? 0,
    role:
      roleKey === "coe_liaison"
        ? { label: "COE Liaison", expansion: "Community Outreach & Engagement" }
        : { label: "Leader", expansion: null },
  };
}

const ACTIVE = { startDate: null, endDate: null };

// `orgUnitRoleAssignment.findMany` backs BOTH `getCenter`'s center-leadership
// query (`entityType: "center"`, always empty in this fixture set — no test
// here exercises center directors) and `getCenterProgram`'s own
// program-leadership query (`entityType: "center_program"`). Route by
// `where.entityType` rather than call order, since `getCenterProgram` calls
// `getCenter` first internally.
let programAssignments: ReturnType<typeof assignmentRow>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  programAssignments = [];
  mockAssignmentFindMany.mockImplementation(
    (args?: { where?: { entityType?: string } }) =>
      Promise.resolve(args?.where?.entityType === "center_program" ? programAssignments : []),
  );
  // getCenter()
  mockCenterFindUnique.mockResolvedValue({
    code: "MEYER",
    name: "Meyer Cancer Center",
    slug: "meyer-cancer-center",
    description: null,
    url: null,
    directorCwid: null,
    leaderInterim: false,
  });
  mockSuppressionFindFirst.mockResolvedValue(null); // not whole-unit-suppressed
  mockSuppressionFindMany.mockResolvedValue([]);
  // getCenterMembers() — two programmed members
  mockCenterMembershipFindMany.mockResolvedValue([
    { cwid: "a", membershipType: "research", programCode: "CB", ...ACTIVE },
    { cwid: "b", membershipType: "research", programCode: "CT", ...ACTIVE },
  ]);
  mockCenterProgramFindMany.mockResolvedValue([
    { code: "CB", label: "Cancer Biology" },
    { code: "CT", label: "Cancer Therapeutics" },
  ]);
  mockScholarFindMany.mockImplementation(routeScholarFindMany);
  // #2202 — `getCenter`'s `scholarCount` hero stat is now a carved `scholar.count`
  // over the active member cwids (it labels a roster that drops hidden identity
  // classes). No fixture here carries one, so it stays the active-member count.
  mockScholarCount.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
    Promise.resolve(args?.where?.cwid?.in?.length ?? 0),
  );
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  // program row — leaders resolve via a separate `orgUnitRoleAssignment` query now.
  mockCenterProgramFindUnique.mockResolvedValue({
    code: "CB",
    label: "Cancer Biology",
    description: "Studies the biology of cancer.",
  });
  mockScholarFindUnique.mockResolvedValue(null);
});

describe("isProgramPageEligible", () => {
  it("excludes ZY and falsy codes; admits real codes", () => {
    expect(isProgramPageEligible("ZY")).toBe(false);
    expect(isProgramPageEligible(null)).toBe(false);
    expect(isProgramPageEligible("")).toBe(false);
    expect(isProgramPageEligible("CB")).toBe(true);
  });
});

describe("getCenterProgram (#1105)", () => {
  it("returns the program with only its own active members", async () => {
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail).not.toBeNull();
    expect(detail!.program.code).toBe("CB");
    expect(detail!.program.label).toBe("Cancer Biology");
    expect(detail!.program.description).toBe("Studies the biology of cancer.");
    expect(detail!.center.code).toBe("MEYER");
    // member "a" is in CB; "b" is in CT and must NOT appear here.
    expect(detail!.members.map((m) => m.cwid)).toEqual(["a"]);
    expect(detail!.scholarCount).toBe(1);
  });

  it("queries the assignment table scoped to this program's entityId", async () => {
    await getCenterProgram("meyer-cancer-center", "CB");
    expect(mockAssignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: "center_program", entityId: "MEYER:CB" },
      }),
    );
  });

  it("returns null for the excluded ZY catch-all program (no DB hit)", async () => {
    const detail = await getCenterProgram("meyer-cancer-center", "ZY");
    expect(detail).toBeNull();
    expect(mockCenterProgramFindUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown center slug", async () => {
    mockCenterFindUnique.mockResolvedValueOnce(null);
    const detail = await getCenterProgram("does-not-exist", "CB");
    expect(detail).toBeNull();
  });

  it("returns null for an unknown program code", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce(null);
    const detail = await getCenterProgram("meyer-cancer-center", "ZZ");
    expect(detail).toBeNull();
  });

  it("resolves co-leaders from the join rows (WCM scholars, profile-linked, in order), with the vocabulary roleLabel", async () => {
    programAssignments = [
      assignmentRow("lead001", "leader", { interim: true }),
      assignmentRow("lead002", "leader", { interim: false }),
    ];
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    // routeScholarFindMany resolves each requested cwid (preferredName = CWID upper).
    expect(detail!.leaders).toEqual([
      {
        cwid: "lead001",
        preferredName: "LEAD001",
        slug: "lead001",
        primaryTitle: null,
        identityImageEndpoint: expect.any(String),
        isInterim: true,
        role: "leader",
        roleLabel: "Interim Leader",
        expansion: null,
      },
      {
        cwid: "lead002",
        preferredName: "LEAD002",
        slug: "lead002",
        primaryTitle: null,
        identityImageEndpoint: expect.any(String),
        isInterim: false,
        role: "leader",
        roleLabel: "Leader",
        expansion: null,
      },
    ]);
  });

  it("orders Leaders before COE liaisons (via the query's own orderBy) and surfaces the role + vocabulary expansion (#1570)", async () => {
    // The query is already ordered leader-before-liaison (role.sortOrder asc);
    // this fixture hands the rows back in that order, mirroring what the real
    // `orderBy: [{ role: { sortOrder: "asc" } }, …]` produces.
    programAssignments = [
      assignmentRow("lead001", "leader"),
      assignmentRow("liaison01", "coe_liaison"),
    ];
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leaders.map((l) => [l.cwid, l.role, l.roleLabel, l.expansion])).toEqual([
      ["lead001", "leader", "Leader", null],
      ["liaison01", "coe_liaison", "COE Liaison", "Community Outreach & Engagement"],
    ]);
  });

  it("never applies the Interim prefix to a COE liaison, even when interim is true", async () => {
    programAssignments = [assignmentRow("liaison01", "coe_liaison", { interim: true })];
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leaders[0].roleLabel).toBe("COE Liaison");
  });

  it("falls back to the external leader (slug null) for a cwid with no scholar row", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CPC",
      label: "Cancer Prevention & Control",
      description: null,
    });
    programAssignments = [assignmentRow("ext1234", "leader")];
    // ext1234 is not a scholar — drop it from EVERY resolver call so the fallback
    // fires (full impl, not `…Once`, so call ordering can't matter).
    mockScholarFindMany.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
      routeScholarFindMany({
        where: { cwid: { in: (args?.where?.cwid?.in ?? []).filter((c) => c !== "ext1234") } },
      }),
    );
    const detail = await getCenterProgram("meyer-cancer-center", "CPC");
    expect(detail!.leaders).toHaveLength(1);
    expect(detail!.leaders[0].cwid).toBe("ext1234");
    expect(detail!.leaders[0].preferredName).toBe("External PI");
    expect(detail!.leaders[0].slug).toBeNull();
  });

  it("drops a leader cwid that resolves to neither a scholar nor the external fallback", async () => {
    programAssignments = [assignmentRow("ghost", "leader")];
    mockScholarFindMany.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
      routeScholarFindMany({
        where: { cwid: { in: (args?.where?.cwid?.in ?? []).filter((c) => c !== "ghost") } },
      }),
    );
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leaders).toEqual([]);
  });
});

describe("getCenterPrograms (#1105 — center 'Programs' nav)", () => {
  it("returns the page-eligible programs in taxonomy order, excluding ZY", async () => {
    mockCenterProgramFindMany.mockResolvedValueOnce([
      { code: "CB", label: "Cancer Biology" },
      { code: "CGE", label: "Cancer Genetics & Epigenetics" },
      { code: "ZY", label: "Non-aligned Clinical" },
      { code: "CT", label: "Cancer Therapeutics" },
    ]);
    const programs = await getCenterPrograms("MEYER");
    expect(programs.map((p) => p.code)).toEqual(["CB", "CGE", "CT"]);
    expect(programs.find((p) => p.code === "CB")!.label).toBe("Cancer Biology");
  });

  it("returns [] for a center with no program taxonomy", async () => {
    mockCenterProgramFindMany.mockResolvedValueOnce([]);
    expect(await getCenterPrograms("OTHER")).toEqual([]);
  });
});
