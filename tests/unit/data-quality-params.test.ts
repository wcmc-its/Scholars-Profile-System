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
        "q=harr&type=postdoc&type=staff&unit=dept:MED&unit=div:CARD&gap=no-headshot&overviewAge=imported&hidden=0&page=2",
      ),
    );
    const fromObject = parseDataQualityParams({
      q: "harr",
      type: ["postdoc", "staff"],
      unit: ["dept:MED", "div:CARD"],
      gap: "no-headshot",
      overviewAge: "imported",
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
      gap: "no-headshot",
      overviewAge: "imported",
      includeHidden: false,
      page: 2,
    });
  });

  it("wraps a scalar object value into a single-element array", () => {
    const p = parseDataQualityParams({ type: "postdoc", unit: "center:MCC" });
    expect(p.roleCategories).toEqual(["postdoc"]);
    expect(p.units).toEqual([{ kind: "center", code: "MCC" }]);
  });

  it("drops malformed unit values from units but keeps them in unitValues", () => {
    const p = parseDataQualityParams(new URLSearchParams("unit=garbage&unit=div:&unit=dept:MED"));
    expect(p.units).toEqual([{ kind: "department", code: "MED" }]);
    expect(p.unitValues).toEqual(["garbage", "div:", "dept:MED"]);
  });

  it("clamps page and whitelists gap / overviewAge; trims q", () => {
    expect(parseDataQualityParams(new URLSearchParams("page=-3")).page).toBe(0);
    expect(parseDataQualityParams(new URLSearchParams("page=abc")).page).toBe(0);
    expect(parseDataQualityParams(new URLSearchParams("page=4")).page).toBe(4);
    expect(parseDataQualityParams(new URLSearchParams("gap=bogus")).gap).toBe("all");
    expect(parseDataQualityParams(new URLSearchParams("overviewAge=bogus")).overviewAge).toBe("all");
    expect(parseDataQualityParams(new URLSearchParams("q=%20%20Harrington%20")).q).toBe("Harrington");
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
      // divCode
      return Promise.resolve([
        { divCode: "CARD", _count: { _all: 4 } },
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
          { code: "NEO", name: "Neonatology", deptCode: "PED" },
        ]),
      },
      center: { findMany: vi.fn().mockResolvedValue([{ code: "MCC", name: "Meyer Cancer Center" }]) },
      scholar: { groupBy: scholarGroupBy },
      centerMembership: { groupBy: centerGroupBy },
    };
    return { client, centerGroupBy };
  }

  beforeEach(() => vi.clearAllMocks());

  it("nests divisions under their parent dept, encodes values, and maps counts", async () => {
    const { client } = facetClient();
    const facets = await loadDataQualityFacets(client as never);

    // Role categories: null dropped; count carried.
    expect(facets.roleCategories).toHaveLength(1);
    expect(facets.roleCategories[0]).toMatchObject({ value: "full_time_faculty", count: 10 });
    expect(facets.roleCategories[0].label.length).toBeGreaterThan(0);

    // Departments carry dept:CODE values + counts, with child divisions (div:CODE).
    const med = facets.departments.find((d) => d.value === "dept:MED")!;
    expect(med).toMatchObject({ label: "Medicine", count: 8 });
    expect(med.divisions).toEqual([{ value: "div:CARD", label: "Cardiology", count: 4 }]);
    // A division with no count aggregate defaults to 0.
    const ped = facets.departments.find((d) => d.value === "dept:PED")!;
    expect(ped.divisions).toEqual([{ value: "div:NEO", label: "Neonatology", count: 0 }]);

    // Centers: center:CODE + active-membership count.
    expect(facets.centers).toEqual([{ value: "center:MCC", label: "Meyer Cancer Center", count: 7 }]);
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
