/**
 * `lib/api/data-quality.ts` — the Data Quality roster query
 * (docs/data-quality-dashboard-spec.md): prominence sort, gap computation,
 * scope, filters, and pagination.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyLeadership, loadDataQualityRoster } from "@/lib/api/data-quality";

type AnyMock = ReturnType<typeof vi.fn>;
type LoaderClient = Parameters<typeof loadDataQualityRoster>[1];

function scholarRow(over: Record<string, unknown> = {}) {
  return {
    cwid: "x",
    slug: "x",
    preferredName: "X",
    primaryTitle: null,
    roleCategory: "full_time_faculty",
    overview: null,
    hIndex: null,
    scoredPubCount: null,
    hasHeadshot: null,
    department: null,
    division: null,
    ...over,
  };
}

/** A fake Prisma surface. grant.groupBy distinguishes the PI vs NIH-PI call by
 *  the presence of `where.nihIc`. */
function fakeClient(opts: {
  scholars?: unknown[];
  chairs?: string[];
  chiefs?: string[];
  pi?: Array<{ cwid: string; n: number }>;
  nihPi?: Array<{ cwid: string; n: number }>;
  coi?: Array<{ cwid: string; tier: string; n: number }>;
  overrides?: Array<{ entityId: string; value: string }>;
  prov?: Array<{ cwid: string; updatedAt: Date | string }>;
  /** Members returned for each requested center code (echoed back so the loader
   *  can partition scope-vs-filter centers). Active (null dates). */
  centerMembers?: string[];
  /** Full control over the membership rows the loader reads (cwid + dates), to
   *  exercise the pending/expired date filter. Filtered to requested codes. */
  centerMemberRows?: Array<{
    cwid: string;
    centerCode: string;
    startDate?: Date | null;
    endDate?: Date | null;
  }>;
}) {
  const scholarFindMany = vi.fn().mockResolvedValue(opts.scholars ?? []);
  const grantGroupBy: AnyMock = vi.fn().mockImplementation((args: { where?: { nihIc?: unknown } }) => {
    const isNih = args.where?.nihIc !== undefined;
    const rows = (isNih ? opts.nihPi : opts.pi) ?? [];
    return Promise.resolve(rows.map((r) => ({ cwid: r.cwid, _count: { _all: r.n } })));
  });
  const client = {
    scholar: { findMany: scholarFindMany },
    department: {
      findMany: vi.fn().mockResolvedValue((opts.chairs ?? []).map((c) => ({ chairCwid: c }))),
    },
    division: {
      findMany: vi.fn().mockResolvedValue((opts.chiefs ?? []).map((c) => ({ chiefCwid: c }))),
    },
    grant: { groupBy: grantGroupBy },
    coiGapCandidate: {
      groupBy: vi
        .fn()
        .mockResolvedValue(
          (opts.coi ?? []).map((r) => ({ cwid: r.cwid, tier: r.tier, _count: { _all: r.n } })),
        ),
    },
    fieldOverride: { findMany: vi.fn().mockResolvedValue(opts.overrides ?? []) },
    overviewProvenance: { findMany: vi.fn().mockResolvedValue(opts.prov ?? []) },
    centerMembership: {
      findMany: vi.fn().mockImplementation((args: { where?: { centerCode?: { in?: string[] } } }) => {
        const codes = args?.where?.centerCode?.in ?? [];
        if (opts.centerMemberRows) {
          return Promise.resolve(
            opts.centerMemberRows
              .filter((r) => codes.includes(r.centerCode))
              .map((r) => ({
                cwid: r.cwid,
                centerCode: r.centerCode,
                startDate: r.startDate ?? null,
                endDate: r.endDate ?? null,
              })),
          );
        }
        return Promise.resolve(
          (opts.centerMembers ?? []).map((cwid) => ({
            cwid,
            centerCode: codes[0],
            startDate: null,
            endDate: null,
          })),
        );
      }),
    },
  };
  return { client, scholarFindMany, grantGroupBy };
}
const asClient = (c: ReturnType<typeof fakeClient>["client"]) => c as unknown as LoaderClient;

beforeEach(() => vi.clearAllMocks());

