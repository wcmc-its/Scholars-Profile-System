import { describe, expect, it } from "vitest";

import { observedDate, parseCsv, planSeed } from "@/scripts/backfills/2026-11-17-seed-vice-chairs";

const DEPTS = [
  { code: "N1", name: "Medicine", official_name: "Weill Department of Medicine", compact_name: null },
  { code: "N2", name: "Psychiatry", official_name: null, compact_name: null },
];
const PEOPLE = [
  { cwid: "aaa1001", preferred_name: "Ann B. Example", dept_code: "N1", role_category: "full_time_faculty" },
  { cwid: "bbb1002", preferred_name: "Sam Twin", dept_code: "N1", role_category: "full_time_faculty" },
  { cwid: "ccc1003", preferred_name: "Sam Twin", dept_code: "N2", role_category: "full_time_faculty" },
  { cwid: "ddd1004", preferred_name: "Sam Twin", dept_code: "N2", role_category: "full_time_faculty" },
  { cwid: "eee1005", preferred_name: "Pat Admin", dept_code: "N9", role_category: "non_academic" },
];
const HEADER = "Department,Name,Vice Chair title (as published),Tier,Source type,Source date,Reference URL,Notes,CWID";
const plan = (...lines: string[]) => planSeed(parseCsv([HEADER, ...lines].join("\n")), DEPTS, PEOPLE);

describe("parseCsv", () => {
  it("handles quoted commas, doubled quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([{ a: "x, y", b: 'say "hi"' }]);
  });
});

describe("observedDate", () => {
  it("accepts full and partial ISO dates only", () => {
    expect(observedDate("2026-06-03")).toBe("2026-06-03");
    expect(observedDate("2022-05")).toBe("2022-05-01");
    expect(observedDate("2026")).toBe("2026-01-01");
    expect(observedDate("current")).toBeNull();
    expect(observedDate("2025-26")).toBeNull();
  });
});

describe("planSeed", () => {
  it("resolves department (parenthetical stripped), person and normalized fields", () => {
    const [l] = plan(
      "Medicine (Weill Department of Medicine),Ann Example,Vice Chair of Research,Vice,Dept leadership page,current,https://example.org/l,",
    );
    expect(l.status).toBe("ok");
    expect(l.flags).toEqual([]);
    expect(l.rows).toEqual([
      {
        cwid: "aaa1001",
        entityId: "N1",
        tier: "vice",
        functions: "research",
        areaText: null,
        site: null,
        displayTitle: "Vice Chair of Research",
        sourceUrl: "https://example.org/l",
        sourceObservedAt: null,
        note: null,
      },
    ]);
  });

  it("makes two rows from a two-role title", () => {
    const [l] = plan('Medicine,Ann Example,"Vice Chair, Research; Vice Chair, Education",Vice,,,,');
    expect(l.rows.map((r) => [r.displayTitle, r.functions])).toEqual([
      ["Vice Chair, Research", "research"],
      ["Vice Chair, Education", "education"],
    ]);
  });

  it("breaks a name tie by department, and reports one it cannot break", () => {
    expect(plan("Medicine,Sam Twin,Vice Chair,Vice,,,,")[0].rows[0].cwid).toBe("bbb1002");
    expect(plan("Psychiatry,Sam Twin,Vice Chair,Vice,,,,")[0].status).toBe("ambiguous_scholar");
    expect(plan("Psychiatry,Sam Twin,Vice Chair,Vice,,,,,ddd1004")[0].rows[0].cwid).toBe("ddd1004");
  });

  it("reports what it leaves out", () => {
    expect(plan("Astrology,Ann Example,Vice Chair,Vice,,,,")[0].status).toBe("no_department");
    expect(plan("Medicine,Nobody Here,Vice Chair,Vice,,,,")[0].status).toBe("no_scholar");
    expect(plan("Medicine,Ann Example,Chair,Vice,,,,")[0].status).toBe("no_vice_chair_title");
  });

  it("flags a non-full-time holder, a tier disagreement and a site from the note", () => {
    const [l] = plan(
      "Medicine,Pat Admin,\"Vice Chair, Weill Department of Medicine\",Executive (site),,,,Chief of Medicine at NYP/Queens",
    );
    expect(l.status).toBe("ok");
    expect(l.flags).toEqual([
      "not full-time faculty (non_academic)",
      "primary department differs",
      "tier: audit says executive, title reads vice",
    ]);
    expect(l.rows[0]).toMatchObject({ tier: "executive", site: "nyp_queens", functions: "" });
  });
});
