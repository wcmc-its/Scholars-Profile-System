/**
 * #974 Phase 2 — `getUnitMembersByMethods` (lib/api/unit-members.ts).
 *
 * The filtered-roster loader behind the uncacheable /api/units route. Asserts:
 *  - department path resolves full active cwids via scholar.findMany(deptCode);
 *  - the selected sc::label keys become an OR set of (supercategory, familyLabel)
 *    pairs (OR within facet) — a TAMPERED key for a suppressed/sensitive family is
 *    dropped BEFORE the scholarFamily.findMany (never selects a non-public family);
 *  - the filtered cwid set is paginated (page 0 vs 1);
 *  - returned hits carry public-gated `topMethods` chips.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFindMany,
  mockFamilyFindMany,
  mockPubGroupBy,
  mockGrantGroupBy,
  mockAuthorGroupBy,
  mockSuppressionFindMany,
  mockLoadOverlayGate,
  mockLoadDivisionMemberCwids,
  mockLoadTopMesh,
  mockResolveDivisionChief,
} = vi.hoisted(() => ({
  mockResolveDivisionChief: vi.fn(),
  mockLoadTopMesh: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockFamilyFindMany: vi.fn(),
  mockPubGroupBy: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockAuthorGroupBy: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockLoadOverlayGate: vi.fn(),
  mockLoadDivisionMemberCwids: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: mockScholarFindMany },
    scholarFamily: { findMany: mockFamilyFindMany },
    publicationTopic: { groupBy: mockPubGroupBy },
    // Division rosters count confirmed authorships minus #356 hides.
    publicationAuthor: { groupBy: mockAuthorGroupBy },
    suppression: { findMany: mockSuppressionFindMany },
    grant: { groupBy: mockGrantGroupBy },
  },
}));
vi.mock("@/lib/api/methods-overlay", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/methods-overlay")>(
    "@/lib/api/methods-overlay",
  );
  return { ...actual, loadFamilyOverlayGate: () => mockLoadOverlayGate() };
});
vi.mock("@/lib/api/divisions", () => ({
  loadDivisionMemberCwids: (...a: unknown[]) => mockLoadDivisionMemberCwids(...a),
  resolveDivisionChiefCwid: (...a: unknown[]) => mockResolveDivisionChief(...a),
}));
// Unit Page v2 TOPICS chips — the people-index lookup is mocked (no OpenSearch);
// `withTopMesh` stays real so the attach logic is exercised.
vi.mock("@/lib/api/roster-mesh", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/roster-mesh")>(
    "@/lib/api/roster-mesh",
  );
  return { ...actual, loadTopMeshForMembers: (...a: unknown[]) => mockLoadTopMesh(...a) };
});
// loadPublicFamiliesForMembers (chips) is exercised via the real methods-roster
// module against the mocked scholarFamily.findMany below.

import {
  buildHits,
  getUnitMembersByMethods,
  getUnitMembersFiltered,
} from "@/lib/api/unit-members";

const SC = "imaging_x";

function scholarRow(
  cwid: string,
  over: { preferredName?: string; roleCategory?: string; primaryTitle?: string } = {},
) {
  return {
    cwid,
    preferredName: over.preferredName ?? cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: over.primaryTitle ?? "Professor",
    roleCategory: over.roleCategory ?? "full_time_faculty",
    overview: null,
    primaryDepartment: "Radiology",
    department: { name: "Department of Radiology" },
    division: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
  mockPubGroupBy.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
  mockAuthorGroupBy.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockLoadTopMesh.mockResolvedValue(new Map());
  mockResolveDivisionChief.mockResolvedValue(null);
});

/** Route `scholar.findMany`: the index member select (no `include`) returns
 *  `rows`; the page hydration (`include`) returns the requested cwids' rows. */
function routeScholars(rows: ReturnType<typeof scholarRow>[]) {
  const byCwid = new Map(rows.map((r) => [r.cwid, r]));
  mockScholarFindMany.mockImplementation(
    (args: { include?: unknown; where: { cwid?: { in: string[] } } }) =>
      Promise.resolve(
        "include" in args
          ? args.where.cwid!.in.flatMap((c) => (byCwid.has(c) ? [byCwid.get(c)!] : []))
          : rows,
      ),
  );
}

