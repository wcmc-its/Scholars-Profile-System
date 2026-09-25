/**
 * Report 5's pure half (`lib/edit/clinical-trials-report.ts`): phase and
 * status buckets, the one params parser, grouping by protocol number, the
 * filters, the per-member roll-up, the totals, the download note and the
 * Criteria rows. Also the workbook (`lib/edit/clinical-trials-xlsx.ts`):
 * Trials always ships with PI names, Investigators is withheld above
 * SCHOLAR_EXPORT_CAP. Fixture people and trials are invented.
 */
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import type { ClinicalTrialsReportRow } from "@/lib/center-collaboration/clinical-trials-report";
import {
  CLINICAL_TRIALS_DEFAULTS,
  clinicalTrialsDownloadNote,
  clinicalTrialsQueryString,
  clinicalTrialsTotals,
  describeClinicalTrialsCriteria,
  filterTrials,
  groupTrials,
  parseClinicalTrialsParams,
  phaseKey,
  phaseLabel,
  summarizeMembers,
  trialStatusKey,
  trialStatusLabel,
} from "@/lib/edit/clinical-trials-report";
import { buildClinicalTrialsWorkbook } from "@/lib/edit/clinical-trials-xlsx";

function row(over: Partial<ClinicalTrialsReportRow>): ClinicalTrialsReportRow {
  return {
    cwid: "aaa1001",
    personName: "Ada Anders",
    department: "Medicine",
    role: "Principal Investigator",
    protocolNumber: "P-1",
    nctNumber: "NCT00000001",
    title: "A study",
    phase: "PHASE2",
    principalSponsor: "Acme Pharma",
    status: "OPEN TO ACCRUAL",
    isActive: true,
    ...over,
  };
}

const ROWS = [
  row({
    protocolNumber: "P-1",
    title: "Beta trial",
    status: "OPEN TO ACCRUAL",
    phase: "PHASE1; PHASE2",
  }),
  row({
    protocolNumber: "P-2",
    title: "Alpha trial",
    status: "SUSPENDED",
    nctNumber: null,
    phase: null,
  }),
  row({
    protocolNumber: "P-3",
    title: "Gamma trial",
    status: "IRB STUDY CLOSURE",
    cwid: "bbb2002",
    personName: "Bo Brandt",
    department: null,
    principalSponsor: "Weill Cornell Medical College",
    phase: "NA",
  }),
  row({
    protocolNumber: "P-4",
    title: "Delta trial",
    status: "CLOSED TO ACCRUAL",
    phase: "PHASE3",
    nctNumber: "NCT00000004",
  }),
];

describe("phase and status buckets", () => {
  it.each([
    ["PHASE1; PHASE2", "1/2"],
    ["Phase 1/Phase 2", "1/2"],
    ["PHASE2", "2"],
    ["PHASE2; PHASE3", "2/3"],
    ["EARLY_PHASE1", "early1"],
    ["PHASE4", "4"],
    ["NA", "na"],
    ["N/A", "na"],
    [null, "nr"],
    ["", "nr"],
  ])("phaseKey(%s) = %s", (raw, key) => {
    expect(phaseKey(raw)).toBe(key);
  });

  it("labels an unusual combination by its digits", () => {
    expect(phaseLabel(phaseKey("PHASE1; PHASE3"))).toBe("Phase 1/3");
    expect(phaseLabel("nr")).toBe("Not reported");
  });

  it("maps all four OnCore statuses to their labels", () => {
    expect(trialStatusLabel("OPEN TO ACCRUAL")).toBe("Open to accrual");
    expect(trialStatusLabel("CLOSED TO ACCRUAL")).toBe("Closed to accrual");
    expect(trialStatusLabel("IRB STUDY CLOSURE")).toBe("Closed (IRB study closure)");
    expect(trialStatusLabel("SUSPENDED")).toBe("Temporarily suspended");
    expect(trialStatusKey("Recruiting")).toBe("other");
    expect(trialStatusLabel("Recruiting")).toBe("Recruiting");
    expect(trialStatusLabel(null)).toBe("Status not reported");
  });
});

