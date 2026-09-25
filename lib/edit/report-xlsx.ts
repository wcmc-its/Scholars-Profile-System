/**
 * What the report workbooks share (reports 7, 8 and 9): the bold header row,
 * the two-column Criteria sheet, the one-line note that stands in for a list
 * sheet over its row cap, and the `Buffer` the download routes send. Each
 * report still builds its own sheets; only the pieces that were written the
 * same way in more than one builder live here.
 */
import ExcelJS from "exceljs";

export function boldRow(ws: ExcelJS.Worksheet, r: number): void {
  ws.getRow(r).font = { bold: true };
}

/** A "Criteria" sheet: a bold `Criterion | Value` header, one row per pair,
 *  and a wide, wrapped value column. */
export function addCriteriaSheet(
  wb: ExcelJS.Workbook,
  rows: ReadonlyArray<readonly [string, string]>,
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet("Criteria");
  ws.addRow(["Criterion", "Value"]);
  boldRow(ws, 1);
  for (const [k, v] of rows) ws.addRow([k, v]);
  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 100;
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  return ws;
}

/** The line a list sheet carries instead of its rows when `total` is over `cap`. */
export function overListCapNote(total: number, cap: number): string {
  return `${total.toLocaleString()} articles exceeds the ${cap.toLocaleString()}-row limit for this sheet. Narrow the filters to list them.`;
}

export async function workbookBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