describe("getUnitMembersByMethods — department", () => {
  it("OR-filters members across selected families, paginates, returns chips", async () => {
    // scholar.findMany is called twice: (step 1) member-cwid select (no `include`),
    // and (step 4) the page row assembly (`include` present). Route by `include`.
    mockScholarFindMany.mockImplementation((args: { include?: unknown }) =>
      "include" in args
        ? Promise.resolve(
            (args as { where: { cwid: { in: string[] } } }).where.cwid.in.map((c) => scholarRow(c)),
          )
        : Promise.resolve([{ cwid: "m1" }, { cwid: "m2" }, { cwid: "m3" }, { cwid: "m4" }]),
    );
    // scholarFamily.findMany is called twice: the OR-filter (distinct cwid) → matched
    // members; the chip load (no distinct) → family rows for the page.
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) => {
      if (args.distinct?.includes("cwid")) {
        return Promise.resolve([{ cwid: "m1" }, { cwid: "m2" }, { cwid: "m3" }]);
      }
      return Promise.resolve([
        {
          cwid: "m1",
          supercategory: SC,
          familyLabel: "Deep learning",
          pmidCount: 9,
          exemplarTools: ["PyTorch"],
        },
      ]);
    });

    const result = await getUnitMembersByMethods(
      "department",
      "N1140",
      [`${SC}::Deep learning`, `${SC}::Segmentation`],
      0,
    );

    // Total = distinct matched members (3), not the page count.
    expect(result.total).toBe(3);
    // OR set forwarded to the filter findMany.
    const filterCall = mockFamilyFindMany.mock.calls.find(
      (c) => c[0]?.distinct?.includes("cwid"),
    )![0];
    expect(filterCall.where.OR).toEqual([
      { supercategory: SC, familyLabel: "Deep learning" },
      { supercategory: SC, familyLabel: "Segmentation" },
    ]);
    // The matched cwids drive the member-cwid `in` filter.
    expect(filterCall.where.cwid.in).toEqual(["m1", "m2", "m3", "m4"]);
    // Page chips: m1 carries the public Deep-learning chip.
    const m1 = result.hits.find((h) => h.cwid === "m1");
    expect(m1?.topMethods?.[0].familyLabel).toBe("Deep learning");
  });

  it("drops a tampered suppressed key BEFORE the filter query (never selects it)", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "m1" }, { cwid: "m2" }]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set([`${SC}::Secret`]),
      sensitive: new Set(),
    });
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve([{ cwid: "m1" }])
        : Promise.resolve([]),
    );

    const result = await getUnitMembersByMethods(
      "department",
      "N1140",
      [`${SC}::Deep learning`, `${SC}::Secret`],
      0,
    );

    const filterCall = mockFamilyFindMany.mock.calls.find(
      (c) => c[0]?.distinct?.includes("cwid"),
    )![0];
    // Only the public pair survives the gate; the suppressed key is never queried.
    expect(filterCall.where.OR).toEqual([
      { supercategory: SC, familyLabel: "Deep learning" },
    ]);
    expect(result.total).toBe(1);
  });

  it("returns empty (no family query) when EVERY selected key is non-public", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "m1" }]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set([`${SC}::Secret`]),
      sensitive: new Set(),
    });
    const result = await getUnitMembersByMethods("department", "N1140", [`${SC}::Secret`], 0);
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
    // No OR-filter query ran (publicPairs empty short-circuits).
    expect(mockFamilyFindMany).not.toHaveBeenCalled();
  });

  it("paginates the filtered set (page 1 takes the next slice)", async () => {
    mockScholarFindMany.mockImplementation((args: { include?: unknown }) =>
      "include" in args
        ? // chip-less page assembly: return the page's scholar rows
          Promise.resolve(
            (args as { where: { cwid: { in: string[] } } }).where.cwid.in.map((c) => scholarRow(c)),
          )
        : Promise.resolve(
            Array.from({ length: 25 }, (_, i) => ({ cwid: `m${String(i).padStart(2, "0")}` })),
          ),
    );
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve(
            Array.from({ length: 25 }, (_, i) => ({ cwid: `m${String(i).padStart(2, "0")}` })),
          )
        : Promise.resolve([]),
    );

    const page1 = await getUnitMembersByMethods("department", "N1140", [`${SC}::A`], 1);
    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    // 25 members, 20/page → page 1 has the remaining 5.
    expect(page1.hits).toHaveLength(5);
  });
});