describe("loadDataQualityRoster — gaps + prominence", () => {
  const scholars = [
    scholarRow({
      cwid: "fac1",
      slug: "fac-one",
      preferredName: "Ada Faculty",
      primaryTitle: "Professor",
      scoredPubCount: 100,
      hIndex: 40,
      overview: "A real bio.",
      hasHeadshot: true,
      department: { name: "Medicine" },
    }),
    scholarRow({
      cwid: "fac2",
      slug: "fac-two",
      preferredName: "Ben Chair",
      scoredPubCount: 10,
      hIndex: 5,
      overview: null,
      hasHeadshot: false,
      department: { name: "Medicine" },
    }),
    scholarRow({
      cwid: "stu1",
      slug: "stu-one",
      preferredName: "Cy Student",
      roleCategory: "doctoral_student",
      overview: null,
      hasHeadshot: null,
      department: { name: "Medicine" },
    }),
  ];
  const setup = () =>
    fakeClient({
      scholars,
      chairs: ["fac2"], // fac2 chairs a department
      chiefs: ["fac1"], // fac1 chiefs a division
      pi: [{ cwid: "fac1", n: 5 }],
      nihPi: [{ cwid: "fac1", n: 3 }],
      coi: [
        { cwid: "fac2", tier: "High", n: 2 },
        { cwid: "fac1", tier: "Medium", n: 1 },
      ],
      overrides: [{ entityId: "stu1", value: "An overridden bio." }],
    });

  it("computes each scholar's gaps correctly", async () => {
    const { client } = setup();
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    const byCwid = Object.fromEntries(entries.map((e) => [e.cwid, e]));

    expect(byCwid.fac1).toMatchObject({
      headshot: "present",
      hasOverview: true,
      isChief: true,
      isChair: false,
      pendingCoiHigh: 0,
      pendingCoiMedium: 1,
    });
    expect(byCwid.fac2).toMatchObject({
      headshot: "missing",
      hasOverview: false,
      isChair: true,
      pendingCoiHigh: 2,
    });
    // Student has no Scholar.overview but a field_override → counts as covered;
    // never-probed headshot → "unknown" (not "missing").
    expect(byCwid.stu1).toMatchObject({ headshot: "unknown", hasOverview: true });
    expect(byCwid.fac1.editHref).toBe("/edit/scholar/fac1");
  });

  it("sorts by prominence desc (chair/chief + PI/NIH + faculty all feed in)", async () => {
    const { client } = setup();
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(entries.map((e) => e.cwid)).toEqual(["fac1", "fac2", "stu1"]);
    expect(entries[0].prominence).toBeGreaterThan(entries[1].prominence);
    expect(entries[1].prominence).toBeGreaterThan(entries[2].prominence);
  });

  it("a pure chair outranks a same-publication non-leader (leadership weight)", async () => {
    const { client } = fakeClient({
      scholars: [
        scholarRow({ cwid: "plain", preferredName: "Plain", scoredPubCount: 10, hIndex: 5 }),
        scholarRow({ cwid: "chair", preferredName: "Chair", scoredPubCount: 10, hIndex: 5 }),
      ],
      chairs: ["chair"],
    });
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(entries[0].cwid).toBe("chair");
  });

  it("reports summary counts across the in-scope set (pre gap filter)", async () => {
    const { client } = setup();
    const { counts } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(counts).toEqual({ inScope: 3, missingHeadshot: 1, missingOverview: 1, withCoi: 1 });
  });
});

