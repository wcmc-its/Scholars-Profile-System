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
 * #2066 / #2075 — division grant CARDS (one per funding project) and `isMultiPi`.
 *
 * Asserts through `getDivisionGrantsList`, not against `multiPiExternalIds` or
 * `groupUnitGrantsByProject` directly, on purpose. Both helpers were correct and
 * unit-tested; the defect was that this surface never called them — it read
 * `piCwids.length >= 2` off a grouping keyed on `externalId`
 * (`INFOED-{account}-{cwid}`), which embeds the cwid, so every group was a
 * singleton, the flag was structurally always false, and a multi-PI award drew
 * one card PER INVESTIGATOR. A test of the helpers alone would have stayed green
 * through the entire bug.
 *
 * #2075 then widened the row pool from "this division's rows" to the
 * corpus-wide sibling query, so a PD/PI outside the division counts. The mock
 * INTERPRETS that query's OR arms rather than returning a fixed set.
 *
 * This block also independently covers the division WIRING of every #2066
 * behaviour the dept twin (`dept-grants-multi-pi.test.ts`) covers. That is not
 * redundancy: `divisions.ts` was a near-verbatim COPY of `dept-lists.ts` and the
 * two had already drifted — the dept tab returned a group count while this one
 * returned a ROW count — so a shared assertion set is what keeps the copy honest.
 */