describe("getUnitMembersByMethods — division", () => {
  it("resolves member cwids via loadDivisionMemberCwids", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue(["d1", "d2"]);
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve([{ cwid: "d1" }])
        : Promise.resolve([]),
    );
    mockScholarFindMany.mockResolvedValue([scholarRow("d1")]);

    const result = await getUnitMembersByMethods("division", "N2466", [`${SC}::A`], 0);
    expect(mockLoadDivisionMemberCwids).toHaveBeenCalledWith("N2466");
    expect(result.total).toBe(1);
    expect(result.hits[0].cwid).toBe("d1");
  });

  it("returns empty when the division has no members", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue([]);
    const result = await getUnitMembersByMethods("division", "N2466", [`${SC}::A`], 0);
    expect(result.total).toBe(0);
    expect(mockFamilyFindMany).not.toHaveBeenCalled();
  });
});

/**
 * #2537 — `getUnitMembersFiltered`: the type-only (no methods) and combined
 * (methods + type) paths added alongside the original methods-only path above.
 */
describe("getUnitMembersFiltered — type-only (department)", () => {
  it("filters the index by the raw role group in memory, re-applies it on the page rows", async () => {
    routeScholars([
      scholarRow("m1"),
      scholarRow("m2"),
      scholarRow("m3", { roleCategory: "postdoc" }),
    ]);

    const result = await getUnitMembersFiltered(
      "department",
      "N1140",
      { roleGroup: "Full-time faculty" },
      0,
    );

    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.cwid).sort()).toEqual(["m1", "m2"]);
    // The index member query carries the #536 carve (publicRoleWhere's OR).
    const indexCall = mockScholarFindMany.mock.calls.find((c) => !("include" in c[0]))![0];
    expect(indexCall.where.deptCode).toBe("N1140");
    expect(indexCall.where).toHaveProperty("OR");
    // buildHits' own row query re-applies the role group (#2537).
    const rowCall = mockScholarFindMany.mock.calls.find((c) => "include" in c[0])![0];
    expect(rowCall.where.roleCategory).toEqual({ in: expect.any(Array) });
    // No OR-across-families filter query ran — this is the type-only path.
    expect(
      mockFamilyFindMany.mock.calls.some((c) => (c[0] as { distinct?: string[] })?.distinct),
    ).toBe(false);
    // Appointment pill counts cover the whole (unfiltered-by-role) set.
    expect(result.roleCategoryCounts).toEqual({ "Full-time faculty": 2, Postdoc: 1 });
  });

  it("returns empty (no queries beyond the member-cwid select) when the group is All", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "m1" }]);
    const result = await getUnitMembersFiltered("department", "N1140", { roleGroup: "All" }, 0);
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });
});

describe("getUnitMembersFiltered — Division facet (department, Unit Page v2)", () => {
  it("intersects the dept's members with the selected divisions (OR within), no role filter", async () => {
    mockLoadDivisionMemberCwids.mockImplementation((code: string) =>
      Promise.resolve(code === "D1" ? ["m1", "x9"] : ["m3"]),
    );
    routeScholars([scholarRow("m1"), scholarRow("m2"), scholarRow("m3")]);

    const result = await getUnitMembersFiltered(
      "department",
      "N1140",
      { divisionCodes: ["D1", "D2"] },
      0,
    );

    // x9 is in D1 but not in the department → never widens the roster.
    expect(result.hits.map((h) => h.cwid).sort()).toEqual(["m1", "m3"]);
    expect(result.total).toBe(2);
    expect(mockLoadDivisionMemberCwids).toHaveBeenCalledWith("D1");
    expect(mockLoadDivisionMemberCwids).toHaveBeenCalledWith("D2");
    // Division-only: the page-row query carries no roleCategory condition.
    const rowCall = mockScholarFindMany.mock.calls.find((c) => "include" in c[0])![0];
    expect(rowCall.where).not.toHaveProperty("roleCategory");
  });

  it("is ignored on a division roster (the division's own ranked roster comes back)", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue(["m1"]);
    routeScholars([scholarRow("m1")]);
    const result = await getUnitMembersFiltered("division", "D1", { divisionCodes: ["D2"] }, 0);
    expect(result.total).toBe(1);
    expect(mockLoadDivisionMemberCwids).toHaveBeenCalledTimes(1);
    expect(mockLoadDivisionMemberCwids).toHaveBeenCalledWith("D1");
  });
});

