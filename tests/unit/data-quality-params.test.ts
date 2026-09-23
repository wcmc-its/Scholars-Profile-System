/**
 * `lib/api/data-quality.ts` — the shared param parser (`parseDataQualityParams`,
 * the page↔export "kill drift" boundary) and the filter-bar facet loader
 * (`loadDataQualityFacets`: the dept/division hierarchy + static counts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadDataQualityFacets, parseDataQualityParams } from "@/lib/api/data-quality";

describe("parseDataQualityParams — dual source + multi-value", () => {
  it("parses a URLSearchParams (route) and a Next searchParams object identically", () => {
    const fromUrl = parseDataQualityParams(
      new URLSearchParams(
        "q=harr&type=postdoc&type=staff&unit=dept:MED&unit=div:CARD&gap=has-coi&hidden=0&page=2",
      ),
    );
    const fromObject = parseDataQualityParams({
      q: "harr",
      type: ["postdoc", "staff"],
      unit: ["dept:MED", "div:CARD"],
      gap: "has-coi",
      hidden: "0",
      page: "2",
    });
    expect(fromUrl).toEqual(fromObject);
    expect(fromUrl).toEqual({
      q: "harr",
      roleCategories: ["postdoc", "staff"],
      units: [
        { kind: "department", code: "MED" },
        { kind: "division", code: "CARD" },
      ],
      unitValues: ["dept:MED", "div:CARD"],
      gap: "has-coi",
      overviewAge: "all",
      includeHidden: false,
      includeStudents: false,
      hiddenOnly: false,
      ranks: [],
      page: 2,
    });
  });

  it("wraps a scalar object value into a single-element array", () => {
    const p = parseDataQualityParams({ type: "postdoc", unit: "center:MCC" });
    expect(p.roleCategories).toEqual(["postdoc"]);
    expect(p.units).toEqual([{ kind: "center", code: "MCC" }]);
  });

  it("decodes inst:CODE as an institution filter (ED primary organization)", () => {
    const p = parseDataQualityParams(new URLSearchParams("unit=inst:HSS&unit=inst:WCMC"));
    expect(p.units).toEqual([
      { kind: "institution", code: "HSS" },
      { kind: "institution", code: "WCMC" },
    ]);
    expect(p.unitValues).toEqual(["inst:HSS", "inst:WCMC"]);
    // The prefix is exact: the long form is not an encoding.
    expect(parseDataQualityParams(new URLSearchParams("unit=institution:HSS")).units).toEqual([]);
  });

  it("drops malformed unit values from units but keeps them in unitValues", () => {
    const p = parseDataQualityParams(new URLSearchParams("unit=garbage&unit=div:&unit=dept:MED"));
    expect(p.units).toEqual([{ kind: "department", code: "MED" }]);
    expect(p.unitValues).toEqual(["garbage", "div:", "dept:MED"]);
  });

  it("clamps page and whitelists gap; trims q", () => {
    expect(parseDataQualityParams(new URLSearchParams("page=-3")).page).toBe(0);
    expect(parseDataQualityParams(new URLSearchParams("page=abc")).page).toBe(0);
    expect(parseDataQualityParams(new URLSearchParams("page=4")).page).toBe(4);
    expect(parseDataQualityParams(new URLSearchParams("gap=bogus")).gap).toBe("all");
    // The parser itself accepts every `DataQualityGapFilter` value — it's the
    // shared page↔export boundary for BOTH `/edit/profiles` and `/edit/coi`,
    // so it can't drop a value one of the two pages actually uses. Each PAGE
    // sanitizes down to its own subset afterward (see the page/export-route
    // tests), not this parser.
    expect(parseDataQualityParams(new URLSearchParams("gap=no-headshot")).gap).toBe("no-headshot");
    expect(parseDataQualityParams(new URLSearchParams("gap=no-overview")).gap).toBe("no-overview");
    expect(parseDataQualityParams(new URLSearchParams("gap=has-coi")).gap).toBe("has-coi");
    expect(parseDataQualityParams(new URLSearchParams("q=%20%20Harrington%20")).q).toBe("Harrington");
  });

  it("whitelists overviewAge, defaulting anything unrecognized to 'all'", () => {
    expect(parseDataQualityParams(new URLSearchParams("")).overviewAge).toBe("all");
    expect(parseDataQualityParams(new URLSearchParams("overviewAge=bogus")).overviewAge).toBe("all");
    for (const v of ["imported", "never", "lt1yr", "1to2yr", "gt2yr"]) {
      expect(parseDataQualityParams(new URLSearchParams(`overviewAge=${v}`)).overviewAge).toBe(v);
    }
  });

  it("Profiles: students hidden unless students=1; visibility=hidden → hidden only", () => {
    expect(parseDataQualityParams(new URLSearchParams("")).includeStudents).toBe(false);
    expect(parseDataQualityParams(new URLSearchParams("students=1")).includeStudents).toBe(true);
    expect(parseDataQualityParams(new URLSearchParams("")).hiddenOnly).toBe(false);
    expect(parseDataQualityParams(new URLSearchParams("visibility=hidden")).hiddenOnly).toBe(true);
  });

  it("defaults includeHidden true; only 0/false hide", () => {
    expect(parseDataQualityParams(new URLSearchParams("")).includeHidden).toBe(true);
    expect(parseDataQualityParams(new URLSearchParams("hidden=1")).includeHidden).toBe(true);
    expect(parseDataQualityParams(new URLSearchParams("hidden=0")).includeHidden).toBe(false);
    expect(parseDataQualityParams(new URLSearchParams("hidden=false")).includeHidden).toBe(false);
  });
});

describe("loadDataQualityFacets — hierarchy + counts", () => {
  function facetClient() {
    const centerGroupBy = vi.fn().mockResolvedValue([{ centerCode: "MCC", _count: { _all: 7 } }]);
    const scholarGroupBy = vi.fn().mockImplementation((args: { by: string[] }) => {
      if (args.by[0] === "roleCategory")
        return Promise.resolve([
          { roleCategory: "full_time_faculty", _count: { _all: 10 } },
          { roleCategory: null, _count: { _all: 3 } },
        ]);
      if (args.by[0] === "deptCode")
        return Promise.resolve([
          { deptCode: "MED", _count: { _all: 8 } },
          { deptCode: "PED", _count: { _all: 5 } },
        ]);
      if (args.by[0] === "primaryOrgCode")
        return Promise.resolve([
          { primaryOrgCode: "WCMC", _count: { _all: 9000 } },
          { primaryOrgCode: "HSS", _count: { _all: 40 } },
          { primaryOrgCode: "ZZZ", _count: { _all: 1 } }, // an ED code the map lacks
          { primaryOrgCode: null, _count: { _all: 22 } },
        ]);
      // divCode
      return Promise.resolve([
        { divCode: "CARD", _count: { _all: 4 } },
        { divCode: "PCARD", _count: { _all: 2 } },
        { divCode: null, _count: { _all: 99 } },
      ]);
    });
    const client = {
      department: {
        findMany: vi.fn().mockResolvedValue([
          { code: "MED", name: "Medicine" },
          { code: "PED", name: "Pediatrics" },
        ]),
      },
      division: {
        findMany: vi.fn().mockResolvedValue([
          { code: "CARD", name: "Cardiology", deptCode: "MED" },
          { code: "PCARD", name: "Cardiology", deptCode: "PED" }, // same name, different parent
          { code: "NEO", name: "Neonatology", deptCode: "PED" },
        ]),
      },
      center: { findMany: vi.fn().mockResolvedValue([{ code: "MCC", name: "Meyer Cancer Center" }]) },
      scholar: {
        groupBy: scholarGroupBy,
        count: vi.fn().mockImplementation((args: { where: { professorialRank?: string | null } }) =>
          Promise.resolve(args.where.professorialRank === "Associate Professor" ? 0 : 5),
        ),
      },
      centerMembership: { groupBy: centerGroupBy },
    };
    return { client, centerGroupBy };
  }

  beforeEach(() => vi.clearAllMocks());

  it("hides the tiny instructor/lecturer person types and counts ranks", async () => {
    const { client } = facetClient();
    const roles = [
      { roleCategory: "full_time_faculty", _count: { _all: 10 } },
      { roleCategory: "instructor", _count: { _all: 7 } },
    ];
    const base = client.scholar.groupBy.getMockImplementation()!;
    client.scholar.groupBy.mockImplementation((args: { by: string[] }) =>
      args.by[0] === "roleCategory" ? Promise.resolve(roles) : base(args),
    );
    const facets = await loadDataQualityFacets(client as never);
    expect(facets.roleCategories.map((r) => r.value)).toEqual(["full_time_faculty"]);
    // count mock: 5 for every rank except Associate (0 → dropped)
    expect(facets.ranks).toEqual([
      { value: "professor", label: "Professor", count: 5 },
      { value: "assistant", label: "Assistant Professor", count: 5 },
      { value: "instructor", label: "Instructor / Lecturer", count: 5 },
    ]);
  });

  it("nests divisions under their parent dept, encodes values, and maps counts", async () => {
    const { client } = facetClient();
    const facets = await loadDataQualityFacets(client as never);

    // Role categories: null dropped; count carried.
    expect(facets.roleCategories).toHaveLength(1);
    expect(facets.roleCategories[0]).toMatchObject({ value: "full_time_faculty", count: 10 });
    expect(facets.roleCategories[0].label.length).toBeGreaterThan(0);

    // Departments carry dept:CODE values + counts, with child divisions (div:CODE).
    // Every division shows its parent department in the label so it is
    // self-identifying (and same-named divisions across departments are distinct).
    const med = facets.departments.find((d) => d.value === "dept:MED")!;
    expect(med).toMatchObject({ label: "Medicine", count: 8 });
    expect(med.divisions).toEqual([{ value: "div:CARD", label: "Cardiology (Medicine)", count: 4 }]);
    const ped = facets.departments.find((d) => d.value === "dept:PED")!;
    expect(ped.divisions).toEqual([
      { value: "div:PCARD", label: "Cardiology (Pediatrics)", count: 2 },
      { value: "div:NEO", label: "Neonatology (Pediatrics)", count: 0 }, // no count aggregate → 0
    ]);

    // Centers: center:CODE + active-membership count.
    expect(facets.centers).toEqual([{ value: "center:MCC", label: "Meyer Cancer Center", count: 7 }]);

    // Institutions: inst:CODE from the scholar column, labelled for display (the
    // home code named, an unmapped code left bare), largest-first, NO null bucket.
    expect(facets.institutions).toEqual([
      { value: "inst:WCMC", label: "Weill Cornell Medicine", count: 9000 },
      { value: "inst:HSS", label: "Hospital for Special Surgery", count: 40 },
      { value: "inst:ZZZ", label: "ZZZ", count: 1 },
    ]);
  });

  it("orders units largest-first and person types by descending career stage", async () => {
    const { client } = facetClient();
    // "Anesthesiology" sorts first A–Z but has the fewest people.
    client.department.findMany.mockResolvedValue([
      { code: "ANES", name: "Anesthesiology" },
      { code: "MED", name: "Medicine" },
      { code: "PED", name: "Pediatrics" },
    ]);
    client.scholar.groupBy.mockImplementation((args: { by: string[] }) => {
      if (args.by[0] === "roleCategory")
        return Promise.resolve([
          { roleCategory: "postdoc", _count: { _all: 400 } },
          { roleCategory: "emeritus", _count: { _all: 100 } },
          { roleCategory: "full_time_faculty", _count: { _all: 10 } },
          { roleCategory: "affiliated_faculty", _count: { _all: 5000 } },
        ]);
      if (args.by[0] === "deptCode")
        return Promise.resolve([
          { deptCode: "ANES", _count: { _all: 1 } },
          { deptCode: "MED", _count: { _all: 8 } },
          { deptCode: "PED", _count: { _all: 5 } },
        ]);
      if (args.by[0] === "divCode")
        return Promise.resolve([
          { divCode: "PCARD", _count: { _all: 2 } },
          { divCode: "NEO", _count: { _all: 3 } },
        ]);
      return Promise.resolve([]);
    });
    client.center.findMany.mockResolvedValue([
      { code: "AAA", name: "Aging Center" },
      { code: "MCC", name: "Meyer Cancer Center" },
    ]);

    const facets = await loadDataQualityFacets(client as never);

    expect(facets.departments.map((d) => d.value)).toEqual(["dept:MED", "dept:PED", "dept:ANES"]);
    expect(facets.departments[1].divisions.map((d) => d.value)).toEqual(["div:NEO", "div:PCARD"]);
    expect(facets.centers.map((c) => c.value)).toEqual(["center:MCC", "center:AAA"]);
    expect(facets.roleCategories.map((r) => r.value)).toEqual([
      "full_time_faculty",
      "affiliated_faculty",
      "postdoc",
      "emeritus",
    ]);
  });

  it("counts institutions over ACTIVE scholars, like departments", async () => {
    const { client } = facetClient();
    await loadDataQualityFacets(client as never);
    expect(client.scholar.groupBy).toHaveBeenCalledWith({
      by: ["primaryOrgCode"],
      where: { deletedAt: null, status: "active" },
      _count: { _all: true },
    });
  });

  it("date-filters the center count (active memberships only)", async () => {
    const { client, centerGroupBy } = facetClient();
    await loadDataQualityFacets(client as never);
    expect(centerGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["centerCode"],
        where: expect.objectContaining({ AND: expect.any(Array) }),
      }),
    );
  });
});
