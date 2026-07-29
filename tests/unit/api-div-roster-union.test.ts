/**
 * #540 Phase 8 — `lib/api/divisions.ts` roster-union behavior on the
 * faculty / publications / grants surfaces. `getDivision` (stats) and
 * `getDivisionTopResearchAreas` were exercised in Phase 3b's existing
 * `api-div-unit-curation.test.ts`; this file covers the four remaining reads
 * that all now go through `loadDivisionMemberCwids`.
 *
 *  - getDivisionFaculty: manual-rostered CWID surfaces on a `source='manual'`
 *    division; `total` reflects the unioned set.
 *  - getDivisionFaculty: ED-source division never consults `DivisionMembership`.
 *  - getDivisionFaculty: a manual-roster CWID with no active Scholar row drops
 *    off (edge 19).
 *  - getDivisionFaculty: chief lookup is skipped when the chief is not in the
 *    member set (cross-tab consistency).
 *  - getDivisionPublicationsList / getDivisionGrantsList: short-circuit on
 *    empty unioned member set; otherwise key downstream queries on `cwid IN`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDivisionFindFirst,
  mockDivisionMembershipFindMany,
  mockScholarFindMany,
  mockScholarFindFirst,
  mockScholarGroupBy,
  mockPublicationAuthorFindMany,
  mockPublicationAuthorGroupBy,
  mockGrantFindMany,
  mockGrantGroupBy,
  mockPublicationFindMany,
  mockSuppressionFindMany,
} = vi.hoisted(() => ({
  mockDivisionFindFirst: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockScholarGroupBy: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockPublicationAuthorGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    division: { findFirst: mockDivisionFindFirst },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
    scholar: {
      findMany: mockScholarFindMany,
      findFirst: mockScholarFindFirst,
      groupBy: mockScholarGroupBy,
    },
    publicationAuthor: {
      findMany: mockPublicationAuthorFindMany,
      groupBy: mockPublicationAuthorGroupBy,
    },
    grant: {
      findMany: mockGrantFindMany,
      groupBy: mockGrantGroupBy,
    },
    publication: { findMany: mockPublicationFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

import {
  getDivisionFaculty,
  getDivisionPublicationsList,
  getDivisionGrantsList,
} from "@/lib/api/divisions";

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible empty defaults; tests override as needed.
  mockScholarGroupBy.mockResolvedValue([]);
  mockScholarFindFirst.mockResolvedValue(null);
  mockPublicationAuthorFindMany.mockResolvedValue([]);
  mockPublicationAuthorGroupBy.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
  mockPublicationFindMany.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
});

function routeScholarFindMany(activeCwids: ReadonlySet<string>) {
  // Routes by where shape:
  //   { divCode }            → LDAP attach lookup (returns scholars whose
  //                            LDAP divCode matches).
  //   { cwid: { in } }       → active gate / faculty row fetch.
  return (args?: {
    where?: {
      divCode?: string;
      cwid?: { in?: string[] };
    };
    select?: Record<string, true>;
    include?: Record<string, unknown>;
  }) => {
    if (args?.where?.divCode) {
      // LDAP attach side. By default no LDAP scholars; per-test override
      // by calling `mockScholarFindMany.mockImplementationOnce` first.
      return Promise.resolve([]);
    }
    if (args?.where?.cwid?.in) {
      const ins = args.where.cwid.in;
      // If the call expects `include` (faculty row hydration), return
      // hydrated shapes; otherwise (the helper's active-gate select-cwid
      // call) return only the cwid column.
      if (args.include) {
        return Promise.resolve(
          ins
            .filter((c) => activeCwids.has(c))
            .map((cwid) => ({
              cwid,
              preferredName: cwid.toUpperCase(),
              slug: cwid,
              primaryTitle: null,
              roleCategory: "faculty",
              overview: null,
              department: { name: "Department of Medicine" },
              division: { name: "Cardiology" },
            })),
        );
      }
      return Promise.resolve(
        ins.filter((c) => activeCwids.has(c)).map((cwid) => ({ cwid })),
      );
    }
    return Promise.resolve([]);
  };
}

const DIV_BASE = {
  code: "CARDIO",
  deptCode: "MED",
  chiefCwid: null as string | null,
  source: "ED",
};

describe("getDivisionFaculty — Phase 8 roster union (#540)", () => {
  it("surfaces a manually-rostered scholar on a source='manual' division", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "manual001" }]);
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set(["manual001"])));

    const result = await getDivisionFaculty("CARDIO", { page: 0 });
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["manual001"]);
  });

  it("LDAP + manual roster dedup by CWID on the adopted division (edge 15)", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue([
      { cwid: "shared001" },
      { cwid: "manual001" },
    ]);
    // LDAP-side returns 2 scholars including the overlapping `shared001`.
    mockScholarFindMany.mockImplementation((args?: {
      where?: { divCode?: string; cwid?: { in?: string[] } };
      include?: Record<string, unknown>;
    }) => {
      if (args?.where?.divCode) {
        return Promise.resolve([{ cwid: "ldap001" }, { cwid: "shared001" }]);
      }
      const route = routeScholarFindMany(
        new Set(["ldap001", "shared001", "manual001"]),
      );
      return route(args);
    });

    const result = await getDivisionFaculty("CARDIO", { page: 0 });
    expect(result.total).toBe(3);
    const cwids = result.hits.map((h) => h.cwid).sort();
    expect(cwids).toEqual(["ldap001", "manual001", "shared001"]);
  });

  it("ED-source division never consults DivisionMembership", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "ED" });
    mockScholarFindMany.mockImplementation((args?: {
      where?: { divCode?: string; cwid?: { in?: string[] } };
      include?: Record<string, unknown>;
    }) => {
      if (args?.where?.divCode) return Promise.resolve([{ cwid: "ldap001" }]);
      return routeScholarFindMany(new Set(["ldap001"]))(args);
    });

    await getDivisionFaculty("CARDIO", { page: 0 });
    expect(mockDivisionMembershipFindMany).not.toHaveBeenCalled();
  });

  it("drops a rostered CWID with no active Scholar row (edge 19)", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue([
      { cwid: "incomingHire" },
      { cwid: "active001" },
    ]);
    // Only `active001` has an active Scholar row.
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set(["active001"])));

    const result = await getDivisionFaculty("CARDIO", { page: 0 });
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["active001"]);
  });

  it("skips the chief lookup when the chief is not in the member set", async () => {
    // Cross-tab consistency: the chief column may name an ex-divisional
    // scholar; the faculty list, keyed on the unioned member set, must not
    // hoist them to the top of a page they no longer belong on.
    mockDivisionFindFirst.mockResolvedValue({
      ...DIV_BASE,
      source: "manual",
      chiefCwid: "exMember",
    });
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "current001" }]);
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set(["current001"])));

    const result = await getDivisionFaculty("CARDIO", { page: 0 });
    expect(result.hits.map((h) => h.cwid)).toEqual(["current001"]);
    expect(mockScholarFindFirst).not.toHaveBeenCalled();
  });

  it("short-circuits to an empty page when both LDAP and roster are empty", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set()));

    const result = await getDivisionFaculty("CARDIO", { page: 0 });
    expect(result).toEqual({
      hits: [],
      total: 0,
      roleCategoryCounts: {},
      page: 0,
      pageSize: 20,
    });
    expect(mockScholarGroupBy).not.toHaveBeenCalled();
  });
});

describe("getDivisionPublicationsList — Phase 8 roster union (#540)", () => {
  it("keys publicationAuthor lookup on the unioned member set", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "manual001" }]);
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set(["manual001"])));
    mockPublicationAuthorFindMany.mockResolvedValueOnce([{ pmid: "PUB1" }]);

    await getDivisionPublicationsList("CARDIO", { page: 0 });
    expect(mockPublicationAuthorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isConfirmed: true,
          cwid: { in: ["manual001"] },
        }),
      }),
    );
  });

  it("short-circuits to an empty result on an empty member set", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set()));

    const result = await getDivisionPublicationsList("CARDIO", { page: 0 });
    expect(result).toEqual({ hits: [], total: 0, page: 0, pageSize: 20 });
    expect(mockPublicationAuthorFindMany).not.toHaveBeenCalled();
  });
});

describe("getDivisionGrantsList — Phase 8 roster union (#540)", () => {
  it("keys grant lookup on the unioned member set", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "manual001" }]);
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set(["manual001"])));

    await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(mockGrantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cwid: { in: ["manual001"] },
        }),
      }),
    );
  });

  it("short-circuits to an empty result on an empty member set", async () => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockScholarFindMany.mockImplementation(routeScholarFindMany(new Set()));

    const result = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(result).toEqual({ hits: [], total: 0, page: 0, pageSize: 20 });
    expect(mockGrantFindMany).not.toHaveBeenCalled();
  });
});

/**
 * #2066 — `isMultiPi` on a division grant card.
 *
 * This asserts through `getDivisionGrantsList`, not against
 * `multiPiExternalIds` directly, on purpose. The helper was already correct and
 * unit-tested before #2066; the defect was that this surface never called it —
 * it read `piCwids.length >= 2` off a grouping keyed on `externalId`
 * (`INFOED-{account}-{cwid}`), which embeds the cwid, so every group was a
 * singleton and the flag was structurally always false. A test of the helper
 * alone would have stayed green through the entire bug.
 */
