/**
 * Department / division faculty export lib — CSV builder + the member loaders
 * (extends #1102 to org units without a curated roster).
 *
 *  - buildFacultyCsv: header order, comma quoting, null cells;
 *  - department loader: active scholars by deptCode;
 *  - division loader: ED-only (divCode) vs manual (divCode ∪ DivisionMembership);
 *  - counts mirror the loaders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FACULTY_CSV_HEADERS,
  buildFacultyCsv,
  countFacultyEmailsEmitted,
  loadDepartmentRosterForExport,
  loadDivisionRosterForExport,
  countDepartmentRoster,
  countDivisionRoster,
  type FacultyExportClient,
  type FacultyExportRow,
} from "@/lib/edit/unit-faculty-export";

const SCHOLAR_ROW = {
  cwid: "abc1234",
  preferredName: "Jane Smith",
  primaryTitle: "Professor of Medicine",
  roleCategory: "full_time_faculty",
  department: { name: "Medicine" },
  division: { name: "Cardiology" },
  email: "abc1234@med.cornell.edu",
};

function client(over?: {
  findMany?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  membershipFindMany?: ReturnType<typeof vi.fn>;
}): FacultyExportClient {
  return {
    scholar: {
      findMany: over?.findMany ?? vi.fn().mockResolvedValue([]),
      count: over?.count ?? vi.fn().mockResolvedValue(0),
    },
    divisionMembership: {
      findMany: over?.membershipFindMany ?? vi.fn().mockResolvedValue([]),
    },
  };
}

describe("buildFacultyCsv", () => {
  const prevGate = process.env.PROFILE_EMAIL_RELEASE_GATE;
  const prevSwitch = process.env.SCHOLAR_LIST_EXPORT_EMAIL;
  beforeEach(() => {
    process.env.SCHOLAR_LIST_EXPORT_EMAIL = "on";
  });
  afterEach(() => {
    if (prevGate === undefined) delete process.env.PROFILE_EMAIL_RELEASE_GATE;
    else process.env.PROFILE_EMAIL_RELEASE_GATE = prevGate;
    if (prevSwitch === undefined) delete process.env.SCHOLAR_LIST_EXPORT_EMAIL;
    else process.env.SCHOLAR_LIST_EXPORT_EMAIL = prevSwitch;
  });

  const row = (over: Partial<FacultyExportRow> = {}): FacultyExportRow => ({
    cwid: "abc1234",
    preferredName: "Smith, Jane",
    primaryTitle: null,
    roleCategory: "full_time_faculty",
    divisionName: null,
    departmentName: "Medicine",
    email: "abc1234@med.cornell.edu",
    ...over,
  });

  it("emits the faculty header order, quotes commas, and blanks nulls", () => {
    const csv = buildFacultyCsv([row()]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(FACULTY_CSV_HEADERS.join(","));
    expect(csv).toContain('"Smith, Jane"'); // comma quoted
    // null title + null division → empty cells; email is the trailing column.
    expect(lines[1]).toBe(
      'abc1234,"Smith, Jane",,full_time_faculty,,Medicine,abc1234@med.cornell.edu',
    );
  });

  it("appends email LAST so existing column indices do not shift", () => {
    expect(FACULTY_CSV_HEADERS.indexOf("email")).toBe(FACULTY_CSV_HEADERS.length - 1);
    expect(FACULTY_CSV_HEADERS.slice(0, -1)).toEqual([
      "cwid",
      "name",
      "title",
      "role_category",
      "division",
      "department",
    ]);
  });

  it("the release-code gate does NOT reach this surface, in EITHER position", () => {
    // Departments get every member's address on file. `none` is inferred from
    // missing ED data rather than chosen, so the filter was withholding on a data
    // gap. Both flag positions asserted: prod's OFF position fails open and would
    // mask a reinstated filter.
    for (const gate of ["on", "off"]) {
      process.env.PROFILE_EMAIL_RELEASE_GATE = gate;
      expect(buildFacultyCsv([row()]), `release gate ${gate}`).toContain(
        "abc1234@med.cornell.edu",
      );
    }
  });

  it("a hidden-display role still blanks the email (#536)", () => {
    const csv = buildFacultyCsv([row({ roleCategory: "doctoral_student_phd" })]);
    expect(csv).not.toContain("abc1234@med.cornell.edu");
  });

  it("SCHOLAR_LIST_EXPORT_EMAIL off blanks the email on this surface too", () => {
    delete process.env.SCHOLAR_LIST_EXPORT_EMAIL;
    const csv = buildFacultyCsv([row()]);
    expect(csv).not.toContain("abc1234@med.cornell.edu");
  });

  it("countFacultyEmailsEmitted counts post-carve, not row count", () => {
    const rows = [
      row({ cwid: "ok1" }),
      row({ cwid: "ok2" }),
      row({ cwid: "hid1", roleCategory: "doctoral_student_phd" }),
      row({ cwid: "nomail", email: null }),
    ];
    expect(rows).toHaveLength(4);
    expect(countFacultyEmailsEmitted(rows)).toBe(2);
  });
});

describe("loadDepartmentRosterForExport", () => {
  it("reads active scholars by deptCode and maps relation names", async () => {
    const findMany = vi.fn().mockResolvedValue([SCHOLAR_ROW]);
    const rows = await loadDepartmentRosterForExport(client({ findMany }), "N1280");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deptCode: "N1280", deletedAt: null, status: "active" } }),
    );
    expect(rows).toEqual([
      {
        cwid: "abc1234",
        preferredName: "Jane Smith",
        primaryTitle: "Professor of Medicine",
        roleCategory: "full_time_faculty",
        divisionName: "Cardiology",
        departmentName: "Medicine",
        email: "abc1234@med.cornell.edu",
      },
    ]);
    // The address must be SELECTED — a loader that drops it silently exports an
    // all-empty email column that looks like "nobody has an address on file".
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ email: true }),
      }),
    );
  });
});

describe("loadDivisionRosterForExport", () => {
  it("ED division: members are divCode scholars only (no DivisionMembership read)", async () => {
    const membershipFindMany = vi.fn();
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ cwid: "m1" }]) // divisionMemberCwids (select cwid)
      .mockResolvedValueOnce([SCHOLAR_ROW]); // full rows by cwid
    const rows = await loadDivisionRosterForExport(client({ findMany, membershipFindMany }), "D1", "ED");
    expect(membershipFindMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { cwid: { in: ["m1"] }, deletedAt: null, status: "active" } }),
    );
    expect(rows).toHaveLength(1);
  });

  it("manual division: unions divCode scholars with the DivisionMembership roster", async () => {
    const membershipFindMany = vi.fn().mockResolvedValue([{ cwid: "m2" }, { cwid: "m1" }]);
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ cwid: "m1" }]) // ED leg
      .mockResolvedValueOnce([SCHOLAR_ROW, { ...SCHOLAR_ROW, cwid: "m2" }]); // full rows
    await loadDivisionRosterForExport(client({ findMany, membershipFindMany }), "D1", "manual");
    expect(membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { divisionCode: "D1" } }),
    );
    const fullCall = findMany.mock.calls[1][0] as { where: { cwid: { in: string[] } } };
    expect(new Set(fullCall.where.cwid.in)).toEqual(new Set(["m1", "m2"])); // deduped union
  });

  it("returns [] when the division has no members", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]); // no ED members
    const rows = await loadDivisionRosterForExport(client({ findMany }), "D1", "ED");
    expect(rows).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1); // never fetched full rows
  });
});

describe("counts", () => {
  it("countDepartmentRoster counts active scholars by deptCode", async () => {
    const count = vi.fn().mockResolvedValue(248);
    expect(await countDepartmentRoster(client({ count }), "N1280")).toBe(248);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deptCode: "N1280", deletedAt: null, status: "active" } }),
    );
  });

  it("countDivisionRoster counts the active union for a manual division", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([{ cwid: "m1" }]);
    const membershipFindMany = vi.fn().mockResolvedValue([{ cwid: "m2" }]);
    const count = vi.fn().mockResolvedValue(2);
    const n = await countDivisionRoster(client({ findMany, membershipFindMany, count }), "D1", "manual");
    expect(n).toBe(2);
    const where = count.mock.calls[0][0] as { where: { cwid: { in: string[] } } };
    expect(new Set(where.where.cwid.in)).toEqual(new Set(["m1", "m2"]));
  });
});
