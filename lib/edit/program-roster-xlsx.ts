/** One program of the internal roster as an `.xlsx`: People, Mentors, Criteria. */
import ExcelJS from "exceljs";

import {
  milestoneOf,
  type MentorCount,
  type RosterEntryView,
  type RosterFilter,
  type RosterProgramView,
} from "@/lib/edit/program-roster";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export async function buildProgramRosterWorkbook(
  program: RosterProgramView,
  filter: RosterFilter,
  entries: readonly RosterEntryView[],
  mentors: readonly MentorCount[],
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const people = wb.addWorksheet("People");
  people.addRow(["Person", "CWID", "Year", "Mentors", "Mentor CWIDs", "Research program"]);
  for (const e of entries) {
    people.addRow([
      e.mentee.name,
      e.mentee.cwid,
      e.year,
      e.mentors.map((m) => m.name).join("; "),
      e.mentors.map((m) => m.cwid).join("; "),
      e.researchProgram ?? "",
    ]);
  }
  [30, 12, 8, 48, 28, 34].forEach((w, i) => (people.getColumn(i + 1).width = w));
  boldRow(people, 1);

  const sheet = wb.addWorksheet("Mentors");
  sheet.addRow(["Mentor", "CWID", "Trainees, all years", "Milestone", "First year", "Last year"]);
  for (const m of mentors) {
    sheet.addRow([m.mentor.name, m.mentor.cwid, m.trainees, milestoneOf(m.trainees) ?? "", m.firstYear, m.lastYear]);
  }
  [30, 12, 20, 12, 12, 12].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
  boldRow(sheet, 1);

  addCriteriaSheet(wb, [
    ["Program", `${program.name} (${program.shortLabel})`],
    ["Year", filter.year === null ? "All years" : String(filter.year)],
    ["Entries", String(entries.length)],
    [
      "Trainee counts",
      "Distinct trainees per mentor in this program, all years. A trainee with two mentors counts once for each.",
    ],
    ["Use", "Internal. Trainee records: do not post or share outside the program."],
    ["Generated", generatedAt.toISOString()],
  ]);
  return workbookBuffer(wb);
}
