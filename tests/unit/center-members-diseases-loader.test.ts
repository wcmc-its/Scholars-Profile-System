/**
 * D1 — `getCenterMembers` grouped path attaches each member's PUBLISHED curated
 * diseases (`CENTER_DISEASE_FACET`), and `buildPublishedDiseasesByCwid` (the
 * pure merge + publish filter it uses).
 *  - flag off ⇒ neither disease table (nor the center's switch) is queried and
 *    no hit carries `diseases`.
 *  - flag on ⇒ one batched read per table for the roster cwids; confirmed and
 *    (auto-publish on) high-confidence undecided rows publish; rejected never;
 *    a manual add (decision only) publishes with focus/rank null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCenterMembershipFindMany,
  mockScholarFindMany,
  mockCenterProgramFindMany,
  mockCenterFindUnique,
  mockAssignmentFindMany,
  mockDecisionFindMany,
} = vi.hoisted(() => ({
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockAssignmentFindMany: vi.fn(),
  mockDecisionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: { findMany: mockScholarFindMany },
    centerProgram: { findMany: mockCenterProgramFindMany },
    center: { findUnique: mockCenterFindUnique },
    cancerCenterDiseaseAssignment: { findMany: mockAssignmentFindMany },
    cancerCenterDiseaseDecision: { findMany: mockDecisionFindMany },
  },
}));
// Pass-through cache so every call runs the loader.
vi.mock("@/lib/api/swr-cache", () => ({
  cachedRead: (_key: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/api/roster-counts", () => ({
  loadRosterCounts: async () => ({ pubs: new Map(), grants: new Map() }),
}));
vi.mock("@/lib/api/roster-mesh", () => ({
  attachTopMesh: async <T,>(hits: T) => hits,
  loadTopMeshForMembers: async () => new Map(),
  withTopMesh: <T,>(members: T) => members,
}));
vi.mock("@/lib/api/methods-roster", () => ({
  loadPublicFamiliesForMembers: async () => new Map(),
  ROSTER_ROW_METHODS_CAP: 3,
}));

import { getCenterMembers } from "@/lib/api/centers";
import { buildPublishedDiseasesByCwid } from "@/lib/center-member-diseases";

function scholarRow(cwid: string) {
  return {
    cwid,
    preferredName: `Given ${cwid.toUpperCase()}`,
    slug: cwid,
    primaryTitle: null,
    primaryDepartment: "Medicine",
    roleCategory: "full_time_faculty",
    overview: null,
    professorialRank: null,
    primaryOrgCode: null,
    department: null,
    division: null,
  };
}

const ASSIGNMENTS = [
  // m1: primary high (undecided), secondary medium (confirmed), peripheral high (rejected)
  { cwid: "m1", diseaseCode: "BREAST", rank: 1, focus: "primary", confidence: "high" },
  { cwid: "m1", diseaseCode: "LUNG", rank: 2, focus: "secondary", confidence: "medium" },
  { cwid: "m1", diseaseCode: "SKIN", rank: 3, focus: "peripheral", confidence: "high" },
  // m2: low confidence, undecided — never published
  { cwid: "m2", diseaseCode: "GYN", rank: 1, focus: "primary", confidence: "low" },
];
const DECISIONS = [
  { cwid: "m1", diseaseCode: "LUNG", decision: "confirmed" },
  { cwid: "m1", diseaseCode: "SKIN", decision: "rejected" },
  // manual add — no assignment row
  { cwid: "m2", diseaseCode: "SARCOMA", decision: "confirmed" },
];

function seedRoster(autoPublish: boolean) {
  mockCenterMembershipFindMany.mockResolvedValue(
    ["m1", "m2", "m3"].map((cwid) => ({
      cwid,
      membershipType: "research",
      membershipRoleKey: null,
      roleVocabulary: null,
      programCode: "P1",
      startDate: null,
      endDate: null,
      source: "manual",
    })),
  );
  mockScholarFindMany.mockResolvedValue(["m1", "m2", "m3"].map(scholarRow));
  mockCenterProgramFindMany.mockResolvedValue([{ code: "P1", label: "Program One" }]);
  mockCenterFindUnique.mockResolvedValue({ diseaseAutoPublish: autoPublish });
  mockAssignmentFindMany.mockResolvedValue(ASSIGNMENTS);
  mockDecisionFindMany.mockResolvedValue(DECISIONS);
}

async function membersByCwid(code: string) {
  const result = await getCenterMembers(code, {});
  if (result.mode !== "grouped") throw new Error("expected grouped");
  return new Map(result.groups.flatMap((g) => g.members).map((m) => [m.cwid, m]));
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCenterMembers — CENTER_DISEASE_FACET off", () => {
  it("queries no disease table and attaches nothing", async () => {
    vi.stubEnv("CENTER_DISEASE_FACET", "off");
    seedRoster(true);
    const byCwid = await membersByCwid("C_OFF");
    expect(byCwid.size).toBe(3);
    expect(mockAssignmentFindMany).not.toHaveBeenCalled();
    expect(mockDecisionFindMany).not.toHaveBeenCalled();
    expect(mockCenterFindUnique).not.toHaveBeenCalled();
    for (const m of byCwid.values()) expect("diseases" in m).toBe(false);
  });
});

describe("getCenterMembers — CENTER_DISEASE_FACET on", () => {
  beforeEach(() => vi.stubEnv("CENTER_DISEASE_FACET", "on"));

  it("batches ONE read per table for the roster cwids", async () => {
    seedRoster(false);
    await membersByCwid("C_BATCH");
    expect(mockAssignmentFindMany).toHaveBeenCalledTimes(1);
    expect(mockDecisionFindMany).toHaveBeenCalledTimes(1);
    const where = mockAssignmentFindMany.mock.calls[0][0].where;
    expect([...where.cwid.in].sort()).toEqual(["m1", "m2", "m3"]);
    expect(mockCenterFindUnique.mock.calls[0][0].where).toEqual({ code: "C_BATCH" });
  });

  it("auto-publish OFF: only confirmed rows (incl. manual add) publish; rejected hidden", async () => {
    seedRoster(false);
    const byCwid = await membersByCwid("C_AUTO_OFF");
    expect(byCwid.get("m1")!.diseases).toEqual([
      { diseaseCode: "LUNG", label: "Lung & Thoracic Cancer", focus: "secondary", rank: 2 },
    ]);
    expect(byCwid.get("m2")!.diseases).toEqual([
      { diseaseCode: "SARCOMA", label: "Sarcoma & Bone Cancer", focus: null, rank: null },
    ]);
    expect("diseases" in byCwid.get("m3")!).toBe(false);
  });

  it("auto-publish ON: an undecided high-confidence row also publishes, primary first", async () => {
    seedRoster(true);
    const byCwid = await membersByCwid("C_AUTO_ON");
    expect(byCwid.get("m1")!.diseases!.map((d) => d.diseaseCode)).toEqual(["BREAST", "LUNG"]);
    // rejected SKIN (high) stays hidden even with auto-publish on
    expect(byCwid.get("m1")!.diseases!.some((d) => d.diseaseCode === "SKIN")).toBe(false);
    // m2's low-confidence GYN never auto-publishes
    expect(byCwid.get("m2")!.diseases!.map((d) => d.diseaseCode)).toEqual(["SARCOMA"]);
  });

  it("a center row with no switch value is treated as auto-publish off", async () => {
    seedRoster(true);
    mockCenterFindUnique.mockResolvedValue(null);
    const byCwid = await membersByCwid("C_NULL");
    expect(byCwid.get("m1")!.diseases!.map((d) => d.diseaseCode)).toEqual(["LUNG"]);
  });
});

describe("buildPublishedDiseasesByCwid", () => {
  it("orders primary first, then rank, manual adds (rank null) last", () => {
    const out = buildPublishedDiseasesByCwid(
      [
        { cwid: "a", diseaseCode: "LUNG", rank: 1, focus: "secondary", confidence: "high" },
        { cwid: "a", diseaseCode: "BREAST", rank: 2, focus: "primary", confidence: "high" },
        { cwid: "a", diseaseCode: "GYN", rank: 3, focus: "peripheral", confidence: "high" },
      ],
      [{ cwid: "a", diseaseCode: "SARCOMA", decision: "confirmed" }],
      true,
    );
    expect(out.get("a")!.map((d) => d.diseaseCode)).toEqual(["BREAST", "LUNG", "GYN", "SARCOMA"]);
  });

  it("omits a cwid with nothing published", () => {
    const out = buildPublishedDiseasesByCwid(
      [{ cwid: "b", diseaseCode: "LUNG", rank: 1, focus: "primary", confidence: "high" }],
      [{ cwid: "b", diseaseCode: "LUNG", decision: "rejected" }],
      true,
    );
    expect(out.has("b")).toBe(false);
  });
});
