/**
 * `lib/api/data-quality.ts` — the Data Quality roster query
 * (docs/data-quality-dashboard-spec.md): prominence sort, gap computation,
 * scope, filters, and pagination.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadDataQualityRoster } from "@/lib/api/data-quality";

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
  centerMembers?: string[];
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
    centerMembership: {
      findMany: vi.fn().mockResolvedValue((opts.centerMembers ?? []).map((cwid) => ({ cwid }))),
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

  it("an explicit person-type filter governs and skips the hidden-OR", async () => {
    const { client, scholarFindMany } = fakeClient({ scholars: [] });
    await loadDataQualityRoster(
      { scope: { all: true }, roleCategory: "postdoc", includeHidden: false },
      asClient(client),
    );
    const where = scholarFindMany.mock.calls[0][0].where;
    expect(where.roleCategory).toBe("postdoc");
    expect(where.AND).toBeUndefined();
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
      select: { cwid: true },
    });
    const where = scholarFindMany.mock.calls[0][0].where;
    expect(where.AND?.[0]).toEqual({ OR: [{ cwid: { in: ["m1", "m2"] } }] });
  });
});
