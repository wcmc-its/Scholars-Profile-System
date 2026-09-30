/**
 * lib/edit/unit-roster-export — status derivation, the row projection, row
 * counting, and the flag gate (#1102); lib/edit/unit-roster-xlsx — the .xlsx
 * workbook the route sends. The `status` column must match the Members-tab
 * `statusOf` in `center-roster-card.tsx`.
 *
 * The projection assertions read the rows through `toCsv` (header + rows,
 * comma-joined) so a whole row can be matched as one string.
 */
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toCsv } from "@/lib/csv";
import {
  buildUnitRosterRows,
  countRosterExportRows,
  isUnitRosterExportEnabled,
  loadRosterFacultyMeta,
  rosterStatusOf,
  ROSTER_EXPORT_HEADERS,
  type BuildRosterExportOptions,
  type RosterFacultyMeta,
} from "@/lib/edit/unit-roster-export";
import { buildUnitRosterXlsx } from "@/lib/edit/unit-roster-xlsx";
import type { UnitEditContext } from "@/lib/api/unit-edit-context";

const buildUnitRosterCsv = (c: UnitEditContext, o: BuildRosterExportOptions) =>
  toCsv(ROSTER_EXPORT_HEADERS, buildUnitRosterRows(c, o));

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
  it("invited for the #2779 Invited role, whatever its dates (matches the card badge)", () => {
    expect(
      rosterStatusOf({ startDate: null, endDate: null, membershipRoleKey: "invited" }, TODAY),
    ).toBe("invited");
    expect(
      rosterStatusOf(
        { startDate: "2999-01-01", endDate: "2000-01-01", membershipRoleKey: "invited" },
        TODAY,
      ),
    ).toBe("invited");
  });
  it("a non-invited role key (or a division's null key) keeps date-derived status", () => {
    expect(
      rosterStatusOf({ startDate: null, endDate: null, membershipRoleKey: "member" }, TODAY),
    ).toBe("active");
    expect(
      rosterStatusOf({ startDate: null, endDate: "2000-01-01", membershipRoleKey: null }, TODAY),
    ).toBe("inactive");
  });
  it("pending wins over inactive when both apply (matches UI precedence)", () => {
    expect(rosterStatusOf({ startDate: "2999-01-01", endDate: "2000-01-01" }, TODAY)).toBe(
      "pending",
    );
  });
});

