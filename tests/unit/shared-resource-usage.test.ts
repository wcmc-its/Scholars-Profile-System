/**
 * Report 20's pure half (`lib/edit/shared-resource-usage.ts`): fiscal quarters,
 * the params, and every view `computeSharedResourceUsage` builds. Synthetic
 * fixtures only (the repo is public): made-up cores, labs, PIs and amounts.
 */
import { describe, expect, it } from "vitest";

import {
  computeSharedResourceUsage,
  fiscalQuarter,
  fiscalQuarterOf,
  NO_PROGRAM,
  NON_MEMBER,
  parseFiscalQuarterKey,
  parseSharedResourceParams,
  sharePct,
  sharedResourceQuery,
  usd,
  type SharedResource,
  type UsageCharge,
  type UsageMembership,
} from "@/lib/edit/shared-resource-usage";

describe("fiscal quarters (FY starts July 1)", () => {
  it("maps each quarter to its months, Q3 crossing the calendar year", () => {
    expect(fiscalQuarter(2027, 1)).toEqual({
      key: "FY27Q1",
      label: "FY27 Q1 (Jul–Sep 2026)",
      start: "2026-07-01",
      end: "2026-10-01",
    });
    expect(fiscalQuarter(2027, 2)).toMatchObject({ start: "2026-10-01", end: "2027-01-01" });
    expect(fiscalQuarter(2027, 3)).toMatchObject({
      label: "FY27 Q3 (Jan–Mar 2027)",
      start: "2027-01-01",
    });
    expect(fiscalQuarter(2027, 4)).toMatchObject({ start: "2027-04-01", end: "2027-07-01" });
  });

  it("finds the quarter of a date at each boundary", () => {
    expect(fiscalQuarterOf("2026-07-01").key).toBe("FY27Q1");
    expect(fiscalQuarterOf("2026-09-30").key).toBe("FY27Q1");
    expect(fiscalQuarterOf("2026-10-01").key).toBe("FY27Q2");
    expect(fiscalQuarterOf("2026-12-31").key).toBe("FY27Q2");
    expect(fiscalQuarterOf("2027-01-01").key).toBe("FY27Q3");
    expect(fiscalQuarterOf("2027-06-30").key).toBe("FY27Q4");
  });

  it("parses only a well-formed key", () => {
    expect(parseFiscalQuarterKey("FY27Q2")?.start).toBe("2026-10-01");
    for (const bad of ["FY27Q5", "fy27q1", "FY2027Q1", "", null, undefined]) {
      expect(parseFiscalQuarterKey(bad)).toBeNull();
    }
  });
});

describe("params", () => {
  it("drops a bad quarter, trims the core, and round-trips", () => {
    const p = parseSharedResourceParams(new URLSearchParams("quarter=nope&core=%20Core%20A%20"));
    expect(p).toEqual({ quarter: null, core: "Core A" });
    const q = { quarter: "FY27Q1", core: "Core A" };
    expect(parseSharedResourceParams(new URLSearchParams(sharedResourceQuery(q)))).toEqual(q);
    expect(sharedResourceQuery({ quarter: null, core: null })).toBe("");
  });
});

const RESOURCES: SharedResource[] = [
  { name: "SR One", cores: ["Core A", "Core B"], provisional: true },
  { name: "SR Two", cores: ["Core C"] },
];
const Q = fiscalQuarter(2027, 1);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

const mem = (
  cwid: string,
  programCode: string | null,
  start?: string,
  end?: string,
  role = "research",
): UsageMembership => ({
  cwid,
  programCode,
  startDate: start ? d(start) : null,
  endDate: end ? d(end) : null,
  membershipRoleKey: role,
});

const charge = (o: Partial<UsageCharge>): UsageCharge => ({
  coreName: "Core A",
  customerLab: "Lab One",
  piCwid: "pi_p1a",
  ilabMcc: true,
  totalPrice: 100,
  isSubsidy: false,
  erpDate: "2026-08-15",
  ...o,
});

const MEMBERS = [
  mem("pi_p1a", "P1"),
  mem("pi_p1b", "P1"),
  mem("pi_p2a", "P2"),
  mem("pi_p2b", "P2", undefined, "2026-08-01"), // leaves mid-quarter
  mem("pi_none", null),
  mem("pi_later", "P2", "2026-12-01"), // joins after the quarter
  mem("pi_invited", "P1", undefined, undefined, "invited"),
];

function run(charges: UsageCharge[], memberships = MEMBERS) {
  return computeSharedResourceUsage({
    charges,
    memberships,
    programs: ["P1", "P2"],
    resources: RESOURCES,
    quarter: Q,
  });
}

