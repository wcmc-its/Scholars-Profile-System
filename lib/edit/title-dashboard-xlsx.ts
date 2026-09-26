/**
 * The Titles queue (`/edit/titles-queue`, formerly report 10) as an `.xlsx`: one Titles sheet of
 * the FILTERED rows, then the Criteria sheet stating every filter. Built on
 * the shared workbook pieces (`report-xlsx.ts`). No email column: this export
 * carries names, CWIDs and titles only (see the route's cap note).
 */
import ExcelJS from "exceljs";

import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import {
  formatTitleRank,
  TITLE_REASON_LABEL,
  titleDashboardCriteria,
  titleRowNotes,
  titleRuleLabel,
  winningRank,
  winningRule,
  type TitleDashboardParams,
  type TitleDashboardRow,
} from "@/lib/edit/title-dashboard";

export const TITLE_DASHBOARD_COLUMNS = [
  "Name",
  "CWID",
  "Displayed title",
  "Winning rule",
  "Rank",
  "Runner-up",
  "Runner-up rank",
  "Reasons",
  "Pin",
  "Notes",
] as const;

/** One sheet row, in {@link TITLE_DASHBOARD_COLUMNS} order. */
export function titleDashboardSheetRow(r: TitleDashboardRow): string[] {
  const rule = winningRule(r);
  return [
    r.name,
    r.cwid,
    r.displayed ?? "",
    rule ? titleRuleLabel(rule) : "",
    formatTitleRank(winningRank(r)),
    r.runnerUp?.value ?? "",
    r.runnerUp ? formatTitleRank(r.runnerUp.rank) : "",
    r.reasons.map((x) => TITLE_REASON_LABEL[x]).join("; "),
    r.pin ?? "",
    titleRowNotes(r).join("; "),
  ];
}

export async function buildTitleDashboardWorkbook(
  rows: readonly TitleDashboardRow[],
  params: TitleDashboardParams,
  listed: number,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Titles");
  ws.addRow([...TITLE_DASHBOARD_COLUMNS]);
  boldRow(ws, 1);
  for (const r of rows) ws.addRow(titleDashboardSheetRow(r));
  [28, 10, 48, 18, 8, 48, 14, 30, 40, 40].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  addCriteriaSheet(wb, [
    ...titleDashboardCriteria(params),
    ["Scholars listed", listed.toLocaleString()],
    ["After filters", rows.length.toLocaleString()],
    ["Generated", generatedAt.toISOString()],
  ]);
  return workbookBuffer(wb);
}
