/**
 * Report 1's two workbooks (plan D1):
 *
 * - The report (`/api/edit/center/[code]/collab-report/xlsx`): one sheet per
 *   list (Remove, Add collaborators, Add recruits) for the URL's thresholds
 *   and filters, then Criteria. Each list is a scholar list, so a list of more
 *   than `SCHOLAR_EXPORT_CAP` people is WITHHELD: its sheet carries one note
 *   row instead of rows, never a truncated list.
 * - Export selected (`/selected`): the chosen rows, one sheet, then Criteria.
 *   The route refuses above the cap before this is ever called.
 *
 * Both use the table's columns (`OPTIMIZE_SHEET_HEADER`). Server-only (exceljs).
 */
import ExcelJS from "exceljs";

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  describeOptimizeCriteria,
  listWithheldNote,
  OPTIMIZE_SHEET_HEADER,
  OPTIMIZE_TABS,
  optimizeSheetRow,
  type CollabRow,
  type OptimizeLists,
  type OptimizeParams,
} from "@/lib/edit/optimize-membership-report";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

const WIDTHS = [12, 30, 36, 30, 10, 14, 16, 14, 16, 14, 40];

function addListSheet(wb: ExcelJS.Workbook, name: string, rows: ReadonlyArray<CollabRow>): void {
  const ws = wb.addWorksheet(name);
  ws.addRow([...OPTIMIZE_SHEET_HEADER]);
  boldRow(ws, 1);
  for (const r of rows) ws.addRow(optimizeSheetRow(r));
  WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));
}

export async function buildOptimizeMembershipWorkbook(
  lists: OptimizeLists,
  p: OptimizeParams,
  centerName: string,
  generatedAt: Date,
  refreshedAt: string | null,
  cap = SCHOLAR_EXPORT_CAP,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = generatedAt;
  for (const t of OPTIMIZE_TABS) {
    const rows = lists[t.key];
    if (rows.length > cap) {
      const ws = wb.addWorksheet(t.sheet);
      ws.addRow([listWithheldNote(t.label, rows.length, cap)]);
      ws.getColumn(1).width = 120;
    } else {
      addListSheet(wb, t.sheet, rows);
    }
  }
  addCriteriaSheet(wb, describeOptimizeCriteria(p, centerName, generatedAt, refreshedAt, cap));
  return workbookBuffer(wb);
}

export async function buildOptimizeSelectedWorkbook(
  rows: ReadonlyArray<CollabRow>,
  p: OptimizeParams,
  centerName: string,
  generatedAt: Date,
  refreshedAt: string | null,
  cap = SCHOLAR_EXPORT_CAP,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = generatedAt;
  addListSheet(wb, "Selected", rows);
  addCriteriaSheet(wb, [
    ...describeOptimizeCriteria(p, centerName, generatedAt, refreshedAt, cap),
    ["Selection", `${rows.length} people chosen on the page (${cap} at most).`],
  ]);
  return workbookBuffer(wb);
}
