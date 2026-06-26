import { describe, expect, it } from "vitest";
import {
  RECENCY_YEARS,
  buildReporterGrantRow,
  groupProjectsByCore,
  recencyShouldSuppress,
  type GroupedProject,
} from "@/etl/reporter-grants/transform";
import type { ReporterGrantProject } from "@/etl/nih-profile/fetcher";

const fyProj = (over: Partial<ReporterGrantProject>): ReporterGrantProject => ({
  appl_id: 1,
  core_project_num: "R01CA245678",
  project_num: "5R01CA245678-03",
  fiscal_year: 2020,
  project_start_date: "2018-09-01",
  project_end_date: "2023-08-31",
  award_amount: 100000,
  org_name: "WEILL MEDICAL COLL OF CORNELL UNIV",
  project_title: "A study",
  ...over,
});

describe("recencyShouldSuppress", () => {
  it(`hides a grant whose last fiscal year is > ${RECENCY_YEARS}y old`, () => {
    // 2026 - 1999 = 27 > 25 → hide
    expect(recencyShouldSuppress(1999, 2026)).toBe(true);
  });

  it("shows a grant inside the window", () => {
    // 2026 - 2010 = 16 → show
    expect(recencyShouldSuppress(2010, 2026)).toBe(false);
  });

  it("treats the exact boundary as visible (strictly greater hides)", () => {
    // 2026 - 2001 = 25, not > 25 → show
    expect(recencyShouldSuppress(2001, 2026)).toBe(false);
    // 2026 - 2000 = 26 > 25 → hide
    expect(recencyShouldSuppress(2000, 2026)).toBe(true);
  });

  it("leaves an undatable grant (null fiscal year) visible", () => {
    expect(recencyShouldSuppress(null, 2026)).toBe(false);
  });
});

describe("groupProjectsByCore", () => {
  it("collapses fiscal years of one award: earliest start, latest end, max FY, summed amount", () => {
    const grouped = groupProjectsByCore([
      fyProj({ fiscal_year: 2018, project_start_date: "2018-09-01", project_end_date: "2019-08-31", award_amount: 50000 }),
      fyProj({ fiscal_year: 2020, project_start_date: "2020-09-01", project_end_date: "2023-08-31", award_amount: 70000 }),
    ]);
    expect(grouped).toHaveLength(1);
    const g = grouped[0]!;
    expect(g.coreProjectNum).toBe("R01CA245678");
    expect(g.startDate?.toISOString().slice(0, 10)).toBe("2018-09-01");
    expect(g.endDate?.toISOString().slice(0, 10)).toBe("2023-08-31");
    expect(g.maxFiscalYear).toBe(2020);
    expect(g.awardAmount).toBe(120000);
  });

  it("prefers a WCM org even when the most-recent fiscal year was at another org", () => {
    const grouped = groupProjectsByCore([
      fyProj({ fiscal_year: 2015, org_name: "WEILL MEDICAL COLL OF CORNELL UNIV" }),
      fyProj({ fiscal_year: 2019, org_name: "STANFORD UNIVERSITY" }),
    ]);
    expect(grouped[0]!.orgName).toMatch(/weill/i);
  });

  it("drops rows with no core_project_num and keeps distinct cores separate", () => {
    const grouped = groupProjectsByCore([
      fyProj({ core_project_num: null }),
      fyProj({ core_project_num: "R01CA245678" }),
      fyProj({ core_project_num: "K23HL157640", project_num: "5K23HL157640-01" }),
    ]);
    expect(grouped.map((g) => g.coreProjectNum).sort()).toEqual([
      "K23HL157640",
      "R01CA245678",
    ]);
  });
});

const grouped = (over: Partial<GroupedProject>): GroupedProject => ({
  coreProjectNum: "R01CA245678",
  awardNumber: "5R01CA245678-03",
  orgName: "STANFORD UNIVERSITY",
  title: "A study",
  startDate: new Date("2018-09-01"),
  endDate: new Date("2023-08-31"),
  maxFiscalYear: 2020,
  awardAmount: 120000,
  ...over,
});

describe("buildReporterGrantRow", () => {
  it("maps to a deterministic RePORTER Grant row with id === externalId", () => {
    const row = buildReporterGrantRow("abc1234", grouped({}));
    expect(row).not.toBeNull();
    expect(row!.id).toBe("reporter:abc1234:R01CA245678");
    expect(row!.externalId).toBe(row!.id);
    expect(row!.source).toBe("RePORTER");
    expect(row!.role).toBe("PI");
    expect(row!.awardNumber).toBe("5R01CA245678-03");
    expect(row!.programType).toBe("Grant");
  });

  it("derives mechanism + NIH IC + funder from the clean core_project_num", () => {
    const row = buildReporterGrantRow("abc1234", grouped({}));
    expect(row!.mechanism).toBe("R01");
    expect(row!.nihIc).toBe("NCI"); // CA prefix
    expect(row!.funder).toBe("NCI");
  });

  it("falls back to an untitled label and a generic NIH funder when unparseable", () => {
    const row = buildReporterGrantRow(
      "abc1234",
      grouped({ coreProjectNum: "XYZ9999999", title: "  " }),
    );
    expect(row!.title).toBe("(untitled grant XYZ9999999)");
    expect(row!.funder).toBe("NIH");
    expect(row!.nihIc).toBeNull();
  });

  it("returns null when the award has no usable project period (NOT NULL date columns)", () => {
    expect(buildReporterGrantRow("abc1234", grouped({ startDate: null }))).toBeNull();
    expect(buildReporterGrantRow("abc1234", grouped({ endDate: null }))).toBeNull();
  });
});
