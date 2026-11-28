/**
 * Report 26's grants and clinical trials (`lib/edit/translational-portfolio-activities.ts`):
 * which rows count, one award or trial once, the years each counts in, the
 * research-area filter, and the unit tallies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  suppressions: vi.fn(),
  areas: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      suppression: { findMany: h.suppressions },
      areaSignalTopic: { findMany: h.areas },
    },
  },
  prisma: {},
}));

import {
  grantProjectStage,
  loadPortfolioGrants,
  loadPortfolioTrials,
  tally,
  trialPhaseLabel,
  trialSpan,
  unitKeys,
  yearsActive,
  type ActivityScope,
} from "@/lib/edit/translational-portfolio-activities";

const SCOPE: ActivityScope = { from: 2020, to: 2026, units: [], insts: [], areas: [] };
const sqlOf = (q: { sql?: string; strings?: string[] }) => q.sql ?? q.strings?.join("?") ?? "";

const grant = (over: Record<string, unknown>) => ({
  id: "g",
  cwid: "aaa1001",
  title: "An example award",
  role: "PI",
  funder: "NCI",
  award_number: "1 R01 CA000001-01",
  external_id: "INFOED-100-aaa1001",
  intake_type: "Grant",
  start_date: new Date("2021-04-01T00:00:00Z"),
  end_date: new Date("2023-03-31T00:00:00Z"),
  area_text_key: null,
  dc: "N1",
  ...over,
});

const trial = (over: Record<string, unknown>) => ({
  protocol_number: "P-1",
  nct_number: "NCT00000001",
  title: "An example trial",
  phase: "PHASE2",
  status: "OPEN TO ACCRUAL",
  status_date: new Date("2021-05-01T00:00:00Z"),
  ctgov_status: "RECRUITING",
  start_date: "2021-06",
  start_date_type: "ACTUAL",
  primary_completion_date: null,
  primary_completion_date_type: null,
  first_ota_date: null,
  area_text_key: null,
  cwid: "aaa1001",
  role: "Principal Investigator",
  dc: "N1",
  ...over,
});

beforeEach(() => {
  h.queryRaw.mockReset();
  h.suppressions.mockReset().mockResolvedValue([]);
  h.areas.mockReset().mockResolvedValue([]);
});

describe("yearsActive", () => {
  it("clips a period to the window", () => {
    expect(yearsActive(2018, 2022, 2020, 2026)).toEqual([2020, 2021, 2022]);
    expect(yearsActive(2027, 2030, 2020, 2026)).toEqual([]);
  });
});

describe("trialSpan", () => {
  const base = {
    startDate: null,
    startDateType: null,
    primaryCompletionDate: null,
    primaryCompletionDateType: null,
    firstOtaDate: null,
    statusDate: null,
    status: null,
    ctgovStatus: null,
  };
  it("runs from the CT.gov start to the primary completion", () => {
    expect(trialSpan({ ...base, startDate: "2021-06", primaryCompletionDate: "2024-01-15" })).toEqual({ startYear: 2021, endYear: 2024 });
  });
  it("starts at the open-to-accrual date, then the status date, when CT.gov has no start", () => {
    expect(trialSpan({ ...base, firstOtaDate: new Date("2019-02-01T00:00:00Z") })?.startYear).toBe(2019);
    expect(trialSpan({ ...base, statusDate: new Date("2018-02-01T00:00:00Z") })?.startYear).toBe(2018);
    expect(trialSpan(base)).toBeNull();
  });
  it("is still running without a completion date, and ends at the status date once closed", () => {
    const open = { ...base, startDate: "2020-01", status: "OPEN TO ACCRUAL", statusDate: new Date("2022-01-01T00:00:00Z") };
    expect(trialSpan(open)).toEqual({ startYear: 2020, endYear: null });
    expect(trialSpan({ ...open, status: "IRB STUDY CLOSURE" })).toEqual({ startYear: 2020, endYear: 2022 });
    expect(trialSpan({ ...open, ctgovStatus: "COMPLETED" })).toEqual({ startYear: 2020, endYear: 2022 });
  });
  it("never ends before it starts", () => {
    expect(trialSpan({ ...base, startDate: "2023-01", primaryCompletionDate: "2021-01" })).toEqual({ startYear: 2023, endYear: 2023 });
  });
});

describe("trialPhaseLabel", () => {
  it("names the trial's own phase from the stored CT.gov value", () => {
    expect(trialPhaseLabel("PHASE1; PHASE2")).toBe("Phase 1/2");
    expect(trialPhaseLabel("PHASE3")).toBe("Phase 3");
    expect(trialPhaseLabel("EARLY_PHASE1")).toBe("Early phase 1");
    expect(trialPhaseLabel("NA")).toBe("Not applicable");
    expect(trialPhaseLabel(null)).toBeNull();
  });
});

describe("loadPortfolioGrants", () => {
  it("asks for leadership roles and funding program types of active scholars active in the window", async () => {
    h.queryRaw.mockResolvedValue([]);
    await loadPortfolioGrants({ ...SCOPE, units: ["dept:N1"] });
    const q = h.queryRaw.mock.calls[0][0];
    expect(sqlOf(q)).toMatch(/g\.role IN \(\?,\?,\?\)/);
    expect(sqlOf(q)).toMatch(/YEAR\(g\.start_date\) <= \? AND YEAR\(g\.end_date\) >= \?/);
    expect(sqlOf(q)).toMatch(/s\.deleted_at IS NULL AND s\.status = 'active'/);
    expect(q.values).toEqual(expect.arrayContaining(["PI", "PI-Subaward", "Co-PI", "Grant", "Career", "Contract with funding", "N1"]));
    expect(q.values).not.toContain("Co-I");
  });

  it("counts an award once: renewal years and co-PIs are one project, active in each year any row was", async () => {
    h.queryRaw.mockResolvedValue([
      grant({ id: "1", award_number: "1 UL1 TR000001-01", external_id: "INFOED-1-aaa1001", start_date: new Date("2018-07-01T00:00:00Z"), end_date: new Date("2021-06-30T00:00:00Z"), title: "Old title" }),
      grant({ id: "2", award_number: "2 UL1 TR000001-06", external_id: "INFOED-2-aaa1001", start_date: new Date("2023-07-01T00:00:00Z"), end_date: new Date("2028-06-30T00:00:00Z"), title: "New title" }),
      grant({ id: "3", cwid: "bbb2002", role: "Co-PI", award_number: "2 UL1 TR000001-06", external_id: "INFOED-2-bbb2002", start_date: new Date("2023-07-01T00:00:00Z"), end_date: new Date("2028-06-30T00:00:00Z"), dc: "N2" }),
    ]);
    const [g, ...rest] = await loadPortfolioGrants(SCOPE);
    expect(rest).toEqual([]);
    expect(g.key).toBe("UL1TR000001");
    expect(g.title).toBe("New title"); // the newest row names it
    expect(g.years).toEqual([2020, 2021, 2023, 2024, 2025, 2026]); // 2022 was a gap between periods
    expect([g.start, g.end]).toEqual(["2018-07-01", "2028-06-30"]);
    expect(g.people.map((x) => x.cwid)).toEqual(["aaa1001", "aaa1001", "bbb2002"]);
    expect(g.deptCodes.sort()).toEqual(["N1", "N2"]);
  });

  it("drops agreements and suppressed rows", async () => {
    h.queryRaw.mockResolvedValue([
      grant({ id: "1", external_id: "INFOED-1-aaa1001", award_number: "A-1", intake_type: "Incoming Material Transfer Agreement" }),
      grant({ id: "2", external_id: "INFOED-2-aaa1001", award_number: "A-2", intake_type: "Outgoing Consulting Agreement" }),
      grant({ id: "3", external_id: "INFOED-3-aaa1001", award_number: "A-3" }),
      grant({ id: "4", external_id: "INFOED-4-aaa1001", award_number: "A-4", intake_type: null }),
    ]);
    h.suppressions.mockResolvedValue([{ entityId: "INFOED-3-aaa1001" }]);
    const out = await loadPortfolioGrants(SCOPE);
    expect(out.map((g) => g.key)).toEqual(["4"]);
    expect(h.suppressions.mock.calls[0][0].where.entityId.in.sort()).toEqual(["INFOED-3-aaa1001", "INFOED-4-aaa1001"]);
  });

  it("under an area filter, keeps only the projects ReciterAI placed in a checked area, never an excluded one", async () => {
    h.queryRaw.mockResolvedValue([
      grant({ id: "1", external_id: "INFOED-1-aaa1001", award_number: "A-1", area_text_key: "k1" }),
      grant({ id: "2", external_id: "INFOED-2-aaa1001", award_number: "A-2", area_text_key: null }),
      grant({ id: "3", external_id: "INFOED-3-aaa1001", award_number: "A-3", area_text_key: "k3" }),
    ]);
    h.areas.mockResolvedValue([
      { textKey: "k1", parentTopicId: "a1" },
      { textKey: "k3", parentTopicId: "a2" },
    ]);
    const out = await loadPortfolioGrants({ ...SCOPE, areas: ["a1"] });
    expect(out.map((g) => [g.key, g.areas])).toEqual([["1", ["a1"]]]);
    expect(h.areas.mock.calls[0][0].where.score).toEqual({ gte: 0.3 });
  });
});

describe("loadPortfolioTrials", () => {
  it("asks for principal investigators only, and counts a trial once across protocol rows sharing an NCT", async () => {
    h.queryRaw.mockResolvedValue([
      trial({ protocol_number: "P-1" }),
      trial({ protocol_number: "P-2" }),
      trial({ protocol_number: "P-3", nct_number: "NCT00000003", status: "WITHDRAWN" }),
      trial({ protocol_number: "P-4", nct_number: "NCT00000004", status: "SUSPENDED" }),
    ]);
    const out = await loadPortfolioTrials(SCOPE, new Date("2026-11-28T00:00:00Z"));
    expect(h.queryRaw.mock.calls[0][0].values).toContain("Principal Investigator");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "NCT00000001", trialPhase: "Phase 2", startYear: 2021, endYear: null, years: [2021, 2022, 2023, 2024, 2025, 2026] });
    expect(out[0].people).toEqual([{ cwid: "aaa1001", role: "Principal Investigator" }]);
  });

  it("keys a trial with no NCT by its protocol number and dates it from the open-to-accrual date", async () => {
    h.queryRaw.mockResolvedValue([
      trial({ protocol_number: "P-9", nct_number: null, phase: null, start_date: null, first_ota_date: new Date("2017-03-01T00:00:00Z"), status: "IRB STUDY CLOSURE", status_date: new Date("2021-08-01T00:00:00Z") }),
      // Closed before the window: not counted.
      trial({ protocol_number: "P-8", nct_number: null, start_date: null, first_ota_date: new Date("2012-03-01T00:00:00Z"), status: "IRB STUDY CLOSURE", status_date: new Date("2015-08-01T00:00:00Z") }),
    ]);
    const out = await loadPortfolioTrials(SCOPE, new Date("2026-11-28T00:00:00Z"));
    expect(out.map((t) => [t.key, t.trialPhase, t.years])).toEqual([["P-9", null, [2020, 2021]]]);
  });
});

describe("tallies", () => {
  const items = [
    { years: [2021, 2022], people: [{ cwid: "a", role: "PI" }, { cwid: "b", role: "Co-PI" }], deptCodes: ["N1", "N2"], areas: ["x"] },
    { years: [2022], people: [{ cwid: "a", role: "PI" }, { cwid: "a", role: "PI" }], deptCodes: ["N1"], areas: [] },
  ];
  it("counts an item once per key, however many rows it has there", () => {
    expect(tally(items, (i) => i.years)).toEqual(new Map([["2021", 1], ["2022", 2]]));
    expect(tally(items, (i) => i.people.map((p) => p.cwid))).toEqual(new Map([["a", 2], ["b", 1]]));
    expect(tally(items, (i) => unitKeys(i, "dept", new Map()))).toEqual(new Map([["N1", 2], ["N2", 1]]));
  });
  it("groups by division or center through the investigators' memberships", () => {
    const m = new Map([["a", ["D1"]], ["b", ["D1", "D2"]]]);
    expect(tally(items, (i) => unitKeys(i, "div", m))).toEqual(new Map([["D1", 2], ["D2", 1]]));
  });
});

describe("trial stages from the trial phase", () => {
  it("maps every phase value prod holds by the strict rule, and nothing else", async () => {
    const { phaseKey } = await import("@/lib/edit/clinical-trials-report");
    const { trialStageFromPhaseKey } = await import("@/lib/translational-stage");
    const stage = (v: string | null) => trialStageFromPhaseKey(phaseKey(v));
    expect(stage("EARLY_PHASE1")).toBe("T1");
    expect(stage("PHASE1")).toBe("T1");
    expect(stage("PHASE1; PHASE2")).toBe("T2");
    expect(stage("PHASE2")).toBe("T2");
    expect(stage("PHASE2; PHASE3")).toBe("T2");
    expect(stage("PHASE3")).toBe("T2");
    expect(stage("PHASE4")).toBe("T3-4");
    expect(stage("NA")).toBeNull();
    expect(stage(null)).toBeNull();
    expect(stage("PHASE1; PHASE3")).toBeNull();
  });

  it("puts the stage on each trial and tallies trials by stage", async () => {
    h.queryRaw.mockResolvedValue([
      trial({ protocol_number: "P-1", nct_number: "NCT1", phase: "PHASE1" }),
      trial({ protocol_number: "P-2", nct_number: "NCT2", phase: "PHASE3" }),
      trial({ protocol_number: "P-3", nct_number: "NCT3", phase: "NA" }),
    ]);
    const out = await loadPortfolioTrials(SCOPE, new Date("2026-11-28T00:00:00Z"));
    expect(Object.fromEntries(out.map((t) => [t.key, t.stage]))).toEqual({ NCT1: "T1", NCT2: "T2", NCT3: null });
    const { stageCountsOfItems, stageTally } = await import("@/lib/edit/translational-portfolio-activities");
    expect(stageCountsOfItems(out)).toEqual({ T0: 0, T1: 1, T2: 1, "T3-4": 0, none: 1 });
    expect(stageTally(out, (t) => t.deptCodes).get("N1")).toEqual({ T0: 0, T1: 1, T2: 1, "T3-4": 0, none: 1 });
  });
});

describe("grant stages", () => {
  const row = (end: string, start: string, stage: string | null, conf: string | null = "high") => ({
    start_date: new Date(`${start}T00:00:00Z`),
    end_date: new Date(`${end}T00:00:00Z`),
    stage,
    stage_confidence: conf,
  });

  it("takes the most recent staged row: latest end date, then latest start date", () => {
    expect(grantProjectStage([row("2022-03-31", "2021-04-01", "T0"), row("2025-03-31", "2024-04-01", "T2")])).toBe("T2");
    expect(grantProjectStage([row("2025-03-31", "2024-04-01", "T2"), row("2022-03-31", "2021-04-01", "T0")])).toBe("T2");
    // Same end: the later start wins.
    expect(grantProjectStage([row("2025-03-31", "2020-04-01", "T0"), row("2025-03-31", "2023-04-01", "T3-4")])).toBe("T3-4");
  });

  it("skips a newer row with no displayed stage (low confidence, NA, title only), so an older staged row wins", () => {
    const old = row("2022-03-31", "2021-04-01", "T1");
    expect(grantProjectStage([old, row("2025-03-31", "2024-04-01", "T2", "low")])).toBe("T1");
    expect(grantProjectStage([old, row("2025-03-31", "2024-04-01", "NA")])).toBe("T1");
    expect(grantProjectStage([old, row("2025-03-31", "2024-04-01", null, null)])).toBe("T1");
  });

  it("is no stage when no row has a displayed one, and shows a stage with no confidence recorded", () => {
    expect(grantProjectStage([row("2025-03-31", "2024-04-01", "T2", "low"), row("2023-03-31", "2022-04-01", null, null)])).toBeNull();
    expect(grantProjectStage([])).toBeNull();
    expect(grantProjectStage([row("2025-03-31", "2024-04-01", "T0", null)])).toBe("T0");
  });

  it("reads the grant text's stage and puts the project's on each grant", async () => {
    h.queryRaw.mockResolvedValue([
      grant({ id: "1", start_date: new Date("2019-04-01T00:00:00Z"), end_date: new Date("2021-03-31T00:00:00Z"), stage: "T0", stage_confidence: "medium" }),
      grant({ id: "2", award_number: "5 R01 CA000001-03", start_date: new Date("2021-04-01T00:00:00Z"), end_date: new Date("2024-03-31T00:00:00Z"), stage: "T2", stage_confidence: "low" }),
      grant({ id: "3", award_number: "1 R21 CA000002-01", external_id: "INFOED-200-aaa1001", stage: null, stage_confidence: null }),
    ]);
    const out = await loadPortfolioGrants(SCOPE);
    expect(sqlOf(h.queryRaw.mock.calls[0][0])).toMatch(/LEFT JOIN area_signal_text ast ON ast\.text_key = g\.area_text_key/);
    // The R01's renewal is low confidence, so its older T0 row gives the project its stage; the title-only R21 has none.
    expect(out.map((g) => [g.awardNumber, g.stage])).toEqual([
      ["1 R21 CA000002-01", null],
      ["5 R01 CA000001-03", "T0"],
    ]);
  });
});
