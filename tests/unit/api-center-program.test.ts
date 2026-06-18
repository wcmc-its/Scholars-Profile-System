/**
 * #1105 — `getCenterProgram` loader: dedicated per-program page data.
 *
 *  - resolves center (by slug) + program (by code), active members only;
 *  - ZY (and any excluded code) → null (never a page);
 *  - unknown center / unknown program → null;
 *  - leader resolution: leaderCwid → WCM scholar (profile-linked); else the
 *    external-leaders fallback keyed `<centerCode>:<programCode>` (slug null).
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

import { getCenterProgram, isProgramPageEligible } from "@/lib/api/centers";

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
  // program row
  mockCenterProgramFindUnique.mockResolvedValue({
    code: "CB",
    label: "Cancer Biology",
    description: "Studies the biology of cancer.",
    leaderCwid: null,
    leaderInterim: false,
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

  it("resolves the leader from leaderCwid (WCM scholar, profile-linked)", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CB",
      label: "Cancer Biology",
      description: null,
      leaderCwid: "lead001",
      leaderInterim: true,
    });
    mockScholarFindUnique.mockResolvedValueOnce({
      cwid: "lead001",
      preferredName: "Dana Leader",
      slug: "dana-leader",
      primaryTitle: "Professor of Medicine",
    });
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leader).toEqual({
      cwid: "lead001",
      preferredName: "Dana Leader",
      slug: "dana-leader",
      primaryTitle: "Professor of Medicine",
      identityImageEndpoint: expect.any(String),
      isInterim: true,
    });
  });

  it("falls back to the external leader (slug null) when leaderCwid does not resolve", async () => {
    mockCenterProgramFindUnique.mockResolvedValueOnce({
      code: "CPC",
      label: "Cancer Prevention & Control",
      description: null,
      leaderCwid: null,
      leaderInterim: false,
    });
    const detail = await getCenterProgram("meyer-cancer-center", "CPC");
    expect(detail!.leader).not.toBeNull();
    expect(detail!.leader!.cwid).toBe("ext1234");
    expect(detail!.leader!.preferredName).toBe("External PI");
    expect(detail!.leader!.slug).toBeNull();
  });

  it("returns null leader when neither cwid nor external fallback resolves", async () => {
    const detail = await getCenterProgram("meyer-cancer-center", "CB");
    expect(detail!.leader).toBeNull();
  });
});
