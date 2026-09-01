/**
 * `lib/api/data-quality.ts` — the Profiles roster query (formerly the Data
 * Quality dashboard query, `docs/data-quality-dashboard-spec.md`): prominence
 * sort, leadership, COI signal, visibility, scope, filters, and pagination.
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
    status: "active",
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
  /** Same shape as the real `department.findMany({ chairCwid, category })`
   *  select — use this instead of `chairs` when a test needs to exercise the
   *  Chair-vs-Director split (#58 / #2542 Phase D). Takes precedence over
   *  `chairs` when both are given. */
  chairDepartments?: Array<{ chairCwid: string; category: string }>;
  chiefs?: string[];
  pi?: Array<{ cwid: string; n: number }>;
  nihPi?: Array<{ cwid: string; n: number }>;
  coi?: Array<{ cwid: string; tier: string; n: number }>;
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
  /** Manual DIVISION-roster rows (`DivisionMembership`) — echoed back filtered
   *  to the requested division codes, mirroring `centerMemberRows`. */
  divisionRosterRows?: Array<{ cwid: string; divisionCode: string }>;
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
      findMany: vi.fn().mockResolvedValue(
        opts.chairDepartments ??
          (opts.chairs ?? []).map((c) => ({ chairCwid: c, category: "clinical" })),
      ),
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
    divisionMembership: {
      findMany: vi.fn().mockImplementation((args: { where?: { divisionCode?: { in?: string[] } } }) => {
        const codes = args?.where?.divisionCode?.in ?? [];
        return Promise.resolve(
          (opts.divisionRosterRows ?? [])
            .filter((r) => codes.includes(r.divisionCode))
            .map((r) => ({ cwid: r.cwid, divisionCode: r.divisionCode })),
        );
      }),
    },
    fieldOverride: { findMany: vi.fn().mockResolvedValue([]) },
    overviewProvenance: { findMany: vi.fn().mockResolvedValue([]) },
    // #2542 contract A — chair/chief come from `OrgUnitRoleAssignment` only;
    // `Department.chairCwid` / `Division.chiefCwid` no longer exist as read
    // sources. Derived from the SAME `chairs`/`chairDepartments`/`chiefs`
    // options every test already passes — `roleKey` is what now carries the
    // Chair-vs-Director split (#58), computed here exactly as
    // `departmentLeaderRoleKey` does in production.
    orgUnitRoleAssignment: {
      findMany: vi.fn().mockImplementation((args: { where?: { entityType?: string } }) => {
        const entityType = args?.where?.entityType;
        if (entityType === "department") {
          const rows =
            opts.chairDepartments ??
            (opts.chairs ?? []).map((c) => ({ chairCwid: c, category: "clinical" }));
          return Promise.resolve(
            rows.map((d) => ({
              cwid: d.chairCwid,
              roleKey: d.category === "administrative" ? "director" : "chair",
            })),
          );
        }
        if (entityType === "division") {
          return Promise.resolve((opts.chiefs ?? []).map((c) => ({ cwid: c })));
        }
        return Promise.resolve([]);
      }),
    },
  };
  return { client, scholarFindMany, grantGroupBy };
}
const asClient = (c: ReturnType<typeof fakeClient>["client"]) => c as unknown as LoaderClient;

beforeEach(() => vi.clearAllMocks());

describe("loadDataQualityRoster — leadership + COI + prominence", () => {
  const scholars = [
    scholarRow({
      cwid: "fac1",
      slug: "fac-one",
      preferredName: "Ada Faculty",
      primaryTitle: "Professor",
      scoredPubCount: 100,
      hIndex: 40,
      department: { name: "Medicine" },
    }),
    scholarRow({
      cwid: "fac2",
      slug: "fac-two",
      preferredName: "Ben Chair",
      scoredPubCount: 10,
      hIndex: 5,
      department: { name: "Medicine" },
    }),
    scholarRow({
      cwid: "stu1",
      slug: "stu-one",
      preferredName: "Cy Student",
      roleCategory: "doctoral_student",
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
    });

  it("computes each scholar's chair/chief + COI signal correctly", async () => {
    const { client } = setup();
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    const byCwid = Object.fromEntries(entries.map((e) => [e.cwid, e]));

    expect(byCwid.fac1).toMatchObject({
      isChief: true,
      isChair: false,
      pendingCoiHigh: 0,
      pendingCoiMedium: 1,
    });
    expect(byCwid.fac2).toMatchObject({
      isChair: true,
      pendingCoiHigh: 2,
    });
    expect(byCwid.fac1.editHref).toBe("/edit/scholar/fac1");
  });

  // #58 / #2542 Phase D — an administrative department (e.g. the Library) is
  // led by a DIRECTOR, not a Chair. Before this fix, `chairs` was a plain
  // `Set<string>` keyed only by `Department.chairCwid` membership, so this
  // scholar's `leadership` label read "Chair" regardless of category.
  it("labels an administrative department's leader 'Director', not 'Chair'", async () => {
    const { client } = fakeClient({
      scholars: [
        scholarRow({ cwid: "dir1", preferredName: "Dee Director", department: { name: "Library" } }),
      ],
      chairDepartments: [{ chairCwid: "dir1", category: "administrative" }],
    });
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(entries[0]).toMatchObject({ isChair: true, leadership: "Director", leadershipTier: 2 });
  });

  // The three non-administrative categories all read "Chair" — only
  // `administrative` maps to Director (`departmentLeaderRoleKey`).
  it.each(["clinical", "mixed", "basic"])(
    "labels a '%s' department's leader 'Chair'",
    async (category) => {
      const { client } = fakeClient({
        scholars: [scholarRow({ cwid: "ch1", preferredName: "Cee Chair" })],
        chairDepartments: [{ chairCwid: "ch1", category }],
      });
      const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
      expect(entries[0]).toMatchObject({ isChair: true, leadership: "Chair", leadershipTier: 2 });
    },
  );

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
    // None of this fixture's scholars set hasHeadshot/overview, so headshot is
    // "unknown" (not "missing") for all three and hasOverview is false for all
    // three.
    expect(counts).toEqual({ inScope: 3, missingHeadshot: 0, missingOverview: 3, withCoi: 1 });
  });
});

