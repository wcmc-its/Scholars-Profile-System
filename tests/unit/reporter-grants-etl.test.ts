import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  RECENCY_YEARS,
  buildReporterGrantRow,
  groupProjectsByCore,
  hasNameOnlyProfile,
  isWcmOrg,
  recencyShouldSuppress,
  unverifiedShouldSuppress,
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

describe("#3071 uncorroborated name-only default-hide", () => {
  it("treats a scholar as name-only when ANY profile row was resolved by name", () => {
    expect(hasNameOnlyProfile(["name_query"])).toBe(true);
    expect(hasNameOnlyProfile(["name_match"])).toBe(true);
    // Profiles are unioned, so one name-only row is enough to import a namesake.
    expect(hasNameOnlyProfile(["grant_join_contact", "name_query"])).toBe(true);
    expect(hasNameOnlyProfile(["grant_join_contact"])).toBe(false);
    expect(hasNameOnlyProfile(["grant_join_pi", "pmid-overlap-auto"])).toBe(false);
    expect(hasNameOnlyProfile([])).toBe(false);
  });

  it("hides a name-only award that nothing ties to the scholar", () => {
    expect(
      unverifiedShouldSuppress({
        nameOnlyProfile: true,
        wcmOrgHistory: false,
        publicationCorroborated: false,
      }),
    ).toBe(true);
  });

  it("keeps an award with any corroborating signal", () => {
    expect(
      unverifiedShouldSuppress({
        nameOnlyProfile: true,
        wcmOrgHistory: true,
        publicationCorroborated: false,
      }),
    ).toBe(false);
    expect(
      unverifiedShouldSuppress({
        nameOnlyProfile: true,
        wcmOrgHistory: false,
        publicationCorroborated: true,
      }),
    ).toBe(false);
  });

  it("never touches an award from a profile resolved by grant join", () => {
    expect(
      unverifiedShouldSuppress({
        nameOnlyProfile: false,
        wcmOrgHistory: false,
        publicationCorroborated: false,
      }),
    ).toBe(false);
  });

  it("sees WCM anywhere in the award's org history, not just its latest year", () => {
    const [g] = groupProjectsByCore([
      fyProj({ fiscal_year: 2012, org_name: "WEILL MEDICAL COLL OF CORNELL UNIV" }),
      fyProj({ fiscal_year: 2016, org_name: "UNIVERSITY OF ELSEWHERE" }),
    ]);
    expect(isWcmOrg(g!.orgName)).toBe(true);
    const [other] = groupProjectsByCore([
      fyProj({ fiscal_year: 2016, org_name: "UNIVERSITY OF ELSEWHERE" }),
    ]);
    expect(isWcmOrg(other!.orgName)).toBe(false);
  });
});

describe("groupProjectsByCore", () => {
  it("collapses fiscal years of one award: earliest start, latest end, max FY, summed amount", () => {
    const grouped = groupProjectsByCore([
      fyProj({ fiscal_year: 2018, appl_id: 1, project_start_date: "2018-09-01", project_end_date: "2019-08-31", award_amount: 50000 }),
      fyProj({ fiscal_year: 2020, appl_id: 2, project_start_date: "2020-09-01", project_end_date: "2023-08-31", award_amount: 70000 }),
    ]);
    expect(grouped).toHaveLength(1);
    const g = grouped[0]!;
    expect(g.coreProjectNum).toBe("R01CA245678");
    // most-recent-FY wins, same rule as awardNumber/title.
    expect(g.applId).toBe(2);
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
  applId: 1000001,
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

/**
 * Wiring. A mutation run deleted this call and left the suite green: the
 * mint is well pinned, but nothing asserted the reflect is ever CALLED, so
 * reverting the delivered payload of #2284 cost nothing. A source-text
 * assertion, because the call site lives inside `main()`. Comments are
 * stripped first, same as `tests/unit/etl-disconnect-guard.test.ts`: without
 * that this catches a deleted call but not a commented-out one.
 */
describe("the grant-suppression call site is wired into the RePORTER ETL", () => {
  const REPORTER = readFileSync(
    join(process.cwd(), "etl/reporter-grants/index.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("the recency default-hide reflects what it mints (#2284)", () => {
    expect(REPORTER).toContain("await reflectGrantSuppressions(minted)");
  });

  it("the #3071 unverified hide is flag-gated and reflected through the same minted batch", () => {
    expect(REPORTER).toContain(
      'process.env.REPORTER_GRANTS_CORROBORATION_HIDE === "on"',
    );
    // lastIndexOf: the first occurrence is the existing-hides read.
    const mintStart = REPORTER.lastIndexOf("createdBy: SYSTEM_UNVERIFIED");
    expect(mintStart).toBeGreaterThan(-1);
    const after = REPORTER.slice(mintStart, mintStart + 400);
    expect(after).toContain("minted.push(");
  });

  it("the #3071 corroboration read fails open on no PMIDs or a fetch error", () => {
    const fn = REPORTER.slice(REPORTER.indexOf("async function uncorroboratedRowIds"));
    expect(fn).toContain('if (pmids.size === 0) return "no-pmids"');
    expect(fn).toContain('return "fetch-error"');
    // Neither outcome may mint a hide: main() only judges rows on a Set result.
    expect(REPORTER).toContain('uncorroborated === "no-pmids"');
    expect(REPORTER).toContain('uncorroborated === "fetch-error"');
  });

  it("the v2 auto-lock write appends a B03 audit row, inside the same transaction", () => {
    const autolockStart = REPORTER.indexOf('action.kind === "autolock-confirm"');
    const autoLockedIncrement = REPORTER.indexOf("autoLocked++", autolockStart);
    expect(autolockStart).toBeGreaterThan(-1);
    expect(autoLockedIncrement).toBeGreaterThan(autolockStart);
    const autolockBlock = REPORTER.slice(autolockStart, autoLockedIncrement);
    // The audit call must be inside the SAME $transaction(async (tx) => {...})
    // as the person_nih_profile + reporterProfileCandidate writes, not a
    // separate call after it commits — appendAuditRow's atomicity contract.
    const txStart = autolockBlock.indexOf("$transaction(async (tx)");
    expect(txStart).toBeGreaterThan(-1);
    const txBlock = autolockBlock.slice(txStart);
    expect(txBlock).toContain("appendAuditRow(tx,");
    expect(txBlock).toContain('action: "reporter_profile_confirm"');
    expect(txBlock).toContain('actorCwid: "system-autolock"');
    expect(txBlock).toContain('targetEntityType: "reporter_profile_candidate"');
  });
});