describe("loadDataQualityRoster — filters + pagination", () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    scholarRow({
      cwid: `s${i}`,
      preferredName: `S${i}`,
      scoredPubCount: 100 - i * 10, // descending prominence by index
      hasHeadshot: i % 2 === 0 ? false : true,
    }),
  );

  it("gap=no-headshot keeps only missing-headshot rows; total reflects the filter", async () => {
    const { client } = fakeClient({ scholars: many });
    const { entries, total } = await loadDataQualityRoster(
      { scope: { all: true }, gap: "no-headshot" },
      asClient(client),
    );
    expect(total).toBe(3); // s0, s2, s4
    expect(entries.every((e) => e.headshot === "missing")).toBe(true);
  });

  it("paginates the prominence-sorted set", async () => {
    const { client } = fakeClient({ scholars: many });
    const { entries, total } = await loadDataQualityRoster(
      { scope: { all: true }, limit: 2, offset: 2 },
      asClient(client),
    );
    expect(total).toBe(5);
    expect(entries.map((e) => e.cwid)).toEqual(["s2", "s3"]);
  });

  it("excludes hidden roles when includeHidden=false (where keeps nulls)", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [] });
    await loadDataQualityRoster({ scope: { all: true }, includeHidden: false }, asClient(client));
    const where = scholarFindMany.mock.calls[0][0].where;
    const hiddenClause = where.AND?.find(
      (c: { OR?: unknown[] }) => Array.isArray(c.OR),
    );
    expect(JSON.stringify(hiddenClause)).toContain("doctoral_student");
    expect(JSON.stringify(hiddenClause)).toContain("affiliate_alumni");
  });

  it("an explicit person-type multi-select governs and skips the hidden-OR", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [] });
    await loadDataQualityRoster(
      { scope: { all: true }, roleCategories: ["postdoc", "full_time_faculty"], includeHidden: false },
      asClient(client),
    );
    const where = scholarFindMany.mock.calls[0][0].where;
    expect(where.roleCategory).toEqual({ in: ["postdoc", "full_time_faculty"] });
    expect(where.AND).toBeUndefined();
  });

  it("a name/CWID search ORs preferredName/fullName/cwid as its own AND clause", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [] });
    await loadDataQualityRoster({ scope: { all: true }, query: "  harr " }, asClient(client));
    const where = scholarFindMany.mock.calls[0][0].where;
    const searchClause = where.AND?.find(
      (c: { OR?: Array<Record<string, unknown>> }) =>
        Array.isArray(c.OR) && c.OR.some((o) => "fullName" in o),
    );
    expect(searchClause).toEqual({
      OR: [
        { preferredName: { contains: "harr" } },
        { fullName: { contains: "harr" } },
        { cwid: { contains: "harr" } },
      ],
    });
  });

  it("a unit multi-select ORs departments / divisions / center members together", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [], centerMembers: ["c1", "c2"] });
    await loadDataQualityRoster(
      {
        scope: { all: true },
        units: [
          { kind: "department", code: "MED" },
          { kind: "division", code: "CARD" },
          { kind: "center", code: "MCC" },
        ],
      },
      asClient(client),
    );
    const where = scholarFindMany.mock.calls[0][0].where;
    const unitClause = where.AND?.find(
      (c: { OR?: Array<Record<string, unknown>> }) =>
        Array.isArray(c.OR) && c.OR.some((o) => "deptCode" in o),
    );
    expect(unitClause).toEqual({
      OR: [
        { deptCode: { in: ["MED"] } },
        { divCode: { in: ["CARD"] } },
        { cwid: { in: ["c1", "c2"] } },
      ],
    });
  });

  it("a center filter excludes pending / expired memberships (active by date only)", async () => {
    const past = new Date(Date.now() - 100 * 24 * 3600 * 1000); // expired
    const future = new Date(Date.now() + 100 * 24 * 3600 * 1000); // pending
    const { client, scholarFindMany } = fakeClient({
      scholars: [],
      centerMemberRows: [
        { cwid: "active1", centerCode: "MCC", startDate: null, endDate: null },
        { cwid: "expired1", centerCode: "MCC", endDate: past },
        { cwid: "pending1", centerCode: "MCC", startDate: future },
      ],
    });
    await loadDataQualityRoster(
      { scope: { all: true }, units: [{ kind: "center", code: "MCC" }] },
      asClient(client),
    );
    const where = scholarFindMany.mock.calls[0][0].where;
    const unitClause = where.AND?.find(
      (c: { OR?: Array<Record<string, unknown>> }) =>
        Array.isArray(c.OR) && c.OR.some((o) => "cwid" in o),
    );
    // Only the date-active member is in the filter; expired + pending are dropped.
    expect(unitClause).toEqual({ OR: [{ cwid: { in: ["active1"] } }] });
  });
});

