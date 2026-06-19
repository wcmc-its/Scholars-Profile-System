/**
 * Department / division faculty export lib — CSV builder + the member loaders
 * (extends #1102 to org units without a curated roster).
 *
 *  - buildFacultyCsv: header order, comma quoting, null cells;
 *  - department loader: active scholars by deptCode;
 *  - division loader: ED-only (divCode) vs manual (divCode ∪ DivisionMembership);
 *  - counts mirror the loaders.
 */
import { describe, expect, it, vi } from "vitest";

import {
  FACULTY_CSV_HEADERS,
  buildFacultyCsv,
  loadDepartmentRosterForExport,
  loadDivisionRosterForExport,
  countDepartmentRoster,
  countDivisionRoster,
  type FacultyExportClient,
} from "@/lib/edit/unit-faculty-export";

const SCHOLAR_ROW = {
  cwid: "abc1234",
  preferredName: "Jane Smith",
  primaryTitle: "Professor of Medicine",
  roleCategory: "full_time_faculty",
  department: { name: "Medicine" },
  division: { name: "Cardiology" },
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
  it("emits the faculty header order, quotes commas, and blanks nulls", () => {
    const csv = buildFacultyCsv([
      {
        cwid: "abc1234",
        preferredName: "Smith, Jane",
        primaryTitle: null,
        roleCategory: "full_time_faculty",
        divisionName: null,
        departmentName: "Medicine",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(FACULTY_CSV_HEADERS.join(","));
    expect(lines[0]).not.toContain("email");
    expect(csv).toContain('"Smith, Jane"'); // comma quoted
    // null title + null division → empty cells: ...,full_time_faculty,,Medicine
    expect(lines[1]).toBe('abc1234,"Smith, Jane",,full_time_faculty,,Medicine');
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
      },
    ]);
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
