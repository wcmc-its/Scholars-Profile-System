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
 * #2066 / #2075 — `isMultiPi` on a division grant card.
 *
 * Asserts through `getDivisionGrantsList`, not against `multiPiExternalIds`
 * directly, on purpose. The helper was already correct and unit-tested before
 * #2066; the defect was that this surface never called it — it read
 * `piCwids.length >= 2` off a grouping keyed on `externalId`
 * (`INFOED-{account}-{cwid}`), which embeds the cwid, so every group was a
 * singleton and the flag was structurally always false. A test of the helper
 * alone would have stayed green through the entire bug.
 *
 * #2075 then widened the row pool from "this division's rows" to the
 * corpus-wide sibling query, so a PD/PI outside the division counts. The mock
 * INTERPRETS that query's OR arms rather than returning a fixed set.
 *
 * The dept twin (`dept-grants-multi-pi.test.ts`) carries the fuller matrix;
 * this block covers the division WIRING, which is a separate code path.
 */
describe("getDivisionGrantsList — isMultiPi (#2066, #2075)", () => {
  const D = {
    title: "Project",
    funder: "NCI",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2029-12-31"),
  };

  /** `inDivision: false` rows are NOT division members, so they never reach the
   *  page's own pull — only the sibling query can find them. */
  const CORPUS = [
    // Same-division multi-PI. InfoEd flags only the contact PI, so the second
    // PD/PI arrives as `Co-PI` (an NIH multiple-PI).
    { ...D, cwid: "mpi00001", role: "PI",    externalId: "INFOED-A100-mpi00001", awardNumber: "1R01CA245678-01", inDivision: true },
    { ...D, cwid: "mpi00002", role: "Co-PI", externalId: "INFOED-A100-mpi00002", awardNumber: "1R01CA245678-01", inDivision: true },
    // Single-PI negative control.
    { ...D, cwid: "solo0001", role: "PI",    externalId: "INFOED-A200-solo0001", awardNumber: "1R01CA999999-01", inDivision: true },
    // CROSS-DIVISION multi-PI — the #2075 case: `xdiv0002` is outside CARDIO.
    { ...D, cwid: "xdiv0001", role: "PI",    externalId: "INFOED-A800-xdiv0001", awardNumber: "1R01CA888888-01", inDivision: true },
    { ...D, cwid: "xdiv0002", role: "Co-PI", externalId: "INFOED-A800-xdiv0002", awardNumber: "1R01CA888888-01", inDivision: false },
  ];

  type CRow = (typeof CORPUS)[number];
  const members = (c: CRow[]) => c.filter((r) => r.inDivision);

  function serveGrants(corpus: CRow[] = CORPUS) {
    return (args?: { select?: Record<string, true>; where?: { AND?: unknown[] } }) => {
      if (args?.where?.AND) {
        // Sibling candidate query — interpret the OR arms as MySQL would.
        const or =
          (
            args.where.AND.find((c) => c && typeof c === "object" && "OR" in c) as
              | { OR: Array<Record<string, { startsWith?: string; contains?: string }>> }
              | undefined
          )?.OR ?? [];
        return Promise.resolve(
          corpus
            .filter((r) =>
              or.some((arm) =>
                arm.externalId?.startsWith
                  ? r.externalId.startsWith(arm.externalId.startsWith)
                  : arm.awardNumber?.contains
                    ? r.awardNumber.includes(arm.awardNumber.contains)
                    : false,
              ),
            )
            .map((r) => ({
              cwid: r.cwid,
              role: r.role,
              externalId: r.externalId,
              awardNumber: r.awardNumber,
            })),
        );
      }
      if (args?.select?.title) return Promise.resolve(members(corpus));
      return Promise.resolve(
        members(corpus).map((r) => ({ externalId: r.externalId, id: r.externalId })),
      );
    };
  }

  const flags = async () => {
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    return Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi]));
  };

  /** Active whole-grant suppressions, set per test. */
  let suppressedIds: string[] = [];

  beforeEach(() => {
    suppressedIds = [];
    mockDivisionFindFirst.mockResolvedValue({ ...DIV_BASE, source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue(
      members(CORPUS).map((r) => ({ cwid: r.cwid })),
    );
    mockScholarFindMany.mockImplementation(
      routeScholarFindMany(new Set(CORPUS.map((r) => r.cwid))),
    );
    mockGrantFindMany.mockImplementation(serveGrants());
    // INTERPRETS `entityId: { in: [...] }`. Required to tell the division-scoped
    // suppression set apart from the sibling-scoped one — see the twin note in
    // dept-grants-multi-pi.test.ts.
    mockSuppressionFindMany.mockImplementation(
      (args?: { where?: { entityId?: { in?: string[] } } }) => {
        const asked = new Set(args?.where?.entityId?.in ?? []);
        return Promise.resolve(
          suppressedIds.filter((id) => asked.has(id)).map((entityId) => ({ entityId })),
        );
      },
    );
  });

  it("flags BOTH rows of a two-PD/PI project, and not the single-PI project", async () => {
    const f = await flags();
    // The contact PI reads MPI too — that was the #2065 inversion.
    expect(f["INFOED-A100-mpi00001"]).toBe(true);
    expect(f["INFOED-A100-mpi00002"]).toBe(true);
    expect(f["INFOED-A200-solo0001"]).toBe(false);
  });

  it("flags an award whose second PD/PI is OUTSIDE the division (#2075)", async () => {
    expect((await flags())["INFOED-A800-xdiv0001"]).toBe(true);
  });

  it("does not flag when the outside PD/PI's own row is suppressed (#160)", async () => {
    // The division-scoped `suppressed` set cannot contain a non-member's row, so
    // the derivation needs its own sibling-scoped suppression load.
    suppressedIds = ["INFOED-A800-xdiv0002"];
    expect((await flags())["INFOED-A800-xdiv0001"]).toBe(false);
  });

  it("does not flag a renewal — one scholar on two Account_Numbers under one core project", async () => {
    // `coreProjectNum` collapses these into ONE project. Counting distinct
    // cwids (not rows) is what keeps that from reading as multi-PI.
    const renewal: CRow[] = [
      CORPUS[0],
      { ...CORPUS[0], externalId: "INFOED-A300-mpi00001", awardNumber: "5R01CA245678-02" },
    ];
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "mpi00001" }]);
    mockGrantFindMany.mockImplementation(serveGrants(renewal));

    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(hits.map((h) => h.isMultiPi)).toEqual([false, false]);
  });

  it("does not flag a PD/PI plus a Co-Investigator", async () => {
    const withCoI: CRow[] = [CORPUS[0], { ...CORPUS[1], role: "Co-I" }];
    mockGrantFindMany.mockImplementation(serveGrants(withCoI));

    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    // Named per externalId rather than `.every(...)`, which any single unflagged
    // card would satisfy regardless of the other.
    expect(Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi]))).toEqual({
      "INFOED-A100-mpi00001": false,
      "INFOED-A100-mpi00002": false,
    });
  });
});