describe("getDivisionGrantsList — isMultiPi (#2066)", () => {
  /** Two PD/PIs on ONE project (same Account_Number, distinct cwids), plus a
   *  single-PI project as the negative control. */
  const GRANT_ROWS = [
    {
      cwid: "mpi00001",
      role: "PI", // InfoEd flags only the CONTACT PI
      externalId: "INFOED-A100-mpi00001",
      awardNumber: "1R01CA245678-01",
      title: "Multi-PI project",
      funder: "NCI",
      startDate: new Date("2024-01-01"),
      endDate: new Date("2029-12-31"),
    },
    {
      cwid: "mpi00002",
      role: "Co-PI", // InfoEd's NON-CONTACT PD/PI — an NIH multiple-PI
      externalId: "INFOED-A100-mpi00002",
      awardNumber: "1R01CA245678-01",
      title: "Multi-PI project",
      funder: "NCI",
      startDate: new Date("2024-01-01"),
      endDate: new Date("2029-12-31"),
    },
    {
      cwid: "solo0001",
      role: "PI",
      externalId: "INFOED-A200-solo0001",
      awardNumber: "1R01CA999999-01",
      title: "Single-PI project",
      funder: "NCI",
      startDate: new Date("2024-01-01"),
      endDate: new Date("2029-12-31"),
    },
  ];

  beforeEach(() => {
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue(
      GRANT_ROWS.map((r) => ({ cwid: r.cwid })),
    );
    mockScholarFindMany.mockImplementation(
      routeScholarFindMany(new Set(GRANT_ROWS.map((r) => r.cwid))),
    );
    // Two grant reads: the suppression/count projection, then the full pull.
    mockGrantFindMany.mockImplementation((args?: { select?: Record<string, true> }) =>
      Promise.resolve(
        args?.select?.title
          ? GRANT_ROWS
          : GRANT_ROWS.map((r) => ({ externalId: r.externalId, id: r.externalId })),
      ),
    );
  });

  it("flags BOTH rows of a two-PD/PI project, and not the single-PI project", async () => {
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(
      Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi])),
    ).toEqual({
      // The contact PI reads MPI too — that was the #2065 inversion.
      "INFOED-A100-mpi00001": true,
      "INFOED-A100-mpi00002": true,
      "INFOED-A200-solo0001": false,
    });
  });

  it("does not flag a renewal — one scholar on two Account_Numbers under one core project", async () => {
    // `coreProjectNum` collapses these into ONE project. Counting distinct
    // cwids (not rows) is what keeps that from reading as multi-PI.
    const renewal = [
      { ...GRANT_ROWS[0], externalId: "INFOED-A300-mpi00001", awardNumber: "5R01CA245678-02" },
      GRANT_ROWS[0],
    ];
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "mpi00001" }]);
    mockGrantFindMany.mockImplementation((args?: { select?: Record<string, true> }) =>
      Promise.resolve(
        args?.select?.title
          ? renewal
          : renewal.map((r) => ({ externalId: r.externalId, id: r.externalId })),
      ),
    );

    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(hits.map((h) => h.isMultiPi)).toEqual([false, false]);
  });

  it("does not flag a PD/PI plus a Co-Investigator", async () => {
    const withCoI = [GRANT_ROWS[0], { ...GRANT_ROWS[1], role: "Co-I" }];
    mockGrantFindMany.mockImplementation((args?: { select?: Record<string, true> }) =>
      Promise.resolve(
        args?.select?.title
          ? withCoI
          : withCoI.map((r) => ({ externalId: r.externalId, id: r.externalId })),
      ),
    );

    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(hits.every((h) => h.isMultiPi)).toBe(false);
  });
});
