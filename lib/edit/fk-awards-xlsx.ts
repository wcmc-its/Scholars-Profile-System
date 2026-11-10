/**
 * Report 21 as an `.xlsx`: an "Awards" sheet, one row per award as the page
 * lists it, and a "Criteria" sheet. Names and award numbers only, no emails
 * or CWIDs, so this is not a scholar export (`SCHOLAR_EXPORT_CAP`).
 */
import ExcelJS from "exceljs";

import {
  FK_CATEGORIES,
  fkPeriodLabel,
  roleLabel,
  type FkAwards,
  type FkAwardsParams,
} from "@/lib/edit/fk-awards";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export async function buildFkAwardsWorkbook(
  r: FkAwards,
  p: FkAwardsParams,
  centerName: string,
  runDate: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Awards");
  ws.addRow([
    "Category",
    "Award holder",
    "Holder role",
    "Mechanism",
    "Award number",
    "Title",
    "Start",
    "End",
    "Member program",
    "Member mentors (program; mentor records)",
    "Faculty career mentor only",
  ]);
  boldRow(ws, 1);
  const label = new Map(FK_CATEGORIES.map((c) => [c.key, c.label]));
  for (const a of r.awards)
    ws.addRow([
      label.get(a.category),
      a.holderName,
      roleLabel(a.holderRole),
      a.mechanism,
      a.awardNumber,
      a.title,
      a.start,
      a.end,
      a.program ?? "",
      a.mentors
        .map((m) => `${m.name} (${[m.program ?? "No program", ...m.sources].join("; ")})`)
        .join("; "),
      a.careerMentorOnly ? "Yes" : "",
    ]);
  ws.columns.forEach((c, i) => (c.width = [24, 28, 20, 11, 22, 60, 12, 12, 30, 60, 12][i]));
  addCriteriaSheet(wb, [
    ["Center", centerName],
    ["Run date", runDate.toISOString().slice(0, 10)],
    ["Awards active in", fkPeriodLabel(p)],
    ["Members as of", p.asOf],
    ["Faculty linked only by a career mentor", p.labOnly ? "Left out" : "Included"],
    ["Awards left out: mentored only by non-members", String(r.notCenter)],
  ]);
  return workbookBuffer(wb);
}