describe("computeSharedResourceUsage", () => {
  const charges = [
    charge({ totalPrice: 100 }),
    charge({ totalPrice: 40, isSubsidy: true }),
    charge({ coreName: "Core B", totalPrice: 60, piCwid: "pi_p1b", customerLab: "Lab Two" }),
    charge({ coreName: "Core B", totalPrice: -10, piCwid: "pi_p1b", customerLab: "Lab Two" }), // refund
    charge({
      coreName: "Core C",
      totalPrice: 200,
      piCwid: "pi_p2a",
      customerLab: "Lab Three",
      ilabMcc: false,
    }),
    // pi_p2b's membership ended 08-01: this charge is Non-MCC.
    charge({
      coreName: "Core C",
      totalPrice: 50,
      piCwid: "pi_p2b",
      customerLab: "Lab Four",
      erpDate: "2026-09-01",
    }),
    // Not a member at all, subsidised though iLab flags it non-MCC.
    charge({
      totalPrice: 30,
      piCwid: "pi_ext",
      customerLab: "Lab Five",
      ilabMcc: false,
      isSubsidy: true,
    }),
    charge({ totalPrice: 70, piCwid: null, customerLab: "Lab Six", ilabMcc: false }),
    // A core outside every SR, with a subsidy line.
    charge({ coreName: "Core Z", totalPrice: 25, isSubsidy: true }),
    charge({ coreName: "Core Z", totalPrice: 5, piCwid: "pi_none", customerLab: "Lab Seven" }),
    // Outside the quarter: ignored everywhere.
    charge({ totalPrice: 999, erpDate: "2026-10-01" }),
    charge({ totalPrice: 999, erpDate: "2026-06-30" }),
  ];
  const u = run(charges);

  it("counts only charges inside the quarter", () => {
    expect(u.chargeCount).toBe(10);
  });

  it("view 1: SR x program, members only, refunds netted", () => {
    expect(u.srByProgram).toEqual([
      { sr: "SR One", byGroup: { P1: 190 }, total: 190 },
      { sr: "SR Two", byGroup: { P2: 200 }, total: 200 },
    ]);
  });

  it("view 2: SR x programs and Non-MCC", () => {
    expect(u.srByAll).toEqual([
      { sr: "SR One", byGroup: { P1: 190, [NON_MEMBER]: 100 }, total: 290 },
      { sr: "SR Two", byGroup: { P2: 200, [NON_MEMBER]: 50 }, total: 250 },
    ]);
  });

  it("groups are the programs, then No program when a member has none", () => {
    expect(u.groups).toEqual(["P1", "P2", NO_PROGRAM]);
  });

  it("view 3: distinct member PIs over the program's members active in the quarter", () => {
    // P1: pi_p1a, pi_p1b (invited excluded). P2: pi_p2a, pi_p2b (active until 08-01); pi_later not yet.
    expect(u.programShare[0]).toEqual({
      sr: "SR One",
      byGroup: {
        P1: { users: 2, members: 2 },
        P2: { users: 0, members: 2 },
        [NO_PROGRAM]: { users: 0, members: 1 },
      },
    });
    expect(u.programShare[1].byGroup.P2).toEqual({ users: 1, members: 2 });
  });

  it("view 4: distinct member PIs over all members", () => {
    expect(u.memberCount).toBe(5);
    expect(u.memberShare).toEqual([
      { sr: "SR One", users: 2, members: 5 },
      { sr: "SR Two", users: 1, members: 5 },
    ]);
  });

  it("view 5: every core, member dollars by program, largest first", () => {
    expect(u.coresByProgram).toEqual([
      { core: "Core C", byGroup: { P2: 200 }, total: 200 },
      { core: "Core A", byGroup: { P1: 140 }, total: 140 },
      { core: "Core B", byGroup: { P1: 50 }, total: 50 },
      { core: "Core Z", byGroup: { P1: 25, [NO_PROGRAM]: 5 }, total: 30 },
    ]);
  });

  it("view 6: one row per core, lab and group, largest subsidy first within a core", () => {
    const coreA = u.labs.filter((l) => l.coreName === "Core A");
    expect(coreA).toEqual([
      {
        coreName: "Core A",
        customerLab: "Lab One",
        group: "P1",
        total: 140,
        subsidy: 40,
        charges: 2,
      },
      {
        coreName: "Core A",
        customerLab: "Lab Five",
        group: NON_MEMBER,
        total: 30,
        subsidy: 30,
        charges: 1,
      },
      {
        coreName: "Core A",
        customerLab: "Lab Six",
        group: NON_MEMBER,
        total: 70,
        subsidy: 0,
        charges: 1,
      },
    ]);
    expect(u.labs.map((l) => l.coreName)).toEqual([
      "Core A",
      "Core A",
      "Core A",
      "Core B",
      "Core C",
      "Core C",
      "Core Z",
      "Core Z",
    ]);
  });

  it("data quality: non-MCC subsidy, subsidy outside SRs, member labs not flagged", () => {
    expect(u.dataQuality).toEqual({
      subsidyToNonMcc: { lines: 1, amount: 30, labs: 1 },
      subsidyOutsideSr: 25,
      memberLabsNotFlagged: ["Lab Three"],
    });
  });

  it("sums in cents (no float drift)", () => {
    const v = run([charge({ totalPrice: 0.1 }), charge({ totalPrice: 0.2 })]);
    expect(v.srByProgram[0].total).toBe(0.3);
  });

  it("assigns the program held on the charge's date", () => {
    const moved = [
      mem("pi_mover", "P1", undefined, "2026-07-31"),
      mem("pi_mover", "P2", "2026-08-01"),
    ];
    const v = run(
      [
        charge({ piCwid: "pi_mover", erpDate: "2026-07-15" }),
        charge({ piCwid: "pi_mover", erpDate: "2026-09-15", totalPrice: 300 }),
      ],
      moved,
    );
    expect(v.srByProgram[0].byGroup).toEqual({ P1: 100, P2: 300 });
    expect(v.memberCount).toBe(1);
  });

  it("an SR with no charges still gets its row", () => {
    const v = run([charge({})]);
    expect(v.srByAll[1]).toEqual({ sr: "SR Two", byGroup: {}, total: 0 });
    expect(v.groups).toEqual(["P1", "P2", NO_PROGRAM]);
  });
});

describe("formatters", () => {
  it("sharePct and usd", () => {
    expect(sharePct(1, 3)).toBe("33%");
    expect(sharePct(0, 0)).toBe("–");
    expect(usd(1234.5)).toBe("$1,235");
    expect(usd(-12)).toBe("-$12");
  });
});