describe("buildUnitRosterRows", () => {
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
      scholarState: "active" as const,
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
      scholarState: "active" as const,
    },
  ];
  const programs = [
    { code: "CPC", label: "Cancer Prevention & Control", sortOrder: 0, description: null, leaders: [] },
  ];

  it("emits the header order, now including the faculty block", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY });
    const header = csv.split("\r\n")[0];
    expect(header).toBe(ROSTER_EXPORT_HEADERS.join(","));
    expect(header).toContain("email,role_category,department,division");
    // Appended LAST (after scholar_state) so consumer indices did not shift.
    expect(header.endsWith(",scholar_state,institution")).toBe(true);
  });

  it("omitting facultyByCwid keeps the header stable and the block empty", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY });
    expect(csv.split("\r\n")[0]).toBe(ROSTER_EXPORT_HEADERS.join(","));
    // 4 trailing empties — column indices never shift under a consumer.
    expect(csv).toContain("active,manual,,,,");
  });

  it("resolves program_label from the taxonomy and keeps a comma'd name in one cell", () => {
    const rows = buildUnitRosterRows(ctx(roster, programs), { today: TODAY });
    expect(rows[0].slice(0, 6)).toEqual(["a1", "Comma, Person", "Prof", "research", "CPC", "Cancer Prevention & Control"]);
    expect(rows.every((r) => r.length === ROSTER_EXPORT_HEADERS.length)).toBe(true);
  });

  it("includes pending + inactive by default", () => {
    const csv = buildUnitRosterCsv(ctx(roster, programs), { today: TODAY });
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 members
    expect(csv).toContain(",pending,ED");
  });

  it("an invitee's status cell is `invited` (the card badge) and activeOnly drops it", () => {
    const invitee = {
      ...roster[0],
      cwid: "i1",
      name: "Invitee",
      membershipRoleKey: "invited",
    };
    const c = ctx([...roster, invitee], programs);
    const statusIdx = ROSTER_EXPORT_HEADERS.indexOf("status");
    const rows = buildUnitRosterRows(c, { today: TODAY });
    expect(rows.find((r) => r[0] === "i1")?.[statusIdx]).toBe("invited");
    const active = buildUnitRosterRows(c, { today: TODAY, activeOnly: true });
    expect(active.map((r) => r[0])).toEqual(["a1"]);
    expect(countRosterExportRows(c, { today: TODAY, activeOnly: true })).toBe(1);
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
        scholarState: "active" as const,
      },
    ];
    const csv = buildUnitRosterCsv(ctx(divRoster, []), { today: TODAY });
    expect(csv).toContain("d1,Div Member,,,,,,,active,manual,,,,");
  });

  it("emits scholar_state, including the status=active + departed pair", () => {
    // The audit case: the person left WCM but nobody closed out the membership,
    // so the DATE-derived `status` still reads active. Filtering the CSV on
    // `status` alone would never surface them — that pair is why the column
    // exists, and it must be reachable without supplying facultyByCwid.
    const mixed = [
      {
        cwid: "gone1",
        name: "Gone One",
        title: null,
        source: "manual",
        membershipType: null,
        programCode: null,
        startDate: null,
        endDate: null,
        scholarState: "departed" as const,
      },
      {
        cwid: "ghost1",
        name: "ghost1",
        title: null,
        source: "manual",
        membershipType: null,
        programCode: null,
        startDate: null,
        endDate: null,
        scholarState: "unknown" as const,
      },
    ];
    const csv = buildUnitRosterCsv(ctx(mixed, []), { today: TODAY });
    expect(csv.split("\r\n")[0]).toContain(",scholar_state,");
    // scholar_state is populated with no facultyByCwid; institution (last) is not.
    expect(csv).toContain("active,manual,,,,,departed,");
    expect(csv).toContain("active,manual,,,,,unknown,");
  });

  it("handles a null roster (no members) → header only", () => {
    const csv = buildUnitRosterCsv(ctx(null, null), { today: TODAY });
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});

