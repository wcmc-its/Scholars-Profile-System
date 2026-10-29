/**
 * Report 19 as an `.xlsx`, laid out like EVAL's Collaborative Publication
 * Matrix export: a "Publication Data" sheet (title, header, the unique row,
 * one row per program, counts then whole percents) and a "Report Details"
 * sheet (run date, period, membership type, excluded programs). Counts only,
 * no people, so no SCHOLAR_EXPORT_CAP applies.
 */
import ExcelJS from "exceljs";

import {
  MATRIX_COLUMNS,
  matrixPct,
  matrixPeriodLabel,
  UNIQUE_ROW_LABEL,
  type CollabPubMatrix,
  type CollabPubMatrixParams,
  type MatrixCounts,
} from "@/lib/edit/collab-pub-matrix";
import { boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

const TITLE = "Collaborative Publication Matrix Report";

const usDate = (d: Date) =>
  `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;

export async function buildCollabPubMatrixWorkbook(
  m: CollabPubMatrix,
  p: CollabPubMatrixParams,
  runDate: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const data = wb.addWorksheet("Publication Data");
  data.addRow([TITLE]);
  boldRow(data, 1);
  data.addRow([
    "Program Area Code",
    "Publications (#)",
    ...MATRIX_COLUMNS.map((c) => `${c.label} Pubs (#)`),
    ...MATRIX_COLUMNS.map((c) => `${c.label} Pubs (%)`),
  ]);
  boldRow(data, 2);
  const row = (label: string, c: MatrixCounts) =>
    data.addRow([
      label,
      c.publications,
      ...MATRIX_COLUMNS.map((col) => c[col.key]),
      ...MATRIX_COLUMNS.map((col) => matrixPct(c[col.key], c.publications)),
    ]);
  row(UNIQUE_ROW_LABEL, m.unique);
  for (const r of m.programs) row(r.code, r.counts);
  data.getColumn(1).width = 36;
  for (let i = 2; i <= 2 + 2 * MATRIX_COLUMNS.length; i++) data.getColumn(i).width = 18;

  const details = wb.addWorksheet("Report Details");
  for (const line of [
    TITLE,
    `Run Date: ${usDate(runDate)}`,
    `Report Period: ${matrixPeriodLabel(p)}`,
    `Membership Type: ${p.membershipType.toUpperCase()}`,
    `Excluded Program Areas: ${p.excluded.length ? p.excluded.join(", ") : "None"}`,
    `Include AI Relevance Decisions Not Yet Confirmed: ${p.confirmedOnly ? "No" : "Yes"}`,
  ])
    details.addRow([line]);
  boldRow(details, 1);
  return workbookBuffer(wb);
}
