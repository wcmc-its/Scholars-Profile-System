/**
 * Report 5's `.xlsx` (`/api/edit/reports/clinical-trials`): Trials, then
 * Investigators, then Criteria, all for the filtered trial list.
 *
 * - Trials: one row per trial (protocol number), PI names included. Always
 *   shipped: it is a trial list, not a scholar export (decision D1, the same
 *   split as report 9's Publications sheet).
 * - Investigators: one row per member. A scholar list, so above
 *   `SCHOLAR_EXPORT_CAP` the sheet carries a one-line note instead of rows,
 *   never a truncated list.
 * - Criteria: every filter, "All" when unset.
 *
 * Server-only (exceljs, `@/lib/api/export-scholars`).
 */
import ExcelJS from "exceljs";

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  describeClinicalTrialsCriteria,
  phaseLabel,
  summarizeMembers,
  trialStatusLabel,
  type ClinicalTrialsParams,
  type TrialGroup,
} from "@/lib/edit/clinical-trials-report";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

const ctgovUrl = (nct: string) => `https://clinicaltrials.gov/study/${encodeURIComponent(nct)}`;

/** The line the Investigators sheet carries instead of its rows above the cap. */
export function investigatorsOverCapNote(members: number, cap = SCHOLAR_EXPORT_CAP): string {
  return `${members.toLocaleString()} people match. The investigators list is only included for ${cap} or fewer; narrow the filters to include it. The page's By member tab lists everyone.`;
}

export async function buildClinicalTrialsWorkbook(
  trials: ReadonlyArray<TrialGroup>,
  p: ClinicalTrialsParams,
  centerName: string,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = generatedAt;

  const ts = wb.addWorksheet("Trials");
  ts.addRow([
    "Protocol number",
    "NCT number",
    "Title",
    "Sponsor",
    "Phase",
    "Status",
    "Principal investigator(s)",
    "ClinicalTrials.gov",
  ]);
  boldRow(ts, 1);
  for (const t of trials) {
    ts.addRow([
      t.protocolNumber,
      t.nctNumber ?? "Local only · no NCT",
      t.title,
      t.sponsor ?? "",
      phaseLabel(t.phaseKey),
      trialStatusLabel(t.status),
      t.members.map((m) => m.name).join("; "),
      t.nctNumber ? ctgovUrl(t.nctNumber) : "",
    ]);
  }
  [18, 16, 80, 36, 16, 26, 36, 44].forEach((w, i) => (ts.getColumn(i + 1).width = w));

  const is = wb.addWorksheet("Investigators");
  const members = summarizeMembers(trials);
  if (members.length > SCHOLAR_EXPORT_CAP) {
    is.addRow([investigatorsOverCapNote(members.length)]);
    is.getColumn(1).width = 120;
  } else {
    is.addRow([
      "CWID",
      "Name",
      "Department",
      "Trials as PI",
      "Open to accrual",
      "Protocol numbers",
    ]);
    boldRow(is, 1);
    for (const m of members) {
      is.addRow([
        m.cwid,
        m.name,
        m.department ?? "",
        m.asPi,
        m.open,
        m.trials.map((t) => t.protocolNumber).join("; "),
      ]);
    }
    [12, 30, 36, 14, 16, 60].forEach((w, i) => (is.getColumn(i + 1).width = w));
  }

  addCriteriaSheet(wb, describeClinicalTrialsCriteria(p, centerName, generatedAt));
  return workbookBuffer(wb);
}