describe("email column gating", () => {
  const prevGate = process.env.PROFILE_EMAIL_RELEASE_GATE;
  const prevSwitch = process.env.SCHOLAR_LIST_EXPORT_EMAIL;
  beforeEach(() => {
    // The operator kill switch is ON in staging + prod; these tests exercise the
    // carve BEHIND it, so default it on and pin it explicitly where it matters.
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "on";
  });
  afterEach(() => {
    if (prevGate === undefined) delete process.env.PROFILE_EMAIL_RELEASE_GATE;
    else process.env.PROFILE_EMAIL_RELEASE_GATE = prevGate;
    if (prevSwitch === undefined) delete process.env.SCHOLAR_LIST_EXPORT_EMAIL;
    else process.env.SCHOLAR_LIST_EXPORT_EMAIL = prevSwitch;
  });

  const member = (cwid: string) => ({
    cwid,
    name: cwid.toUpperCase(),
    title: null,
    source: "manual",
    membershipType: null,
    programCode: null,
    startDate: null,
    endDate: null,
    scholarState: "active" as const,
  });

  const meta = (over: Partial<RosterFacultyMeta> = {}): RosterFacultyMeta => ({
    email: "who@med.cornell.edu",
    roleCategory: "full_time_faculty",
    departmentName: "Medicine",
    divisionName: "Cardiology",
    institution: "Hospital for Special Surgery",
    ...over,
  });

  it("emits email + faculty metadata for a faculty member", () => {
    const csv = buildUnitRosterCsv(ctx([member("a1")], []), {
      today: TODAY,
      facultyByCwid: new Map([["a1", meta()]]),
    });
    expect(csv).toContain(
      "who@med.cornell.edu,full_time_faculty,Medicine,Cardiology,active,Hospital for Special Surgery",
    );
  });

  it("a member with no primary institution on file exports an empty institution cell", () => {
    const csv = buildUnitRosterCsv(ctx([member("a1")], []), {
      today: TODAY,
      facultyByCwid: new Map([["a1", meta({ institution: null })]]),
    });
    expect(csv).toContain("Medicine,Cardiology,active,\r\n");
  });

  it("the release-code gate does NOT reach this surface, in EITHER position", () => {
    // A unit-scoped /edit export deliberately skips the release-code filter: per
    // the SPEC, `none` is inferred from missing ED data, never chosen by anyone,
    // so filtering on it withheld addresses for a data gap. Asserted in BOTH flag
    // positions -- a one-position test would still pass if someone reinstated the
    // filter, since prod's OFF position fails open and looks identical.
    for (const gate of ["on", "off"]) {
      process.env.PROFILE_EMAIL_RELEASE_GATE = gate;
      const csv = buildUnitRosterCsv(ctx([member("a1")], []), {
        today: TODAY,
        facultyByCwid: new Map([["a1", meta()]]),
      });
      expect(csv, `release gate ${gate}`).toContain("who@med.cornell.edu");
    }
  });

  it("a hidden-display role still blanks the email (#536)", () => {
    process.env.PROFILE_EMAIL_RELEASE_GATE = "off";
    const csv = buildUnitRosterCsv(ctx([member("a1")], []), {
      today: TODAY,
      facultyByCwid: new Map([["a1", meta({ roleCategory: "doctoral_student_phd" })]]),
    });
    expect(csv).not.toContain("who@med.cornell.edu");
  });

  it("a member with no address on file exports an empty email cell", () => {
    const csv = buildUnitRosterCsv(ctx([member("a1")], []), {
      today: TODAY,
      facultyByCwid: new Map([["a1", meta({ email: null })]]),
    });
    expect(csv).toContain(",,full_time_faculty,Medicine,Cardiology");
  });

  it("SCHOLAR_LIST_EXPORT_EMAIL off blanks the email, keeping the other columns", () => {
    // The kill switch: pulling this flag stops the column WITHOUT a revert or a
    // code deploy. The faculty metadata is unaffected — only contact data goes.
    delete process.env.SCHOLAR_LIST_EXPORT_EMAIL;
    const csv = buildUnitRosterCsv(ctx([member("a1")], []), {
      today: TODAY,
      facultyByCwid: new Map([["a1", meta()]]),
    });
    expect(csv).not.toContain("who@med.cornell.edu");
    expect(csv).toContain(",,full_time_faculty,Medicine,Cardiology");
  });

  it("an external member with no Scholar row exports the block empty", () => {
    const csv = buildUnitRosterCsv(ctx([member("ext1")], []), {
      today: TODAY,
      facultyByCwid: new Map(),
    });
    expect(csv).toContain("active,manual,,,,");
  });
});