describe("getUnitMembersFiltered — combined methods + type (department)", () => {
  it("nests roleCategory inside the scholar: relation filter, not top-level", async () => {
    routeScholars([scholarRow("m1"), scholarRow("m2")]);
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve([{ cwid: "m1" }])
        : Promise.resolve([]),
    );

    const result = await getUnitMembersFiltered(
      "department",
      "N1140",
      { methodKeys: [`${SC}::A`], roleGroup: "Full-time faculty" },
      0,
    );

    const filterCall = mockFamilyFindMany.mock.calls.find((c) => c[0]?.distinct?.includes("cwid"))![0];
    // The facet's own OR is intact at the top level...
    expect(filterCall.where.OR).toEqual([{ supercategory: SC, familyLabel: "A" }]);
    // ...and roleCategory nests INSIDE scholar:, alongside the carve, never at
    // the top level (which would clobber the facet OR).
    expect(filterCall.where.roleCategory).toBeUndefined();
    expect(filterCall.where.scholar.roleCategory).toEqual({ in: expect.any(Array) });
    expect(result.total).toBe(1);
    expect(result.hits[0].cwid).toBe("m1");

    // buildHits' own row query re-applies the same filter (rows agree with total).
    const rowCall = mockScholarFindMany.mock.calls.find((c) => "include" in c[0])![0];
    expect(rowCall.where.roleCategory).toEqual({ in: expect.any(Array) });
  });
});

/**
 * Unit Page v2 roster toolbar — sort + name/title query ranked over the WHOLE
 * filtered set (not re-sorted within each page).
 */
describe("getUnitMembersFiltered — sort + q (Unit Page v2)", () => {
  // 25 members whose cwid order, first-name order and surname order all differ.
  const rows = Array.from({ length: 25 }, (_, i) =>
    scholarRow(`c${String(24 - i).padStart(2, "0")}`, {
      preferredName: `${String.fromCharCode(90 - i)}first ${String.fromCharCode(65 + i)}last`,
    }),
  );

  it("a sort/q-free, facet-free request returns the surname-ranked roster; page 1 continues it", async () => {
    routeScholars([...rows].reverse());
    const p0 = await getUnitMembersFiltered("department", "N1140", {}, 0);
    const p1 = await getUnitMembersFiltered("department", "N1140", {}, 1);
    expect(p0.total).toBe(25);
    expect(p0.hits).toHaveLength(20);
    expect(p1.hits).toHaveLength(5);
    // Regression: the old tail sliced in CWID order and re-sorted only within
    // each page, so page 0 held c00–c19 whatever the names were.
    expect([...p0.hits, ...p1.hits].map((h) => h.preferredName)).toEqual(
      rows.map((r) => r.preferredName),
    );
    // Counts are not loaded for the default surname sort.
    expect(mockAuthorGroupBy.mock.calls.every((c) => c[0].where.cwid.in.length <= 20)).toBe(true);
  });

  it("q filters by name or title, case- and accent-blind", async () => {
    routeScholars([
      scholarRow("a1", { preferredName: "José Alvarez" }),
      scholarRow("a2", { preferredName: "Ann Brown", primaryTitle: "Chief of Cardiology" }),
      scholarRow("a3", { preferredName: "Cy Cole" }),
    ]);
    const byName = await getUnitMembersFiltered("department", "N1140", { q: "JOSE" }, 0);
    expect(byName.hits.map((h) => h.cwid)).toEqual(["a1"]);
    const byTitle = await getUnitMembersFiltered("department", "N1140", { q: "cardio" }, 0);
    expect(byTitle.hits.map((h) => h.cwid)).toEqual(["a2"]);
    expect(byTitle.total).toBe(1);
    expect(byTitle.roleCategoryCounts).toEqual({ "Full-time faculty": 1 });
  });

  it("methods + q + sort=pubs compose: facet ∩ query, ranked by the displayed pub count", async () => {
    routeScholars([
      scholarRow("p1", { preferredName: "Amy Smith" }),
      scholarRow("p2", { preferredName: "Bo Smith" }),
      scholarRow("p3", { preferredName: "Cy Smith" }),
      scholarRow("p4", { preferredName: "Di Jones" }),
    ]);
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve([{ cwid: "p1" }, { cwid: "p3" }, { cwid: "p4" }])
        : Promise.resolve([]),
    );
    mockAuthorGroupBy.mockResolvedValue([
      { cwid: "p1", _count: { _all: 3 } },
      { cwid: "p2", _count: { _all: 50 } },
      { cwid: "p3", _count: { _all: 7 } },
      { cwid: "p4", _count: { _all: 99 } },
    ]);

    const result = await getUnitMembersFiltered(
      "department",
      "N1140",
      { methodKeys: [`${SC}::A`], q: "smith", sort: "pubs" },
      0,
    );
    // p2 fails the facet, p4 fails the query.
    expect(result.hits.map((h) => h.cwid)).toEqual(["p3", "p1"]);
    expect(result.hits.map((h) => h.pubCount)).toEqual([7, 3]);
    expect(result.total).toBe(2);
  });

  it("sort=grants on a division ranks by the division's grant count", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue(["g1", "g2"]);
    routeScholars([
      scholarRow("g1", { preferredName: "Amy Able" }),
      scholarRow("g2", { preferredName: "Bo Best" }),
    ]);
    mockGrantGroupBy.mockResolvedValue([
      { cwid: "g1", _count: { _all: 1 } },
      { cwid: "g2", _count: { _all: 4 } },
    ]);
    const result = await getUnitMembersFiltered("division", "D1", { sort: "grants" }, 0);
    expect(result.hits.map((h) => [h.cwid, h.grantCount])).toEqual([
      ["g2", 4],
      ["g1", 1],
    ]);
  });
});

