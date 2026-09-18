/**
 * The Mentored publications report as a three-sheet workbook — the exact
 * artifact the Medical Education office has been assembling by hand:
 *   - "Summary"            one row per learner (counts + mentors);
 *   - "Raw Data"           one row per (learner, mentor, publication);
 *   - "Query & Assumptions" what was asked for and the rules applied, so the
 *                          sheet is self-describing a year later.
 *
 * Presentation: header row bold + frozen, Arial 12 throughout, column width =
 * longest cell + 3 (capped at 60). Business-case headers ("Journal impact
 * factor", "Date added to PubMed", "In program window" as Yes/No) — nothing a
 * reader has to translate from a column name. Built with `exceljs` (the only
 * new dependency this report adds); returns a `Buffer` for the download route.
 */
import ExcelJS from "exceljs";

import {
  HIGH_IMPACT_THRESHOLD,
  PROGRAM_LABEL,
  type MentoredPublicationsReport,
} from "@/lib/edit/mentored-publications-report";

export const SUMMARY_SHEET = "Summary";
export const RAW_SHEET = "Raw Data";
export const ASSUMPTIONS_SHEET = "Query & Assumptions";

export const SUMMARY_HEADERS = [
  "Graduation year",
  "Entry year",
  "Program",
  "CWID",
  "First name",
  "Last name",
  "Mentors",
  "Publications in program window",
  "Publications (all years)",
  `High-impact publications in window (JIF ≥ ${HIGH_IMPACT_THRESHOLD})`,
  "First-author publications in window",
] as const;

export const RAW_HEADERS = [
  "Graduation year",
  "Entry year",
  "Program",
  "Learner CWID",
  "Learner first name",
  "Learner last name",
  "Mentor CWID",
  "Mentor",
  "PMID",
  "Title",
  "Journal",
  "Journal impact factor",
  "Publication year",
  "Date added to PubMed",
  "Citations (NIH iCite)",
  "Learner author position",
  "Author count",
  "In program window",
] as const;

const FONT: Partial<ExcelJS.Font> = { name: "Arial", size: 12 };
const HEADER_FONT: Partial<ExcelJS.Font> = { ...FONT, bold: true };
const MAX_WIDTH = 60;
const WIDTH_PAD = 3;

type CellValue = string | number | Date | null;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The visible length of a cell for width sizing — dates render as
 *  `YYYY-MM-DD`, null as empty. */
function displayLength(v: CellValue): number {
  if (v === null || v === undefined) return 0;
  if (v instanceof Date) return 10;
  return String(v).length;
}

/** Write `headers` + `rows`, style every cell, freeze + bold the header, and
 *  size each column to its longest value. One code path for every sheet so
 *  the three can't drift in look. */
function fillSheet(ws: ExcelJS.Worksheet, headers: ReadonlyArray<string>, rows: ReadonlyArray<CellValue[]>): void {
  const widths = headers.map((h) => h.length);
  ws.addRow([...headers]);
  for (const r of rows) {
    ws.addRow([...r]);
    r.forEach((v, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayLength(v));
    });
  }
  ws.eachRow((row, n) => {
    row.font = n === 1 ? HEADER_FONT : FONT;
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = Math.min(w + WIDTH_PAD, MAX_WIDTH);
  });
  // Dates as ISO day strings (no time-of-day, no locale drift).
  headers.forEach((h, i) => {
    if (h === "Date added to PubMed") ws.getColumn(i + 1).numFmt = "yyyy-mm-dd";
  });
}

function yesNo(b: boolean): string {
  return b ? "Yes" : "No";
}

function scopeLabel(scopes: ReadonlyArray<string>): string {
  if (scopes.includes("*")) return "All programs (MD, MD-PhD, ECR)";
  return scopes.map((s) => PROGRAM_LABEL[s] ?? s).join(", ");
}

