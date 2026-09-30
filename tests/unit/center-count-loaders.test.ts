/**
 * Count-only center loaders (`lib/api/centers.ts`) — the hero publication stat
 * and the tab-label counts, read without loading a page of cards.
 *
 * `getCenterPublicationCount` must equal `getCenterPublicationsList(code,
 * {}).total`, i.e. `publication.count(unitPublicationWhere({ membership: {
 * cwid: { in } }, darkPmids }))`: a distinct pmid with a CONFIRMED member
 * authorship, minus the unit's dark pmids. `getCenterGrantCount` must equal
 * `getCenterGrantsList(code, {}).total`. Fixtures are fake (public repo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockQueryRaw,
  mockCenterMembershipFindMany,
  mockScholarFindMany,
  mockLoadAllSuppressions,
  mockResolveUnitDarkPmids,
  mockLoadUnitGrantProjects,
  mockBuildUnitGrantCards,
  cacheKeys,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockLoadAllSuppressions: vi.fn(),
  mockResolveUnitDarkPmids: vi.fn(),
  mockLoadUnitGrantProjects: vi.fn(),
  mockBuildUnitGrantCards: vi.fn(),
  cacheKeys: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: { findMany: mockScholarFindMany },
  },
}));

vi.mock("@/lib/api/swr-cache", () => ({
  cachedRead: (key: string, load: () => Promise<unknown>) => {
    cacheKeys.push(key);
    return load();
  },
  bust: () => {},
}));

vi.mock("@/lib/api/manual-layer", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/manual-layer")>("@/lib/api/manual-layer");
  return {
    ...actual,
    loadAllPublicationSuppressions: mockLoadAllSuppressions,
    resolveUnitDarkPmids: mockResolveUnitDarkPmids,
  };
});

vi.mock("@/lib/api/unit-grant-projects", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/unit-grant-projects")>(
    "@/lib/api/unit-grant-projects",
  );
  return {
    ...actual,
    loadUnitGrantProjects: mockLoadUnitGrantProjects,
    buildUnitGrantCards: mockBuildUnitGrantCards,
  };
});

import {
  countUnitPublicationsForCwids,
  getCenterGrantCount,
  getCenterGrantsList,
  getCenterPublicationCount,
} from "@/lib/api/centers";

const NO_SUPPRESSIONS = { darkPmids: new Set<string>(), hiddenAuthorsByPmid: new Map() };

function sqlText(q: { sql: string }): string {
  return q.sql.replace(/\s+/g, " ").trim();
}

function withMembers(cwids: string[]) {
  mockCenterMembershipFindMany.mockResolvedValue(
    cwids.map((cwid) => ({ cwid, startDate: null, endDate: null, membershipRoleKey: null })),
  );
  mockScholarFindMany.mockResolvedValue(cwids.map((cwid) => ({ cwid })));
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheKeys.length = 0;
  mockQueryRaw.mockResolvedValue([{ n: BigInt(0) }]);
  mockCenterMembershipFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
  mockLoadAllSuppressions.mockResolvedValue(NO_SUPPRESSIONS);
  mockResolveUnitDarkPmids.mockResolvedValue([]);
  mockLoadUnitGrantProjects.mockResolvedValue([]);
  mockBuildUnitGrantCards.mockResolvedValue([]);
});

describe("countUnitPublicationsForCwids", () => {
  it("counts DISTINCT pmids over CONFIRMED authorships of the member cwids", async () => {
    mockQueryRaw.mockResolvedValue([{ n: BigInt(27) }]);
    expect(await countUnitPublicationsForCwids(["aaa0001", "aaa0002"], [])).toBe(27);
    const q = mockQueryRaw.mock.calls[0][0];
    const sql = sqlText(q);
    expect(sql).toContain("SELECT COUNT(DISTINCT pa.pmid) AS n FROM publication_author pa");
    expect(sql).toContain("pa.is_confirmed = 1");
    expect(sql).toContain("pa.cwid IN (?,?)");
    expect(sql).not.toContain("NOT IN");
    expect(q.values).toEqual(["aaa0001", "aaa0002"]);
  });

  it("suppression: removes the unit's dark pmids", async () => {
    await countUnitPublicationsForCwids(["aaa0001"], ["900009", "900010"]);
    const q = mockQueryRaw.mock.calls[0][0];
    expect(sqlText(q)).toContain("AND pa.pmid NOT IN (?,?)");
    expect(q.values).toEqual(["aaa0001", "900009", "900010"]);
  });

  it("no members → 0 without a query", async () => {
    expect(await countUnitPublicationsForCwids([], ["900009"])).toBe(0);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});

describe("getCenterPublicationCount", () => {
  it("resolves the center's dark pmids over its member predicate and excludes them", async () => {
    withMembers(["aaa0001", "aaa0002"]);
    const suppressions = {
      darkPmids: new Set(["900009"]),
      hiddenAuthorsByPmid: new Map(),
    };
    mockLoadAllSuppressions.mockResolvedValue(suppressions);
    mockResolveUnitDarkPmids.mockResolvedValue(["900009"]);
    mockQueryRaw.mockResolvedValue([{ n: 4 }]);

    expect(await getCenterPublicationCount("CTR1")).toBe(4);
    expect(mockResolveUnitDarkPmids).toHaveBeenCalledWith(
      suppressions,
      { cwid: { in: ["aaa0001", "aaa0002"] } },
      expect.anything(),
    );
    const q = mockQueryRaw.mock.calls[0][0];
    expect(sqlText(q)).toContain("AND pa.pmid NOT IN (?)");
    expect(q.values).toEqual(["aaa0001", "aaa0002", "900009"]);
    expect(cacheKeys).toContain("center:pubcount:CTR1");
  });

  it("a center with no active members → 0 without a publication query", async () => {
    expect(await getCenterPublicationCount("CTR1")).toBe(0);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});

describe("getCenterGrantCount", () => {
  it("counts the same funding projects the Grants tab lists, without building cards", async () => {
    withMembers(["aaa0001"]);
    mockLoadUnitGrantProjects.mockResolvedValue([{}, {}, {}]);

    expect(await getCenterGrantCount("CTR1")).toBe(3);
    expect(mockBuildUnitGrantCards).not.toHaveBeenCalled();
    const countWhere = mockLoadUnitGrantProjects.mock.calls[0][0];

    const list = await getCenterGrantsList("CTR1", {});
    expect(list.total).toBe(3);
    const listWhere = mockLoadUnitGrantProjects.mock.calls[1][0];
    expect({ ...countWhere, endDate: null }).toEqual({ ...listWhere, endDate: null });
    expect(countWhere).toMatchObject({
      cwid: { in: ["aaa0001"] },
      source: { not: "RePORTER" },
    });
    expect(cacheKeys).toContain("center:grantcount:CTR1");
  });

  it("a center with no active members → 0 without a grant query", async () => {
    expect(await getCenterGrantCount("CTR1")).toBe(0);
    expect(mockLoadUnitGrantProjects).not.toHaveBeenCalled();
  });
});
