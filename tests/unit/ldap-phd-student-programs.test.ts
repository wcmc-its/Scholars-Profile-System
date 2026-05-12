import { describe, expect, it } from "vitest";

import {
  collapsePhdStudentProgramRecords,
  type EdPhdStudentProgramRecord,
} from "@/lib/sources/ldap";

function record(
  overrides: Partial<EdPhdStudentProgramRecord>,
): EdPhdStudentProgramRecord {
  return {
    cwid: "jog2042",
    program: "Immunology & Microbial Pathogenesis",
    programCode: "IMP",
    expectedGradYear: 2022,
    status: "student:expired",
    exitReason: "Graduated",
    startDate: new Date("2015-08-24Z"),
    endDate: new Date("2022-05-19Z"),
    ...overrides,
  };
}

describe("collapsePhdStudentProgramRecords (issue #195)", () => {
  it("returns a single row per CWID", () => {
    const collapsed = collapsePhdStudentProgramRecords([
      record({ cwid: "aaa1001" }),
      record({ cwid: "bbb1002", program: "Biochemistry" }),
    ]);
    expect(collapsed.size).toBe(2);
    expect(collapsed.get("aaa1001")?.program).toBe(
      "Immunology & Microbial Pathogenesis",
    );
    expect(collapsed.get("bbb1002")?.program).toBe("Biochemistry");
  });

  it("active rows beat expired ones regardless of date", () => {
    const expired2024 = record({
      status: "student:expired",
      endDate: new Date("2024-05-19Z"),
      program: "Old Program",
    });
    const activeNoEnd = record({
      status: "student:active",
      endDate: null,
      program: "New Program",
    });
    const collapsed = collapsePhdStudentProgramRecords([expired2024, activeNoEnd]);
    expect(collapsed.get("jog2042")?.program).toBe("New Program");
  });

  it("among expired rows the most recent endDate wins", () => {
    const older = record({
      endDate: new Date("2019-05-19Z"),
      program: "Older Program",
    });
    const newer = record({
      endDate: new Date("2022-05-19Z"),
      program: "Newer Program",
    });
    const collapsed = collapsePhdStudentProgramRecords([older, newer]);
    expect(collapsed.get("jog2042")?.program).toBe("Newer Program");
  });

  it("rows with no dates do not blow up", () => {
    const collapsed = collapsePhdStudentProgramRecords([
      record({ startDate: null, endDate: null, status: null }),
    ]);
    expect(collapsed.size).toBe(1);
  });
});