/** `Mentored Publications <program or All> <years joined by -> - YYYY-MM-DD.xlsx` */
export function downloadFilename(program: string | null, years: ReadonlyArray<number>, generatedAt: Date): string {
  const programLabel = program ? (PROGRAM_LABEL[program] ?? program) : "All";
  const yearsLabel = years.length > 0 ? years.join("-") : "all-years";
  return `Mentored Publications ${programLabel} ${yearsLabel} - ${isoDate(generatedAt)}.xlsx`;
}

/** Build the workbook and return it as a `Buffer`. */
export async function buildMentoredPublicationsWorkbook(
  report: MentoredPublicationsReport,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Scholars Profile System";
  wb.created = report.generatedAt;

  const summaryRows: CellValue[][] = report.summary.map((r) => [
    r.gradYear,
    r.entryYear,
    r.program,
    r.cwid,
    r.firstName,
    r.lastName,
    r.mentors.join("; "),
    r.pubsInWindow,
    r.pubsAllTime,
    r.highImpactInWindow,
    r.firstAuthorInWindow,
  ]);
  fillSheet(wb.addWorksheet(SUMMARY_SHEET), SUMMARY_HEADERS, summaryRows);

  const rawRows: CellValue[][] = report.detail.map((r) => [
    r.gradYear,
    r.entryYear,
    r.program,
    r.learnerCwid,
    r.learnerFirstName,
    r.learnerLastName,
    r.mentorCwid,
    r.mentorName,
    r.pmid,
    r.title,
    r.journal,
    r.jif,
    r.year,
    r.dateAdded,
    r.citations,
    r.learnerAuthorPosition,
    r.authorCount,
    yesNo(r.inWindow),
  ]);
  fillSheet(wb.addWorksheet(RAW_SHEET), RAW_HEADERS, rawRows);

  const { filters } = report;
  const years = filters.gradYears ? [...filters.gradYears].sort((a, b) => a - b).join(", ") : "All years";
  const fallbackCount = report.summary.filter((r) => r.entryYearSource === "fallback").length;
  const assumptions: CellValue[][] = [
    ["Generated", isoDate(report.generatedAt)],
    ["Graduation years", years],
    ["Programs", scopeLabel(filters.scopes)],
    ["Learners", report.summary.length],
    ["Publication rows", report.detail.length],
    [
      "Window rule",
      `In program window = entry year <= publication year <= graduation year + ${filters.tail} (tail = ${filters.tail} year${filters.tail === 1 ? "" : "s"}).`,
    ],
    [
      "Entry year",
      `The learner's program entry year from the Medical Education roster when present; otherwise graduation year - 4 (4-year MD track). ${fallbackCount} of ${report.summary.length} learner${report.summary.length === 1 ? "" : "s"} used the fallback.`,
    ],
    [
      "Counting rule",
      "A publication co-authored with two of a learner's mentors appears once per mentor in Raw Data but counts once in the learner's Summary counts (distinct PMIDs).",
    ],
    [
      "Publication source",
      "Every PubMed publication on which the learner and one of their AOC mentors are both WCM-identified authors (ReCiter author graph, via the mentoring co-publication bridge).",
    ],
    [
      "Journal impact factor",
      "Current-year Journal Impact Factor (Journal Citation Reports, mirrored weekly), joined on the journal's abbreviated title; blank when the journal did not match.",
    ],
    [
      "High-impact rule",
      `Journal impact factor >= ${HIGH_IMPACT_THRESHOLD}.`,
    ],
    [
      "Citations",
      "NIH iCite citation count (not Scopus); blank when iCite has no record for the PMID.",
    ],
    [
      "Date added to PubMed",
      "PubMed's date-added-to-Entrez for the record.",
    ],
    [
      "Learner author position",
      "The learner's 1-based position on the byline when their CWID is on the author list; blank when not linked.",
    ],
  ];
  fillSheet(wb.addWorksheet(ASSUMPTIONS_SHEET), ["Item", "Value"], assumptions);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