describe("loadDataQualityRoster — visibility", () => {
  it("computes isVisible from Scholar.status — both visible and hidden are candidates", async () => {
    const { client } = fakeClient({
      scholars: [
        scholarRow({ cwid: "vis1", status: "active" }),
        scholarRow({ cwid: "hid1", status: "suppressed" }),
      ],
    });
    const { entries } = await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    const byCwid = Object.fromEntries(entries.map((e) => [e.cwid, e]));
    // Neither the visible nor the hidden scholar is filtered out — unlike the
    // old dashboard, which hard-filtered to `status: "active"` only.
    expect(entries).toHaveLength(2);
    expect(byCwid.vis1.isVisible).toBe(true);
    expect(byCwid.hid1.isVisible).toBe(false);
  });
});

describe("loadDataQualityRoster — filters + pagination", () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    scholarRow({
      cwid: `s${i}`,
      preferredName: `S${i}`,
      scoredPubCount: 100 - i * 10, // descending prominence by index
    }),
  );

  it("gap=has-coi keeps only scholars with pending High-tier COI; total reflects the filter", async () => {
    const { client } = fakeClient({
      scholars: many,
      coi: [
        { cwid: "s0", tier: "High", n: 1 },
        { cwid: "s2", tier: "High", n: 2 },
        { cwid: "s4", tier: "High", n: 1 },
      ],
    });
    const { entries, total } = await loadDataQualityRoster(
      { scope: { all: true }, gap: "has-coi" },
      asClient(client),
    );
    expect(total).toBe(3); // s0, s2, s4
    expect(entries.every((e) => e.pendingCoiHigh > 0)).toBe(true);
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
    expect(classifyLeadership(title, null, false)).toEqual({ tier, label });
  });

  it("a non-leader title falls back to the FK chair/chief tier", () => {
    expect(classifyLeadership("Professor", "Chair", false)).toEqual({ tier: 2, label: "Chair" });
    expect(classifyLeadership("Professor", null, true)).toEqual({ tier: 2, label: "Chief" });
  });

  it("an active dean title outranks a chair FK (dean office beats chair)", () => {
    expect(classifyLeadership("Associate Dean", "Chair", false)).toEqual({
      tier: 1,
      label: "Associate Dean",
    });
  });

  // #58 / #2542 Phase D — an administrative department's leader is a
  // DIRECTOR, not a Chair. `classifyLeadership` itself is category-agnostic
  // (it trusts whatever label the caller resolved); this just confirms the
  // resolved label passes through as the tier-2 display label unchanged.
  it("passes through a pre-resolved 'Director' label for an administrative department", () => {
    expect(classifyLeadership("Professor", "Director", false)).toEqual({
      tier: 2,
      label: "Director",
    });
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

  it("a division scope unions in manual DivisionMembership roster cwids (Amendment 4 parity)", async () => {
    // A scholar can be on a division's manual roster (`DivisionMembership`)
    // without their own `divCode` column pointing at it — Amendment 4 still
    // makes them editable by that division's admin
    // (`lib/edit/unit-scholar-authz.ts`), so the roster that FINDS them must
    // use the same union or it silently under-lists people the per-scholar
    // editor still lets the admin open.
    const { client, scholarFindMany } = fakeClient({
      scholars: [],
      divisionRosterRows: [{ cwid: "roster-only-1", divisionCode: "CARD" }],
    });
    await loadDataQualityRoster(
      { scope: { all: false, unitCodes: ["CARD"], centerCodes: [] } },
      asClient(client),
    );
    expect(client.divisionMembership.findMany).toHaveBeenCalledWith({
      where: { divisionCode: { in: ["CARD"] } },
      select: { cwid: true },
    });
    const where = scholarFindMany.mock.calls[0][0].where;
    const scopeClause = where.AND?.[0];
    expect(scopeClause).toEqual({
      OR: [
        { deptCode: { in: ["CARD"] } },
        { divCode: { in: ["CARD"] } },
        { cwid: { in: ["roster-only-1"] } },
      ],
    });
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

  // Defensive-only: the route already 403s an empty scope via `isEmptyScope`
  // before the query ever runs, but the loader itself must fail CLOSED (match
  // nothing) rather than vacuously matching everyone, should that guard ever
  // be bypassed. Mirrors the retired `loadEditRoster`'s equivalent case.
  it("an empty non-global scope (no unit or center codes) matches nothing, not everything", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [] });
    await loadDataQualityRoster(
      { scope: { all: false, unitCodes: [], centerCodes: [] } },
      asClient(client),
    );
    const where = scholarFindMany.mock.calls[0][0].where;
    expect(where.AND?.[0]).toEqual({ cwid: { in: [] } });
  });
});