describe("loadDataQualityRoster — leadership tier (#1)", () => {
  const cohort = [
    scholarRow({ cwid: "dean", preferredName: "The Dean", primaryTitle: "Stephen and Suzanne Weiss Dean", scoredPubCount: 1, hIndex: 1 }),
    scholarRow({ cwid: "assoc", preferredName: "Assoc Dean", primaryTitle: "Associate Dean", scoredPubCount: 1, hIndex: 1 }),
    scholarRow({ cwid: "emeritus", preferredName: "Old Dean", primaryTitle: "Dean Emeritus", scoredPubCount: 500, hIndex: 99 }),
    scholarRow({ cwid: "chair", preferredName: "A Chair", primaryTitle: "Professor", scoredPubCount: 1, hIndex: 1 }),
    scholarRow({ cwid: "plain", preferredName: "Plain Prof", primaryTitle: "Professor", scoredPubCount: 1000, hIndex: 200 }),
  ];

  it("ranks THE Dean #1, deanery next, then chairs, with Emeritus demoted to prominence", async () => {
    const { client } = fakeClient({ scholars: cohort, chairs: ["chair"] });
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(entries.map((e) => e.cwid)).toEqual(["dean", "assoc", "chair", "plain", "emeritus"]);
    expect(entries[0]).toMatchObject({ leadership: "Dean", leadershipTier: 0 });
    expect(entries[1]).toMatchObject({ leadership: "Associate Dean", leadershipTier: 1 });
    expect(entries[2]).toMatchObject({ leadership: "Chair", leadershipTier: 2 });
    // Emeritus dean is NOT leadership — ranks last here despite huge prominence.
    expect(entries[4]).toMatchObject({ cwid: "emeritus", leadership: null, leadershipTier: 3 });
  });
});

describe("classifyLeadership — title heuristic (#1)", () => {
  // Grounded against the live DB (the 5 "Dean" titles) + the deaneryLabel branches.
  const cases: Array<[string | null, number, string | null]> = [
    ["Stephen and Suzanne Weiss Dean", 0, "Dean"], // rharrington → THE Dean
    ["Associate Dean", 1, "Associate Dean"], // rbsilve
    ["Senior Associate Dean, Education", 1, "Senior Associate Dean"], // jos9046 (precedence)
    ["Assistant Dean", 1, "Assistant Dean"],
    ["Affiliate Dean (NYP Queens)", 1, "Affiliate Dean"],
    ["Vice Dean", 1, "Vice Dean"],
    ["Deputy Dean", 1, "Vice Dean"],
    ["Interim Dean", 1, "Interim Dean"],
    ["Dean, Weill Cornell Graduate School of Medical Sciences", 1, "Dean"], // school-specific → not tier 0
    ["Dean, Weill Cornell Medicine-Qatar", 1, "Dean"],
    ["Provost", 1, "Provost"],
    ["President, Cornell University", 1, "President"],
    ["EVP for Health", 1, "EVP"],
    // The load-bearing demotion: Emeritus wins over the Provost/Dean branches.
    ["Provost for Medical Affairs and Dean Emeritus", 3, null], // amg2004
    ["Dean Emeritus", 3, null], // dalonso
    ["Professor", 3, null],
    [null, 3, null],
  ];
  it.each(cases)("%s → tier %i / %s", (title, tier, label) => {
    expect(classifyLeadership(title, false, false)).toEqual({ tier, label });
  });

  it("a non-leader title falls back to the FK chair/chief tier", () => {
    expect(classifyLeadership("Professor", true, false)).toEqual({ tier: 2, label: "Chair" });
    expect(classifyLeadership("Professor", false, true)).toEqual({ tier: 2, label: "Chief" });
  });

  it("an active dean title outranks a chair FK (dean office beats chair)", () => {
    expect(classifyLeadership("Associate Dean", true, false)).toEqual({
      tier: 1,
      label: "Associate Dean",
    });
  });
});

