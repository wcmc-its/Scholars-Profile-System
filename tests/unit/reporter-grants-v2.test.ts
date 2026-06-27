import { describe, expect, it } from "vitest";
import {
  candidatePredatesTerminalDegree,
  decideWriteOutcome,
  groupCandidatesByProfileId,
  hasDiscriminator,
  isFellowshipCore,
  isTerminalDegree,
  parseFirstLast,
  reconcileWithExisting,
  selectRunWindow,
  selectV2Cohort,
  summarizeCandidateGrants,
  terminalDegreeYear,
} from "@/etl/reporter-grants/v2";
import type { ReporterProject, ReporterPI } from "@/etl/nih-profile/fetcher";
import type { GroupedProject } from "@/etl/reporter-grants/transform";
import type { MatchResult, RankedCandidate } from "@/lib/edit/reporter-grants";

// These tests cover the unit-testable rows of spec §11 that need no network:
// candidate grouping by profile_id, the cohort filter, write-outcome decisioning
// (from a stubbed MatchResult), and idempotency. The RePORTER fetchers + Prisma
// writes live in index.ts's runReporterMatchV2 orchestration (v1's untested-main
// pattern) — the decision logic under test here is pure, so no mocking is needed
// and no real network call is made.

const pi = (over: Partial<ReporterPI>): ReporterPI => ({
  profile_id: 100,
  first_name: "Jane",
  middle_name: null,
  last_name: "Smith",
  full_name: "Jane Smith",
  is_contact_pi: true,
  title: null,
  ...over,
});

const project = (over: Partial<ReporterProject>): ReporterProject => ({
  appl_id: 1,
  core_project_num: "R01CA000001",
  project_end_date: "2023-08-31",
  principal_investigators: [pi({})],
  ...over,
});