describe("parseClinicalTrialsParams / clinicalTrialsQueryString", () => {
  it("reads view, q, status and phase, and ignores unknown values", () => {
    expect(
      parseClinicalTrialsParams(
        new URLSearchParams("view=members&q=%20lung%20&status=suspended&phase=1/2"),
      ),
    ).toEqual({
      view: "members",
      q: "lung",
      status: "suspended",
      phase: "1/2",
    });
    expect(
      parseClinicalTrialsParams(new URLSearchParams("view=x&status=bogus&phase=9&role=pi")),
    ).toEqual(CLINICAL_TRIALS_DEFAULTS);
  });

  it("round-trips, leaves defaults out, and drops the view for the download", () => {
    const p = parseClinicalTrialsParams(
      new URLSearchParams("view=members&q=lung&status=open&phase=2"),
    );
    expect(parseClinicalTrialsParams(new URLSearchParams(clinicalTrialsQueryString(p)))).toEqual(p);
    expect(clinicalTrialsQueryString(p, false)).toBe("q=lung&status=open&phase=2");
    expect(clinicalTrialsQueryString(CLINICAL_TRIALS_DEFAULTS)).toBe("");
  });
});

describe("groupTrials / filterTrials", () => {
  it("folds links into one trial per protocol number, open first, then by title", () => {
    const trials = groupTrials([
      ...ROWS,
      row({ protocolNumber: "P-1", cwid: "ccc3003", personName: "Cy Chen", title: "Beta trial" }),
      row({ protocolNumber: "P-1", title: "Beta trial" }), // duplicate link
    ]);
    expect(trials.map((t) => t.protocolNumber)).toEqual(["P-1", "P-2", "P-4", "P-3"]);
    expect(trials[0].members.map((m) => m.cwid)).toEqual(["aaa1001", "ccc3003"]);
    expect(trials[0].phaseKey).toBe("1/2");
  });

  it("keeps suspended trials, and each filter narrows", () => {
    const trials = groupTrials(ROWS);
    expect(trials.some((t) => t.statusKey === "suspended")).toBe(true);
    const f = (qs: string) =>
      filterTrials(trials, parseClinicalTrialsParams(new URLSearchParams(qs))).map(
        (t) => t.protocolNumber,
      );
    expect(f("status=suspended")).toEqual(["P-2"]);
    expect(f("status=irb")).toEqual(["P-3"]);
    expect(f("phase=nr")).toEqual(["P-2"]);
    expect(f("phase=na")).toEqual(["P-3"]);
    expect(f("q=brandt")).toEqual(["P-3"]); // member name
    expect(f("q=weill")).toEqual(["P-3"]); // sponsor
    expect(f("q=nct00000004")).toEqual(["P-4"]); // NCT
    expect(f("q=delta")).toEqual(["P-4"]); // title
    expect(f("q=p-2")).toEqual(["P-2"]); // protocol number
    expect(f("status=open&phase=3")).toEqual([]);
  });
});