describe("loadDataQualityRoster — overview freshness (#6)", () => {
  it("buckets never / imported / aged from OverviewProvenance and filters by it", async () => {
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000); // ~1 month ago
    const old = new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000); // ~3 years ago
    const scholars = [
      scholarRow({ cwid: "none", overview: null }),
      scholarRow({ cwid: "imp", overview: "Imported VIVO bio." }),
      scholarRow({ cwid: "fresh", overview: "Edited bio." }),
      scholarRow({ cwid: "stale", overview: "Edited long ago." }),
    ];
    const prov = [
      { cwid: "fresh", updatedAt: recent },
      { cwid: "stale", updatedAt: old },
    ];
    const { client } = fakeClient({ scholars, prov });
    const all = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    const byCwid = Object.fromEntries(all.entries.map((e) => [e.cwid, e]));
    expect(byCwid.none.overviewState).toBe("never");
    expect(byCwid.imp.overviewState).toBe("imported");
    expect(byCwid.imp.overviewUpdatedAt).toBeNull();
    expect(byCwid.fresh.overviewState).toBe("lt1yr");
    expect(byCwid.fresh.overviewUpdatedAt).toBe(recent.toISOString());
    expect(byCwid.stale.overviewState).toBe("gt2yr");

    const importedOnly = await loadDataQualityRoster(
      { scope: { all: true }, overviewAge: "imported" },
      asClient(client),
    );
    expect(importedOnly.entries.map((e) => e.cwid)).toEqual(["imp"]);
    expect(importedOnly.total).toBe(1);
    // Counts stay pre-filter (the full in-scope set).
    expect(importedOnly.counts.inScope).toBe(4);
  });

  it("buckets the 1-2yr band and composes with the gap filter", async () => {
    const mid = new Date(Date.now() - 18 * 30 * 24 * 3600 * 1000); // ~18 months ago
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const scholars = [
      scholarRow({ cwid: "mid", overview: "Edited ~18mo ago.", hasHeadshot: false }),
      scholarRow({ cwid: "midHas", overview: "Edited ~18mo ago.", hasHeadshot: true }),
      scholarRow({ cwid: "fresh", overview: "Edited recently.", hasHeadshot: false }),
    ];
    const prov = [
      { cwid: "mid", updatedAt: mid },
      { cwid: "midHas", updatedAt: mid },
      { cwid: "fresh", updatedAt: recent },
    ];
    const { client } = fakeClient({ scholars, prov });
    const byBucket = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(Object.fromEntries(byBucket.entries.map((e) => [e.cwid, e.overviewState])).mid).toBe(
      "1to2yr",
    );

    // gap=no-headshot AND overviewAge=1to2yr intersect (midHas has a headshot → out).
    const both = await loadDataQualityRoster(
      { scope: { all: true }, gap: "no-headshot", overviewAge: "1to2yr" },
      asClient(client),
    );
    expect(both.entries.map((e) => e.cwid)).toEqual(["mid"]);
    expect(both.counts.inScope).toBe(3); // counts stay pre-filter
  });
});

describe("loadDataQualityRoster — scope", () => {
  it("a unit scope restricts the query to the managed dept/div codes", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [] });
    await loadDataQualityRoster(
      { scope: { all: false, unitCodes: ["MED", "CARD"], centerCodes: [] } },
      asClient(client),
    );
    const where = scholarFindMany.mock.calls[0][0].where;
    const scopeClause = where.AND?.[0];
    expect(scopeClause).toEqual({
      OR: [{ deptCode: { in: ["MED", "CARD"] } }, { divCode: { in: ["MED", "CARD"] } }],
    });
    expect(client.centerMembership.findMany).not.toHaveBeenCalled();
  });

  it("a center scope expands to member cwids and ORs them into the where", async () => {
    const { client, scholarFindMany } = fakeClient({
      scholars: [],
      centerMembers: ["m1", "m2"],
    });
    await loadDataQualityRoster(
      { scope: { all: false, unitCodes: [], centerCodes: ["CTR1"] } },
      asClient(client),
    );
    expect(client.centerMembership.findMany).toHaveBeenCalledWith({
      where: { centerCode: { in: ["CTR1"] } },
      select: { cwid: true, centerCode: true, startDate: true, endDate: true },
    });
    const where = scholarFindMany.mock.calls[0][0].where;
    expect(where.AND?.[0]).toEqual({ OR: [{ cwid: { in: ["m1", "m2"] } }] });
  });
});