describe("groupCandidatesByProfileId (spec §11 #13 — candidate grouping by profile_id)", () => {
  it("groups a scholar's matching PIs by profile_id, unioning core_project_nums", () => {
    const groups = groupCandidatesByProfileId("Jane A Smith", [
      project({ core_project_num: "R01CA000001", principal_investigators: [pi({ profile_id: 100 })] }),
      project({ core_project_num: "R01CA000002", principal_investigators: [pi({ profile_id: 100 })] }),
      project({ core_project_num: "K99MH000003", principal_investigators: [pi({ profile_id: 200, full_name: "Jane A Smith" })] }),
    ]);
    const byId = new Map(groups.map((g) => [g.profileId, g]));
    expect(byId.get(100)?.coreNums.sort()).toEqual(["R01CA000001", "R01CA000002"]);
    expect(byId.get(200)?.coreNums).toEqual(["K99MH000003"]);
  });

  it("drops PIs whose name does not match the scholar (co-PIs on the same project)", () => {
    const groups = groupCandidatesByProfileId("Jane Smith", [
      project({
        principal_investigators: [
          pi({ profile_id: 100, full_name: "Jane Smith" }),
          pi({ profile_id: 999, first_name: "Robert", last_name: "Jones", full_name: "Robert Jones" }),
        ],
      }),
    ]);
    expect(groups.map((g) => g.profileId)).toEqual([100]);
  });

  it("keeps the most complete matching name and ignores null cores", () => {
    const groups = groupCandidatesByProfileId("Jane Smith", [
      project({ core_project_num: null, principal_investigators: [pi({ profile_id: 100, full_name: "Jane Smith" })] }),
      project({ core_project_num: "R01CA000001", principal_investigators: [pi({ profile_id: 100, full_name: "Jane Adams Smith" })] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.fullName).toBe("Jane Adams Smith");
    expect(groups[0]!.coreNums).toEqual(["R01CA000001"]);
  });

  it("returns no candidates when the name search matches nobody (recall miss, §11 #2)", () => {
    const groups = groupCandidatesByProfileId("Aria van Besien", [
      project({ principal_investigators: [pi({ profile_id: 100, full_name: "Someone Else" })] }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe("selectV2Cohort (spec §11 #10 — active minus person_nih_profile)", () => {
  it("drops scholars already in person_nih_profile (v1's path)", () => {
    const active = [{ cwid: "aaa1001" }, { cwid: "bbb1002" }, { cwid: "ccc1003" }];
    const cohort = selectV2Cohort(active, new Set(["bbb1002"]));
    expect(cohort.map((s) => s.cwid)).toEqual(["aaa1001", "ccc1003"]);
  });

  it("returns everyone when none are profiled", () => {
    const active = [{ cwid: "aaa1001" }];
    expect(selectV2Cohort(active, new Set())).toHaveLength(1);
  });
});

describe("hasDiscriminator (spec §11 #1 — 0 trusted PMIDs skipped)", () => {
  it("skips a scholar with no trusted PMIDs and admits one with ≥1", () => {
    expect(hasDiscriminator(0)).toBe(false);
    expect(hasDiscriminator(1)).toBe(true);
    expect(hasDiscriminator(42)).toBe(true);
  });

  it("honors a higher min-PMID floor and never admits 0 (floor clamped to 1)", () => {
    expect(hasDiscriminator(2, 3)).toBe(false);
    expect(hasDiscriminator(3, 3)).toBe(true);
    expect(hasDiscriminator(0, 0)).toBe(false); // min floored to 1
    expect(hasDiscriminator(1, 0)).toBe(true);
  });
});

describe("selectRunWindow (handoff #1 — per-run cap, day-rotating coverage)", () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ cwid: `c${String(i).padStart(2, "0")}` }));

  it("returns the whole cohort when it fits the cap or the cap is disabled", () => {
    const cohort = make(2);
    expect(selectRunWindow(cohort, 5, 10)).toHaveLength(2);
    expect(selectRunWindow(cohort, 0, 10)).toHaveLength(2); // 0 ⇒ no cap
    expect(selectRunWindow(cohort, -1, 10)).toHaveLength(2);
  });

  it("covers every scholar exactly once over a full rotation, ≤ cap per run", () => {
    const cohort = make(23);
    const cap = 5;
    const numWindows = Math.ceil(23 / cap); // 5
    const seen = new Set<string>();
    for (let day = 0; day < numWindows; day++) {
      const run = selectRunWindow(cohort, cap, day);
      expect(run.length).toBeLessThanOrEqual(cap);
      for (const s of run) {
        expect(seen.has(s.cwid)).toBe(false); // no dup within the cycle
        seen.add(s.cwid);
      }
    }
    expect(seen.size).toBe(23); // full coverage, no gaps
  });

  it("wraps deterministically (day N and day N+numWindows pick the same window)", () => {
    const cohort = make(23);
    expect(selectRunWindow(cohort, 5, 1)).toEqual(selectRunWindow(cohort, 5, 6));
  });
});

const ranked = (profileId: number, overlap: number): RankedCandidate => ({
  profileId,
  fullName: `pid${profileId}`,
  orgs: [],
  overlap,
  precision: 1,
});

const matchResult = (over: Partial<MatchResult>): MatchResult => ({
  autoLock: null,
  suggestions: [],
  ranked: [],
  ...over,
});

describe("decideWriteOutcome (spec §11 #3/#4/#5 — autoLock vs pending vs none)", () => {
  it("auto-locks when rankByPmidOverlap returns an autoLock (#5, K≥3)", () => {
    const out = decideWriteOutcome(matchResult({ autoLock: 100, ranked: [ranked(100, 4)] }));
    expect(out).toEqual({ kind: "autolock", profileId: 100 });
  });

  it("proposes the top suggestion when there is no auto-lock (#4, K=2)", () => {
    const out = decideWriteOutcome(
      matchResult({ autoLock: null, suggestions: [ranked(100, 2)], ranked: [ranked(100, 2), ranked(200, 0)] }),
    );
    expect(out).toEqual({ kind: "pending", profileId: 100 });
  });

  it("proposes nothing on an ambiguous result — no autoLock, no suggestions (#3)", () => {
    const out = decideWriteOutcome(matchResult({ autoLock: null, suggestions: [] }));
    expect(out).toEqual({ kind: "none" });
  });
});

describe("reconcileWithExisting (spec §11 #7/#8/#9 — idempotency / no resurrection)", () => {
  it("never resurrects a rejected candidate (#7/#9)", () => {
    expect(reconcileWithExisting({ kind: "autolock", profileId: 100 }, "rejected")).toEqual({ kind: "skip" });
    expect(reconcileWithExisting({ kind: "pending", profileId: 100 }, "rejected")).toEqual({ kind: "skip" });
  });

  it("never resurrects a revoked candidate (#8/#9)", () => {
    expect(reconcileWithExisting({ kind: "autolock", profileId: 100 }, "revoked")).toEqual({ kind: "skip" });
    expect(reconcileWithExisting({ kind: "pending", profileId: 100 }, "revoked")).toEqual({ kind: "skip" });
  });

  it("never overwrites a human/system confirmed row with a system re-run", () => {
    expect(reconcileWithExisting({ kind: "autolock", profileId: 100 }, "confirmed")).toEqual({ kind: "skip" });
    expect(reconcileWithExisting({ kind: "pending", profileId: 100 }, "confirmed")).toEqual({ kind: "skip" });
  });

  it("auto-locks a brand-new candidate and refreshes a still-pending one", () => {
    expect(reconcileWithExisting({ kind: "autolock", profileId: 100 }, undefined)).toEqual({ kind: "autolock-confirm" });
    expect(reconcileWithExisting({ kind: "pending", profileId: 100 }, undefined)).toEqual({ kind: "pending-upsert" });
    expect(reconcileWithExisting({ kind: "pending", profileId: 100 }, "pending")).toEqual({ kind: "pending-upsert" });
    // A still-pending row that now clears K≥3 upgrades to a confirm.
    expect(reconcileWithExisting({ kind: "autolock", profileId: 100 }, "pending")).toEqual({ kind: "autolock-confirm" });
  });

  it("a 'none' outcome is always a no-op, leaving any existing row untouched", () => {
    expect(reconcileWithExisting({ kind: "none" }, undefined)).toEqual({ kind: "skip" });
    expect(reconcileWithExisting({ kind: "none" }, "pending")).toEqual({ kind: "skip" });
  });
});

const grouped = (over: Partial<GroupedProject>): GroupedProject => ({
  coreProjectNum: "R01CA000001",
  awardNumber: "5R01CA000001-03",
  orgName: "STANFORD UNIVERSITY",
  title: "A prior-institution study",
  startDate: new Date("2015-09-01"),
  endDate: new Date("2019-08-31"),
  maxFiscalYear: 2018,
  awardAmount: 100000,
  ...over,
});

describe("summarizeCandidateGrants (card-summary fields for the ReporterProfileCandidate row)", () => {
  it("counts net-new grants, joins distinct orgs, and samples most-recent-first", () => {
    const summary = summarizeCandidateGrants(
      [
        grouped({ coreProjectNum: "R01CA000001", endDate: new Date("2019-08-31"), orgName: "STANFORD UNIVERSITY" }),
        grouped({ coreProjectNum: "R01CA000002", endDate: new Date("2023-08-31"), startDate: new Date("2020-09-01"), orgName: "STANFORD UNIVERSITY", title: "Newer study" }),
      ],
      [], // no InfoEd grants → everything is net-new
    );
    expect(summary.grantCount).toBe(2);
    expect(summary.candidateOrgs).toBe("STANFORD UNIVERSITY");
    expect(summary.sampleGrants[0]).toEqual({ title: "Newer study", startYear: 2020, endYear: 2023 });
    expect(summary.sampleGrants).toHaveLength(2);
  });

  it("excludes grants already covered by InfoEd from the count", () => {
    const summary = summarizeCandidateGrants(
      [grouped({ coreProjectNum: "R01CA000001", awardNumber: "5R01CA000001-03" })],
      [{ awardNumber: "5 R01 CA000001-01" }], // same core already in InfoEd
    );
    expect(summary.grantCount).toBe(0);
    expect(summary.sampleGrants).toHaveLength(0);
  });

  it("caps the sample list at three", () => {
    const summary = summarizeCandidateGrants(
      [1, 2, 3, 4].map((n) =>
        grouped({ coreProjectNum: `R01CA00000${n}`, awardNumber: `5R01CA00000${n}-01`, endDate: new Date(`201${n}-08-31`) }),
      ),
      [],
    );
    expect(summary.grantCount).toBe(4);
    expect(summary.sampleGrants).toHaveLength(3);
  });
});

describe("parseFirstLast (name split for the pi_names query)", () => {
  it("splits first/last and strips postnominals", () => {
    expect(parseFirstLast("Maria T. Diaz-Meco, PhD")).toEqual({ firstName: "Maria", lastName: "Diaz-Meco" });
    expect(parseFirstLast("Cher")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("terminal-degree namesake guard (precision filter)", () => {
  const grant = (
    coreProjectNum: string,
    endYear: number | null,
  ): { coreProjectNum: string; endDate: Date | null } => ({
    coreProjectNum,
    endDate: endYear === null ? null : new Date(Date.UTC(endYear, 0, 1)),
  });

  it("isTerminalDegree recognizes doctorates, not masters/bachelors", () => {
    for (const d of ["PhD", "Ph.D.", "MD", "M.D.", "MD-PhD", "DO", "ScD", "DrPH", "DVM", "Doctor of Philosophy"]) {
      expect(isTerminalDegree(d), d).toBe(true);
    }
    for (const d of ["MS", "M.S.", "MPH", "BA", "BS", "MBA", "Bachelor of Science"]) {
      expect(isTerminalDegree(d), d).toBe(false);
    }
  });

  it("terminalDegreeYear takes the earliest dated doctorate; null when none", () => {
    expect(
      terminalDegreeYear([
        { degree: "MD", year: 2005 },
        { degree: "PhD", year: 2010 },
        { degree: "BS", year: 2000 },
      ]),
    ).toBe(2005);
    expect(terminalDegreeYear([{ degree: "MS", year: 2001 }, { degree: "BA", year: 1998 }])).toBeNull();
    expect(terminalDegreeYear([{ degree: "PhD", year: null }])).toBeNull();
    expect(terminalDegreeYear([])).toBeNull();
  });

  it("isFellowshipCore flags F-awards only", () => {
    for (const c of ["F30AI1", "F31GM1", "F32GM067403", "F33CA1"]) expect(isFellowshipCore(c)).toBe(true);
    for (const c of ["R01GM121772", "K08AI1", "DP2OD1", "U01HL1", "P30CA1"]) expect(isFellowshipCore(c)).toBe(false);
  });

  it("suppresses a namesake whose entire non-fellowship history predates the degree", () => {
    // older same-name PI: R-grants ending 1995–1997, scholar's PhD 2010
    expect(candidatePredatesTerminalDegree([grant("R01CA058514", 1997), grant("R29CA1", 1995)], 2010)).toBe(true);
  });

  it("keeps a real match with non-fellowship grants after the degree (Reck-Peterson shape)", () => {
    // F32 2005 (excluded) + R01s through 2022; PhD 2002 → keep
    expect(
      candidatePredatesTerminalDegree([grant("F32GM067403", 2005), grant("R01GM121772", 2022)], 2002),
    ).toBe(false);
  });

  it("never suppresses a fellowship-only candidate (no dated non-fellowship grant)", () => {
    expect(candidatePredatesTerminalDegree([grant("F31GM1", 2008), grant("F32GM2", 2011)], 2015)).toBe(false);
  });

  it("undated non-fellowship grants don't trigger suppression", () => {
    expect(candidatePredatesTerminalDegree([grant("R01GM1", null)], 2010)).toBe(false);
  });
});
