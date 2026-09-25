/**
 * The center roster download (#1102) as an .xlsx workbook: one "Roster" sheet
 * with a bold `ROSTER_EXPORT_HEADERS` header row and one row per member, the
 * same columns and rows the CSV had. Server-only (exceljs); the route is its
 * only caller.
 *
 * SCHOLAR_EXPORT_CAP does not apply: this is the documented #1102 carve-out
 * (unit admins, their own roster, email behind `exportEmailCell`), and the
 * More Reports plan (D1) kept it when the format moved from CSV to .xlsx.
 */
import ExcelJS from "exceljs";

import type { UnitEditContext } from "@/lib/api/unit-edit-context";
import { boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import {
  ROSTER_EXPORT_HEADERS,
  buildUnitRosterRows,
  type BuildRosterExportOptions,
} from "@/lib/edit/unit-roster-export";

export function buildUnitRosterWorkbook(
  ctx: UnitEditContext,
  options: BuildRosterExportOptions,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Roster");
  ws.addRow([...ROSTER_EXPORT_HEADERS]);
  boldRow(ws, 1);
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of buildUnitRosterRows(ctx, options)) ws.addRow(row);
  ROSTER_EXPORT_HEADERS.forEach((h, i) => {
    ws.getColumn(i + 1).width = h === "name" || h === "title" || h === "email" ? 32 : 16;
  });
  return wb;
}

export function buildUnitRosterXlsx(ctx: UnitEditContext, options: BuildRosterExportOptions): Promise<Buffer> {
  return workbookBuffer(buildUnitRosterWorkbook(ctx, options));
}
