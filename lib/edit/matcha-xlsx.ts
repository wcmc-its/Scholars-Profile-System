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
import { TIER_GOOD, TIER_STRONG } from "@/lib/api/matcha-contract";
import { RESEARCH_TYPE_MIN_PUBS, RESEARCH_TYPE_YEARS } from "@/lib/research-type";
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

  addAboutSheet(wb, rows);
  return workbookBuffer(wb);
}

/** Second sheet: what the judgement columns mean, for a reader who only has the file. The
 *  link is absolute, from the origin of the profile URLs (the panel builds those from the
 *  page origin); with no usable URL the sheet names the page instead. */
function addAboutSheet(wb: ExcelJS.Workbook, rows: readonly MatchaExportRow[]): void {
  const ws = wb.addWorksheet("About these columns");
  const first = rows.map((r) => r.profileUrl).find(isWebUrl);
  const docs = first ? `${new URL(first).origin}/about#research-type` : "";
  ws.addRow(["Column", "What it means"]);
  boldRow(ws, 1);
  for (const [col, text] of MATCHA_ABOUT_ROWS) ws.addRow([col, text]);
  ws.addRow([]);
  const link = ws.addRow(["Full definitions", docs || "Scholars, About page, Research type"]);
  if (docs) {
    link.getCell(2).value = { text: docs, hyperlink: docs };
    link.getCell(2).font = { color: { argb: "FF0563C1" }, underline: true };
  }
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 90;
  ws.eachRow((row) => {
    row.eachCell((cell) => (cell.alignment = { wrapText: true, vertical: "top" }));
    const text = row.getCell(2).text;
    row.height = wrappedLines(text, 90, true) * XLSX_LINE_HEIGHT_PT;
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
export const MATCHA_ABOUT_ROWS: readonly (readonly [string, string])[] = [
  ["Fit", `How close this person is to the best match in this search, not an absolute score. Strong fit is at least ${pct(TIER_STRONG)} of the top score and Good fit at least ${pct(TIER_GOOD)}; below that is Weak fit. Strong fit also needs a research award as PI or a CTL technology; without either it reads Good fit.`],
  ["Research kind", `Laboratory research and Clinical research: at least ${RESEARCH_TYPE_MIN_PUBS} first or last author research articles of that kind in the last ${RESEARCH_TYPE_YEARS} years, as classified by NIH iCite. A person can show both. Blank means the papers do not show it yet, not that the person does no research.`],
  ["Researcher type", "One type per person, from the research kind, whether they hold a medical degree, and whether they lead a research award: Physician-scientist, Basic scientist, Clinical or population researcher, Funded investigator, Clinician, Trainee, Research staff or Unclassified."],
];