describe("loadRosterFacultyMeta", () => {
  it("issues no query for an empty roster", async () => {
    let called = false;
    const client = {
      scholar: {
        findMany: async () => {
          called = true;
          return [];
        },
      },
    };
    expect((await loadRosterFacultyMeta([], client)).size).toBe(0);
    expect(called).toBe(false);
  });

  it("dedupes cwids and flattens the dept/div relations", async () => {
    let seen: unknown = null;
    const client = {
      scholar: {
        findMany: async (args: unknown) => {
          seen = args;
          return [
            {
              cwid: "a1",
              email: "a1@med.cornell.edu",
              roleCategory: "full_time_faculty",
              department: { name: "Medicine" },
              division: null,
              primaryOrgCode: "WCMC",
            },
          ];
        },
      },
    };
    const map = await loadRosterFacultyMeta(["a1", "a1", ""], client);
    const args = seen as { where: { cwid: { in: string[] } }; select: Record<string, unknown> };
    expect(args.where.cwid.in).toEqual(["a1"]);
    // The code must be SELECTED, or every row exports an empty institution.
    expect(args.select.primaryOrgCode).toBe(true);
    expect(map.get("a1")).toEqual({
      email: "a1@med.cornell.edu",
      roleCategory: "full_time_faculty",
      departmentName: "Medicine",
      divisionName: null,
      // The home code is named, never echoed bare.
      institution: "Weill Cornell Medicine",
    });
  });
});

describe("countRosterExportRows", () => {
  const roster = [
    { cwid: "a", name: "A", title: null, source: "manual", membershipType: null, programCode: null, startDate: null, endDate: null, scholarState: "active" as const },
    { cwid: "p", name: "P", title: null, source: "manual", membershipType: null, programCode: null, startDate: "2999-01-01", endDate: null, scholarState: "active" as const },
  ];
  it("counts all rows by default", () => {
    expect(countRosterExportRows(ctx(roster), { today: TODAY })).toBe(2);
  });
  it("counts only active under activeOnly", () => {
    expect(countRosterExportRows(ctx(roster), { today: TODAY, activeOnly: true })).toBe(1);
  });
});

describe("buildUnitRosterXlsx", () => {
  const roster = [
    { cwid: "a1", name: "Comma, Person", title: "Prof", source: "manual", membershipType: "research" as const, programCode: "CPC", startDate: "2020-01-01", endDate: null, scholarState: "active" as const },
    { cwid: "p1", name: "Pending", title: null, source: "ED", membershipType: null, programCode: null, startDate: "2999-01-01", endDate: null, scholarState: "departed" as const },
  ];
  const programs = [
    { code: "CPC", label: "Cancer Prevention & Control", sortOrder: 0, description: null, leaders: [] },
  ];

  async function read(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb;
  }

  const values = (ws: ExcelJS.Worksheet, r: number) =>
    (ws.getRow(r).values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v)));

  it("one Roster sheet: the bold header row, then exactly the projected rows (same columns as the CSV)", async () => {
    const opts = { today: TODAY, facultyByCwid: new Map<string, RosterFacultyMeta>() };
    const wb = await read(await buildUnitRosterXlsx(ctx(roster, programs), opts));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Roster"]);
    const ws = wb.getWorksheet("Roster")!;
    expect(values(ws, 1)).toEqual([...ROSTER_EXPORT_HEADERS]);
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.rowCount).toBe(3);
    const expected = buildUnitRosterRows(ctx(roster, programs), opts);
    // Trailing empty cells don't round-trip, so compare up to each row's length.
    expect(values(ws, 2)).toEqual(expected[0].slice(0, values(ws, 2).length));
    expect(values(ws, 2).slice(0, 9)).toEqual(["a1", "Comma, Person", "Prof", "research", "CPC", "Cancer Prevention & Control", "2020-01-01", "", "active"]);
    expect(values(ws, 3)[8]).toBe("pending");
    expect(values(ws, 3)[14]).toBe("departed");
  });

  it("activeOnly narrows the workbook the same way", async () => {
    const wb = await read(await buildUnitRosterXlsx(ctx(roster, programs), { today: TODAY, activeOnly: true }));
    const ws = wb.getWorksheet("Roster")!;
    expect(ws.rowCount).toBe(2);
    expect(values(ws, 2)[0]).toBe("a1");
  });

  it("an empty roster is the header row alone", async () => {
    const wb = await read(await buildUnitRosterXlsx(ctx(null, null), { today: TODAY }));
    expect(wb.getWorksheet("Roster")!.rowCount).toBe(1);
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
