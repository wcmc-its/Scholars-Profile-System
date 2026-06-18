/**
 * lib/edit/unit-roster-export — status derivation, CSV builder, row counting,
 * and the flag gate (#1102). The `status` column must match the Members-tab
 * `statusOf` in `center-roster-card.tsx`.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildUnitRosterCsv,
  countRosterCsvRows,
  isUnitRosterExportEnabled,
  rosterStatusOf,
  ROSTER_CSV_HEADERS,
} from "@/lib/edit/unit-roster-export";
import type { UnitEditContext } from "@/lib/api/unit-edit-context";

const TODAY = "2026-06-18";

function ctx(
  roster: UnitEditContext["roster"],
  programs: UnitEditContext["programs"] = [],
): UnitEditContext {
  return { roster, programs } as unknown as UnitEditContext;
}

describe("rosterStatusOf (mirrors center-roster-card statusOf)", () => {
  it("pending when start is in the future", () => {
    expect(rosterStatusOf({ startDate: "2999-01-01", endDate: null }, TODAY)).toBe("pending");
  });
  it("inactive when end is in the past", () => {
    expect(rosterStatusOf({ startDate: null, endDate: "2000-01-01" }, TODAY)).toBe("inactive");
  });
  it("active when no dates (nulls open)", () => {
    expect(rosterStatusOf({ startDate: null, endDate: null }, TODAY)).toBe("active");
  });
  it("active on the inclusive boundaries", () => {
    expect(rosterStatusOf({ startDate: TODAY, endDate: TODAY }, TODAY)).toBe("active");
  });
  it("pending wins over inactive when both apply (matches UI precedence)", () => {
    expect(rosterStatusOf({ startDate: "2999-01-01", endDate: "2000-01-01" }, TODAY)).toBe(
      "pending",
    );
  });
});

describe("buildUnitRosterCsv", () => {
  const roster = [
    {
      cwid: "a1",
      name: "Comma, Person",
      title: "Prof",
      source: "manual",
      membershipType: "research" as const,
      programCode: "CPC",
      startDate: null,
      endDate: null,
    },
    {
      cwid: "p1",
      name: "Pending",
      title: null,
      source: "ED",
      membershipType: null,
      programCode: null,
      startDate: "2999-01-01",
      endDate: null,
    },
  ];
  const programs = [
    { code: "CPC", label: "Cancer Prevention & Control", sortOrder: 0, description: null, leaders: [] },
  ];

  it("emits the #1102 header order with no email column", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY });
    const header = csv.split("\r\n")[0];
    expect(header).toBe(ROSTER_CSV_HEADERS.join(","));
    expect(header).not.toContain("email");
  });

  it("resolves program_label from the taxonomy and quotes commas in names", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY });
    expect(csv).toContain('"Comma, Person"');
    expect(csv).toContain("CPC,Cancer Prevention & Control");
  });

  it("includes pending + inactive by default", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY });
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 members
    expect(csv).toContain(",pending,ED");
  });

  it("activeOnly drops non-active rows", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY, activeOnly: true });
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2); // header + the one active member
    expect(csv).toContain("a1");
    expect(csv).not.toContain("p1");
  });

  it("manual-division shape (no programs) leaves program columns empty", () => {
    const divRoster = [
      {
        cwid: "d1",
        name: "Div Member",
        title: null,
        source: "manual",
        membershipType: null,
        programCode: null,
        startDate: null,
        endDate: null,
      },
    ];
    const csv = buildUnitRosterCsv(ctx(divRoster, []), { today: TODAY });
    expect(csv).toContain("d1,Div Member,,,,,,,active,manual");
  });

  it("handles a null roster (no members) → header only", () => {
    const csv = buildUnitRosterCsv(ctx(null, null), { today: TODAY });
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});

describe("countRosterCsvRows", () => {
  const roster = [
    { cwid: "a", name: "A", title: null, source: "manual", membershipType: null, programCode: null, startDate: null, endDate: null },
    { cwid: "p", name: "P", title: null, source: "manual", membershipType: null, programCode: null, startDate: "2999-01-01", endDate: null },
  ];
  it("counts all rows by default", () => {
    expect(countRosterCsvRows(ctx(roster), { today: TODAY })).toBe(2);
  });
  it("counts only active under activeOnly", () => {
    expect(countRosterCsvRows(ctx(roster), { today: TODAY, activeOnly: true })).toBe(1);
  });
});

describe("isUnitRosterExportEnabled (default off)", () => {
  const prev = process.env.EDIT_UNIT_ROSTER_EXPORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.EDIT_UNIT_ROSTER_EXPORT;
    else process.env.EDIT_UNIT_ROSTER_EXPORT = prev;
  });
  it("is off when unset", () => {
    delete process.env.EDIT_UNIT_ROSTER_EXPORT;
    expect(isUnitRosterExportEnabled()).toBe(false);
  });
  it("is on only for the exact 'on' value", () => {
    process.env.EDIT_UNIT_ROSTER_EXPORT = "true";
    expect(isUnitRosterExportEnabled()).toBe(false);
    process.env.EDIT_UNIT_ROSTER_EXPORT = "on";
    expect(isUnitRosterExportEnabled()).toBe(true);
  });
});