describe("getUnitMembersFiltered — division chief pin (agrees with getDivisionFaculty)", () => {
  function seedDivision() {
    mockLoadDivisionMemberCwids.mockResolvedValue(["c1", "c2", "c3"]);
    routeScholars([
      scholarRow("c1", { preferredName: "Amy Able" }),
      scholarRow("c2", { preferredName: "Bo Best" }),
      scholarRow("c3", { preferredName: "Cy Chief" }),
    ]);
    mockAuthorGroupBy.mockResolvedValue([
      { cwid: "c1", _count: { _all: 1 } },
      { cwid: "c2", _count: { _all: 9 } },
      { cwid: "c3", _count: { _all: 5 } },
    ]);
    mockResolveDivisionChief.mockResolvedValue("c3");
  }

  it("pins the chief first under the surname sort", async () => {
    seedDivision();
    const result = await getUnitMembersFiltered("division", "D1", {}, 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["c3", "c1", "c2"]);
    expect(mockResolveDivisionChief).toHaveBeenCalledWith("D1");
  });

  it("does not pin under a count sort — the explicit ranking wins", async () => {
    seedDivision();
    const result = await getUnitMembersFiltered("division", "D1", { sort: "pubs" }, 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["c2", "c3", "c1"]);
  });

  it("does not add a chief the query filtered out", async () => {
    seedDivision();
    const result = await getUnitMembersFiltered("division", "D1", { q: "best" }, 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["c2"]);
  });

  it("pins a single selected division's chief on a department roster (as the divCode SSR path does)", async () => {
    routeScholars([
      scholarRow("c1", { preferredName: "Amy Able" }),
      scholarRow("c3", { preferredName: "Cy Chief" }),
    ]);
    mockLoadDivisionMemberCwids.mockResolvedValue(["c1", "c3"]);
    mockResolveDivisionChief.mockResolvedValue("c3");
    const result = await getUnitMembersFiltered("department", "DEPT", { divisionCodes: ["D1"] }, 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["c3", "c1"]);
    expect(mockResolveDivisionChief).toHaveBeenCalledWith("D1");
  });
});

describe("buildHits", () => {
  it("keeps the caller's (ranked) cwid order, not name order", async () => {
    routeScholars([
      scholarRow("z1", { preferredName: "Aaron A" }),
      scholarRow("z2", { preferredName: "Zed Z" }),
    ]);
    const hits = await buildHits(["z2", "z1", "gone"], {
      kind: "department",
      chipsEnabled: false,
    });
    expect(hits.map((h) => h.cwid)).toEqual(["z2", "z1"]);
  });
});

describe("getUnitMembersFiltered — TOPICS (MeSH) chips, Unit Page v2", () => {
  it("looks up MeSH ONCE for the page's rows (no N+1) and returns topMesh on hits", async () => {
    routeScholars([scholarRow("tst0001"), scholarRow("tst0002"), scholarRow("tst0003")]);
    mockFamilyFindMany.mockResolvedValue([]);
    mockLoadTopMesh.mockResolvedValue(
      new Map([["tst0002", [{ ui: "D000001", label: "Alpha Term" }]]]),
    );

    const result = await getUnitMembersFiltered("department", "N1140", {}, 0);

    expect(mockLoadTopMesh).toHaveBeenCalledTimes(1);
    expect([...(mockLoadTopMesh.mock.calls[0][0] as string[])].sort()).toEqual([
      "tst0001",
      "tst0002",
      "tst0003",
    ]);
    const byCwid = new Map(result.hits.map((h) => [h.cwid, h]));
    expect(byCwid.get("tst0002")?.topMesh).toEqual([{ ui: "D000001", label: "Alpha Term" }]);
    expect(byCwid.get("tst0001")).not.toHaveProperty("topMesh");
  });
});