describe("summarizeMembers / totals / note / criteria", () => {
  const trials = groupTrials(ROWS);

  it("counts trials as PI and open-to-accrual trials per member, most first", () => {
    const members = summarizeMembers(trials);
    expect(members.map((m) => [m.cwid, m.asPi, m.open, m.trials.length])).toEqual([
      ["aaa1001", 3, 1, 3],
      ["bbb2002", 1, 0, 1],
    ]);
    expect(members[1].department).toBeNull();
  });

  it("totals trials, members, links, open and registered", () => {
    expect(clinicalTrialsTotals(trials)).toEqual({
      trials: 4,
      members: 2,
      links: 4,
      open: 1,
      registered: 3,
    });
  });

  it("says the Investigators sheet is left out only above the cap", () => {
    expect(clinicalTrialsDownloadNote(50, 50).withheld).toBe(false);
    const over = clinicalTrialsDownloadNote(51, 50);
    expect(over.withheld).toBe(true);
    expect(over.text).toContain("Investigators sheet is left out above 50 people (51 match)");
  });

  it("states every filter, All when unset", () => {
    const at = new Date("2026-09-25T12:00:00Z");
    const rows = Object.fromEntries(
      describeClinicalTrialsCriteria(CLINICAL_TRIALS_DEFAULTS, "Test Center", at),
    );
    expect(rows).toMatchObject({
      Center: "Test Center",
      Search: "All",
      Status: "All",
      Phase: "All",
    });
    const set = Object.fromEntries(
      describeClinicalTrialsCriteria(
        { view: "trials", q: "lung", status: "irb", phase: "1/2" },
        "C",
        at,
      ),
    );
    expect(set).toMatchObject({
      Search: "lung",
      Status: "Closed (IRB study closure)",
      Phase: "Phase 1/2",
    });
  });
});

async function sheets(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const values = (name: string) =>
    (wb.getWorksheet(name)?.getSheetValues() ?? [])
      .filter(Boolean)
      .map((r) => (r as unknown[]).slice(1));
  return { names: wb.worksheets.map((w) => w.name), values };
}

describe("buildClinicalTrialsWorkbook", () => {
  const at = new Date("2026-09-25T12:00:00Z");

  it("writes Trials (PI names, Local only for no NCT), Investigators and Criteria", async () => {
    const { names, values } = await sheets(
      await buildClinicalTrialsWorkbook(
        groupTrials(ROWS),
        CLINICAL_TRIALS_DEFAULTS,
        "Test Center",
        at,
      ),
    );
    expect(names).toEqual(["Trials", "Investigators", "Criteria"]);
    const trials = values("Trials");
    expect(trials[0]).toContain("Principal investigator(s)");
    expect(trials).toHaveLength(5);
    const p2 = trials.find((r) => r[0] === "P-2")!;
    expect(p2[1]).toBe("Local only · no NCT");
    expect(p2[5]).toBe("Temporarily suspended");
    expect(p2[6]).toBe("Ada Anders");
    const inv = values("Investigators");
    expect(inv[0]).toEqual([
      "CWID",
      "Name",
      "Department",
      "Trials as PI",
      "Open to accrual",
      "Protocol numbers",
    ]);
    expect(inv).toHaveLength(3);
  });

  it("ships the Investigators sheet at exactly SCHOLAR_EXPORT_CAP people", async () => {
    const many = Array.from({ length: SCHOLAR_EXPORT_CAP }, (_, i) =>
      row({ protocolNumber: `P-${i}`, cwid: `x${i}`, personName: `Person ${i}` }),
    );
    const { values } = await sheets(
      await buildClinicalTrialsWorkbook(
        groupTrials(many),
        CLINICAL_TRIALS_DEFAULTS,
        "Test Center",
        at,
      ),
    );
    const inv = values("Investigators");
    expect(inv).toHaveLength(SCHOLAR_EXPORT_CAP + 1);
    expect(inv[0][0]).toBe("CWID");
  });

  it("withholds the Investigators sheet above SCHOLAR_EXPORT_CAP but still ships every trial", async () => {
    const many = Array.from({ length: SCHOLAR_EXPORT_CAP + 1 }, (_, i) =>
      row({ protocolNumber: `P-${i}`, cwid: `x${i}`, personName: `Person ${i}` }),
    );
    const { values } = await sheets(
      await buildClinicalTrialsWorkbook(
        groupTrials(many),
        CLINICAL_TRIALS_DEFAULTS,
        "Test Center",
        at,
      ),
    );
    expect(values("Trials")).toHaveLength(SCHOLAR_EXPORT_CAP + 2);
    const inv = values("Investigators");
    expect(inv).toHaveLength(1);
    expect(String(inv[0][0])).toContain(`${SCHOLAR_EXPORT_CAP + 1} people match`);
  });
});