describe("getDivisionGrantsList — project grouping + isMultiPi (#2066, #2075)", () => {
  const D = {
    title: "Project",
    funder: "NCI",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2029-12-31"),
    applId: null as number | null,
  };

  type CRow = {
    cwid: string;
    role: string;
    externalId: string | null;
    awardNumber: string | null;
    title: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    applId: number | null;
    /** `inDivision: false` rows are NOT division members, so they never reach the
     *  page's own pull — only the sibling query can find them. */
    inDivision: boolean;
  };

  const CORPUS: CRow[] = [
    // Same-division multi-PI. InfoEd flags only the contact PI, so the second
    // PD/PI arrives as `Co-PI` (an NIH multiple-PI). ONE card under #2066.
    { ...D, cwid: "mpi00001", role: "PI",    externalId: "INFOED-A100-mpi00001", awardNumber: "1R01CA245678-01", inDivision: true },
    { ...D, cwid: "mpi00002", role: "Co-PI", externalId: "INFOED-A100-mpi00002", awardNumber: "1R01CA245678-01", inDivision: true },
    // Single-PI negative control.
    { ...D, cwid: "solo0001", role: "PI",    externalId: "INFOED-A200-solo0001", awardNumber: "1R01CA999999-01", inDivision: true },
    // An award whose ONLY in-division investigator is a CO-I — the #2074 shape.
    { ...D, cwid: "conly002", role: "Co-I",  externalId: "INFOED-A950-conly002", awardNumber: "1R01CA444444-01", inDivision: true },
    // CROSS-DIVISION multi-PI — the #2075 case: `xdiv0002` is outside CARDIO.
    { ...D, cwid: "xdiv0001", role: "PI",    externalId: "INFOED-A800-xdiv0001", awardNumber: "1R01CA888888-01", inDivision: true },
    { ...D, cwid: "xdiv0002", role: "Co-PI", externalId: "INFOED-A800-xdiv0002", awardNumber: "1R01CA888888-01", inDivision: false },
    // RENEWAL — one scholar, two Account_Numbers, one core project ⇒ ONE card.
    { ...D, cwid: "drenw001", role: "PI",    externalId: "INFOED-A600-drenw001", awardNumber: "1R01CA333333-01", inDivision: true },
    { ...D, cwid: "drenw001", role: "PI",    externalId: "INFOED-A700-drenw001", awardNumber: "5R01CA333333-02", inDivision: true },
    // SUPPLEMENT where one scholar holds TWO roles on one project. The chip must
    // report the SENIOR one; first-wins would say Co-I.
    { ...D, cwid: "dual0002", role: "Co-I",  externalId: "INFOED-B100-dual0002", awardNumber: "1R01CA222222-01", inDivision: true },
    { ...D, cwid: "dual0002", role: "PI",    externalId: "INFOED-B200-dual0002", awardNumber: "5R01CA222222-02", inDivision: true,
      startDate: new Date("2023-01-01") },
    // A row with NO derivable project key — `groupGrantsByProject` drops it, the
    // singleton fallback must keep it.
    { ...D, cwid: "nulldiv1", role: "PI",    externalId: null, awardNumber: null, title: "Null-id division award", inDivision: true },
    // PADDING past GRANT_PAGE_SIZE so `pageSlice` and the full group list are
    // genuinely different lists — a 9-row fixture below the page size makes the
    // sibling-query scoping assertion vacuous.
    ...Array.from({ length: 18 }, (_, i) => ({
      ...D,
      startDate: new Date("2020-01-01"),
      cwid: `dpad${String(i).padStart(4, "0")}`,
      role: "PI",
      externalId: `INFOED-DPD${String(i).padStart(2, "0")}-dpad${String(i).padStart(4, "0")}`,
      awardNumber: `1R01CA20${String(i).padStart(4, "0")}-01`,
      inDivision: true,
    })),
  ];

  /**
   * Accounts whose cards do NOT fit on page 0. 25 in-division project groups:
   * 7 recent (A100 — now ONE card for two rows —, A200, A950, A800, the
   * A600/A700 renewal, the B100/B200 supplement, and the unkeyable singleton)
   * + 18 padding. GRANT_PAGE_SIZE 20 takes the 7 recent plus DPD00–DPD12.
   */
  const OFF_PAGE_ACCOUNTS = ["DPD13", "DPD14", "DPD15", "DPD16", "DPD17"];

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
                  ? (r.externalId ?? "").startsWith(arm.externalId.startsWith)
                  : arm.awardNumber?.contains
                    ? (r.awardNumber ?? "").includes(arm.awardNumber.contains)
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
      // #2066 collapsed the former `{ externalId, id }` count projection into the
      // one UNIT_GRANT_SELECT pull, so this is the division's own row pool.
      return Promise.resolve(members(corpus));
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

  it("renders ONE card for a two-PD/PI project and flags it (#2066)", async () => {
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    const a100 = hits.filter((h) => (h.externalId ?? "").startsWith("INFOED-A100-"));
    // Before #2066 this was TWO cards, one per investigator.
    expect(a100).toHaveLength(1);
    expect(a100[0].externalId).toBe("INFOED-A100-mpi00001");
    // The contact PI reads MPI too — that was the #2065 inversion.
    expect(a100[0].isMultiPi).toBe(true);
    expect(a100[0].pis.map((p) => p.cwid).sort()).toEqual(["mpi00001", "mpi00002"]);
    expect((await flags())["INFOED-A200-solo0001"]).toBe(false);
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

  it("carries each investigator's own grantRole onto the chip (#2074)", async () => {
    // The twin of the dept assertion. Without it, nulling `grantRole` in
    // divisions.ts stays green while the tooltip silently degrades to a bare
    // "Investigator" on every division card — the drift this file exists to catch.
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    const byId = new Map(hits.map((h) => [h.externalId, h]));
    const a100 = byId.get("INFOED-A100-mpi00001")!;
    expect(a100.pis.find((p) => p.cwid === "mpi00001")?.grantRole).toBe("PI");
    expect(a100.pis.find((p) => p.cwid === "mpi00002")?.grantRole).toBe("Co-PI");
    // No PI row in this division ⇒ the fallback chip must report Co-I, so the
    // tooltip cannot call them the principal investigator.
    expect(byId.get("INFOED-A950-conly002")?.pis[0]?.grantRole).toBe("Co-I");
  });

  it("resolves a cwid holding TWO roles on one project to the SENIOR role (#2066)", async () => {
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    const dual = hits.filter((h) => h.pis.some((p) => p.cwid === "dual0002"));
    expect(dual).toHaveLength(1);
    expect(dual[0].pis[0].grantRole).toBe("PI");
    // Union date range across the group, not the representative's own.
    expect(dual[0].startDate).toEqual(new Date("2023-01-01"));
    expect(dual[0].endDate).toEqual(new Date("2029-12-31"));
  });

  it("collapses a renewal to ONE card and does not flag it", async () => {
    // `coreProjectNum` collapses these into ONE project. Counting distinct
    // cwids (not rows) is what keeps that from reading as multi-PI.
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    const renewal = hits.filter((h) => h.pis.some((p) => p.cwid === "drenw001"));
    expect(renewal).toHaveLength(1);
    expect(renewal[0].externalId).toBe("INFOED-A600-drenw001");
    expect(renewal[0].isMultiPi).toBe(false);
  });

  it("keeps a card for a row with a null externalId (#2066)", async () => {
    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    const nullId = hits.filter((h) => h.title === "Null-id division award");
    expect(nullId).toHaveLength(1);
    expect(nullId[0].externalId).toBeNull();
    expect(nullId[0].pis[0].cwid).toBe("nulldiv1");
  });

  it("reports the project-group count as `total`, not the row count", async () => {
    // The old division loader returned `unsuppressedKeyCount` — a ROW count —
    // while the dept twin returned a group count. They agreed only because the
    // externalId key made the two equal. Here 28 member ROWS fold to 25 project
    // groups, so a row count would report 28 and the assertion separates them.
    const { hits, total } = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(members(CORPUS)).toHaveLength(28);
    expect(total).toBe(25);
    expect(hits).toHaveLength(20);
  });

  it("scopes the sibling query to the RENDERED page, not the whole member pool", async () => {
    await flags();
    const sib = mockGrantFindMany.mock.calls.map((c) => c[0]).find((a) => a?.where?.AND);
    expect(sib, "no sibling candidate query was issued").toBeDefined();
    const arms: Array<Record<string, { startsWith?: string }>> = sib.where.AND.find(
      (c: unknown) => c && typeof c === "object" && "OR" in c,
    ).OR;
    const prefixes = arms.map((a) => a.externalId?.startsWith).filter(Boolean).join(" ");
    for (const acct of OFF_PAGE_ACCOUNTS) {
      expect(prefixes, `off-page account ${acct} leaked into the sibling query`).not.toContain(acct);
    }
    // Two arms per RENDERED card at most — the group's representative supplies one
    // account prefix and one NIH serial, however many Account_Numbers it spans.
    expect(arms.length).toBeLessThanOrEqual(2 * 20);
  });

  it("orders the tab by END DATE when the sort says so, not by start date", async () => {
    // The division twin of the dept assertion. `divisions.ts` is a near-verbatim
    // copy of `dept-lists.ts`, so the `sort` argument can be dropped on the way
    // to `loadUnitGrantProjects` on exactly one of them; the sort KEY itself is
    // covered in `unit-grant-projects.test.ts`, which calls the grouping
    // directly and cannot see this wiring. Most-recent-start order and end-date
    // order are EXACT REVERSES here, so a `"most_recent"` result cannot
    // accidentally satisfy the end_date assertion.
    const BY_END: CRow[] = [
      { ...D, cwid: "dsrt0001", role: "PI", externalId: "INFOED-S100-dsrt0001", awardNumber: "1R01CA010001-01",
        inDivision: true, startDate: new Date("2026-01-01"), endDate: new Date("2027-01-01") },
      { ...D, cwid: "dsrt0002", role: "PI", externalId: "INFOED-S200-dsrt0002", awardNumber: "1R01CA010002-01",
        inDivision: true, startDate: new Date("2025-01-01"), endDate: new Date("2028-01-01") },
      { ...D, cwid: "dsrt0003", role: "PI", externalId: "INFOED-S300-dsrt0003", awardNumber: "1R01CA010003-01",
        inDivision: true, startDate: new Date("2024-01-01"), endDate: new Date("2030-01-01") },
    ];
    mockDivisionMembershipFindMany.mockResolvedValue(
      members(BY_END).map((r) => ({ cwid: r.cwid })),
    );
    mockScholarFindMany.mockImplementation(
      routeScholarFindMany(new Set(BY_END.map((r) => r.cwid))),
    );
    mockGrantFindMany.mockImplementation(serveGrants(BY_END));

    const recent = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(recent.hits.map((h) => h.externalId)).toEqual([
      "INFOED-S100-dsrt0001",
      "INFOED-S200-dsrt0002",
      "INFOED-S300-dsrt0003",
    ]);

    const byEnd = await getDivisionGrantsList("CARDIO", { page: 0, sort: "end_date" });
    expect(byEnd.hits.map((h) => h.externalId)).toEqual([
      "INFOED-S300-dsrt0003",
      "INFOED-S200-dsrt0002",
      "INFOED-S100-dsrt0001",
    ]);
  });

  it("does not flag a PD/PI plus a Co-Investigator", async () => {
    const withCoI: CRow[] = [CORPUS[0], { ...CORPUS[1], role: "Co-I" }];
    mockDivisionMembershipFindMany.mockResolvedValue(
      members(withCoI).map((r) => ({ cwid: r.cwid })),
    );
    mockGrantFindMany.mockImplementation(serveGrants(withCoI));

    const { hits } = await getDivisionGrantsList("CARDIO", { page: 0 });
    // Named per externalId rather than `.every(...)`, which any single unflagged
    // card would satisfy regardless of the other.
    expect(Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi]))).toEqual({
      "INFOED-A100-mpi00001": false,
    });
  });
});
