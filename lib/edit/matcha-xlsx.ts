/**
 * The Matcha export workbook (`POST /api/edit/matcha/export`). One "Researchers" sheet built
 * from `buildMatchaRows`, so the columns cannot drift from the panel's mapping.
 *
 * - Header row bold, frozen at row 1, with an autofilter.
 * - Each column fits its longest value, clamped to 8..60 characters. A column whose longest
 *   value passes the cap wraps.
 * - Row heights are ESTIMATED: ExcelJS cannot measure text and Excel does not refit on open.
 *   Height = the most wrapped lines in any cell x 15pt. Excel's "AutoFit Row Height" corrects
 *   any drift (Mac Excel wraps a little differently).
 * - The Name cell links to the profile; the Profile URL column stays as text.
 * - Every cell is a string or number value, never a formula. `guardFormula` still runs on
 *   strings, as it does for CSV.
 *
 * Server-only (exceljs).
 */
import ExcelJS from "exceljs";

import { guardFormula } from "@/lib/csv";
import {
  buildMatchaRows,
  MATCHA_LONG_TEXT_HEADERS,
  type MatchaExportOpts,
  type MatchaExportRow,
} from "@/lib/edit/matcha-export";
import { boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export const XLSX_MIN_WIDTH = 8;
export const XLSX_MAX_WIDTH = 60;
export const XLSX_LINE_HEIGHT_PT = 15;
/** Excel's own per-cell limit. */
const XLSX_CELL_MAX = 32767;

/** Lines a value takes in a column `width` characters wide (wrapped) or not (newlines only). */
export function wrappedLines(value: string, width: number, wrap: boolean): number {
  const parts = value.split(/\r?\n/);
  // Excel shows an unwrapped cell on one line whatever newlines it holds.
  if (!wrap) return 1;
  return parts.reduce((n, p) => n + Math.max(1, Math.ceil(p.length / width)), 0);
}

/** Longest single line, in characters. */
function longestLine(value: string): number {
  return value.split(/\r?\n/).reduce((m, p) => Math.max(m, p.length), 0);
}

function cellText(v: string | number): string {
  return typeof v === "number" ? String(v) : v;
}

function isWebUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export async function buildMatchaWorkbook(
  rows: readonly MatchaExportRow[],
  opts: MatchaExportOpts,
  generatedAt: Date,
): Promise<Buffer> {
  const { header, body } = buildMatchaRows(rows, opts);
  const wb = new ExcelJS.Workbook();
  wb.created = generatedAt;
  const ws = wb.addWorksheet("Researchers", { views: [{ state: "frozen", ySplit: 1 }] });

  ws.addRow(header);
  boldRow(ws, 1);
  for (const r of body)
    ws.addRow(r.map((v) => (typeof v === "number" ? v : guardFormula(v.slice(0, XLSX_CELL_MAX - 1)))));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };

  // Widths from the header and every value; a column over the cap wraps.
  const widths: number[] = [];
  const wraps: boolean[] = [];
  header.forEach((h, i) => {
    const longest = Math.max(h.length, ...body.map((r) => longestLine(cellText(r[i]))));
    const width = Math.min(XLSX_MAX_WIDTH, Math.max(XLSX_MIN_WIDTH, longest + 2));
    const wrap = longest + 2 > XLSX_MAX_WIDTH || MATCHA_LONG_TEXT_HEADERS.has(h);
    widths.push(width);
    wraps.push(wrap);
    ws.getColumn(i + 1).width = width;
  });

  // Top-aligned so a one-line cell sits beside the first line of a wrapped one; heights
  // estimated per row, header included.
  ws.eachRow((row) => {
    let lines = 1;
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      cell.alignment = wraps[c - 1] ? { wrapText: true, vertical: "top" } : { vertical: "top" };
      const v = cell.value;
      const text = typeof v === "string" || typeof v === "number" ? String(v) : "";
      lines = Math.max(lines, wrappedLines(text, widths[c - 1], wraps[c - 1]));
    });
    row.height = lines * XLSX_LINE_HEIGHT_PT;
  });

  // The Name cell links to the profile. Only an http(s) URL: the rows come from the browser.
  const nameCol = header.indexOf("Name") + 1;
  const urlIdx = header.indexOf("Profile URL");
  body.forEach((r, i) => {
    const url = cellText(r[urlIdx]);
    if (!isWebUrl(url)) return;
    const cell = ws.getCell(i + 2, nameCol);
    cell.value = { text: guardFormula(cellText(r[nameCol - 1])), hyperlink: url };
    cell.font = { color: { argb: "FF0563C1" }, underline: true };
  });

  return workbookBuffer(wb);
}
