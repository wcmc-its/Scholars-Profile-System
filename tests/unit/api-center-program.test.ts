/**
 * #1105 — `getCenterProgram` loader: dedicated per-program page data.
 *
 *  - resolves center (by slug) + program (by code), active members only;
 *  - ZY (and any excluded code) → null (never a page);
 *  - unknown center / unknown program → null;
 *  - leaders resolution (#1117 — 0..N): each `CenterProgramLeader` cwid → WCM
 *    scholar (profile-linked); else the external-leaders fallback keyed
 *    `<centerCode>:<programCode>` (slug null) when it names that cwid; an
 *    unresolvable cwid is dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCenterFindUnique,
  mockSuppressionFindFirst,
  mockSuppressionFindMany,
  mockCenterMembershipFindMany,
  mockScholarFindUnique,
  mockScholarFindMany,
  mockCenterProgramFindUnique,
  mockCenterProgramFindMany,
  mockPublicationTopicGroupBy,
  mockGrantFindMany,
} = vi.hoisted(() => ({
  mockCenterFindUnique: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockCenterProgramFindUnique: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    center: { findUnique: mockCenterFindUnique },
    suppression: { findFirst: mockSuppressionFindFirst, findMany: mockSuppressionFindMany },
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: { findUnique: mockScholarFindUnique, findMany: mockScholarFindMany },
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

const ACTIVE = { startDate: null, endDate: null };

beforeEach(() => {
  vi.clearAllMocks();
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
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  // program row (#1117 — leaders are a relation, empty by default)
  mockCenterProgramFindUnique.mockResolvedValue({
    code: "CB",
    label: "Cancer Biology",
    description: "Studies the biology of cancer.",
    leaders: [],
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

  it("resolves co-leaders from the join rows (WCM scholars, profile-linked, in order)", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CB",
      label: "Cancer Biology",
      description: null,
      leaders: [
        { cwid: "lead001", interim: true, role: "leader" },
        { cwid: "lead002", interim: false, role: "leader" },
      ],
    });
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
      },
      {
        cwid: "lead002",
        preferredName: "LEAD002",
        slug: "lead002",
        primaryTitle: null,
        identityImageEndpoint: expect.any(String),
        isInterim: false,
        role: "leader",
      },
    ]);
  });

  it("orders Leaders before COE liaisons and surfaces the role (#1570)", async () => {
    // The join returns them interleaved (both sortOrder 0); the loader must place
    // the coe_liaison AFTER the leader regardless of the row order it receives,
    // and NOT rely on alphabetical role ordering (coe_liaison < leader lexically).
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CB",
      label: "Cancer Biology",
      description: null,
      leaders: [
        { cwid: "liaison01", interim: false, role: "coe_liaison" },
        { cwid: "lead001", interim: false, role: "leader" },
      ],
    });
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leaders.map((l) => [l.cwid, l.role])).toEqual([
      ["lead001", "leader"],
      ["liaison01", "coe_liaison"],
    ]);
  });

  it("defaults a role-less join row to 'leader' (pre-#1570 rows)", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CB",
      label: "Cancer Biology",
      description: null,
      leaders: [{ cwid: "lead001", interim: false }],
    });
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leaders[0].role).toBe("leader");
  });

  it("falls back to the external leader (slug null) for a cwid with no scholar row", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CPC",
      label: "Cancer Prevention & Control",
      description: null,
      leaders: [{ cwid: "ext1234", interim: false }],
    });
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
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CB",
      label: "Cancer Biology",
      description: null,
      leaders: [{ cwid: "ghost", interim: false }],
    });
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
