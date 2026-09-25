/**
 * The Mentored publications report as a three-sheet workbook — the exact
 * artifact the Areas of Concentration (AOC) office has been assembling by
 * hand:
 *   - "Summary"            one row per learner (counts + mentors + mentor CWIDs
 *                          + mentor departments + mentor institutions + each
 *                          pair's mentorship type);
 *   - "Raw Data"           one row per (learner, mentor, publication) with the
 *                          pair's "Type of mentorship" — or, in the "all
 *                          learner publications" mode, one row per (learner,
 *                          publication) with the mentor(s) on it;
 *   - "Query & Assumptions" what was asked for and the rules applied (which
 *                          publication set, the mentored-subset rule, and
 *                          every page filter — In window, Author position,
 *                          Publication years, Mentors, Learners shown — "All"
 *                          when unset), so the sheet is self-describing a
 *                          year later.
 *
 * The Summary and Raw Data headers differ by mode (`SUMMARY_HEADERS` /
 * `SUMMARY_HEADERS_ALL`, `RAW_HEADERS` / `RAW_HEADERS_ALL`); the page's
 * Publications view is NOT in the workbook.
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
  type MentoredPublicationsReport,
  type MentoredPubsSet,
  type MentorPair,
  type MentorRef,
} from "@/lib/edit/mentored-publications-report";
import { POSITION_FACET_LABEL, WINDOW_FACET_LABEL } from "@/lib/edit/mentored-publications-facets";
import { MENTORSHIP_TYPE_LABEL, mentorshipLabel } from "@/lib/edit/mentorship-type";
import { workbookBuffer } from "@/lib/edit/report-xlsx";

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
  "Mentor CWIDs",
  "Mentor departments",
  "Mentor institutions",
  "Mentorship types",
  "Publications in program window",
  "Publications (all years)",
  `High-impact publications in window (Journal Impact Factor ≥ ${HIGH_IMPACT_THRESHOLD})`,
  "First-author publications in window",
] as const;

/** Summary headers in the "all learner publications" mode. */
export const SUMMARY_HEADERS_ALL = [
  "Graduation year",
  "Entry year",
  "Program",
  "CWID",
  "First name",
  "Last name",
  "Mentors",
  "Mentor CWIDs",
  "Mentor departments",
  "Mentor institutions",
  "Mentorship types",
  "All publications in program window",
  "Publications with a mentor in window",
  "First-author publications in window",
  `High-impact publications in window (Journal Impact Factor ≥ ${HIGH_IMPACT_THRESHOLD})`,
  "Publications (all years)",
] as const;

const RAW_PUB_HEADERS = [
  "PMID / Scopus ID",
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

export const RAW_HEADERS = [
  "Graduation year",
  "Entry year",
  "Program",
  "Learner CWID",
  "Learner first name",
  "Learner last name",
  "Mentor CWID",
  "Mentor",
  "Mentor department",
  "Mentor institution",
  "Type of mentorship",
  ...RAW_PUB_HEADERS,
] as const;

/** Raw Data headers in the "all learner publications" mode: one row per
 *  (learner, publication); the mentor pair columns become the mentor(s) on
 *  the paper (empty = none). */
export const RAW_HEADERS_ALL = [
  "Graduation year",
  "Entry year",
  "Program",
  "Learner CWID",
  "Learner first name",
  "Learner last name",
  "Mentor(s) on this paper",
  "Mentor CWID(s) on this paper",
  ...RAW_PUB_HEADERS,
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

/** Null (an unknowable window) is a blank cell. */
function yesNo(b: boolean | null): string | null {
  return b === null ? null : b ? "Yes" : "No";
}

/** `Mentored Publications <types label> <years joined by -> [All Pubs] - YYYY-MM-DD.xlsx`
 *  (a `null` year reads `unknown`). `typesLabel` is the caller's plain
 *  string (the route joins up to two `MENTORSHIP_TYPE_LABEL`s with `+`, else
 *  "Mixed"); a path or quote character in it becomes `-`, since a label such
 *  as "PhD / MD-PhD thesis advisor" must not split the filename. */
export function downloadFilename(
  typesLabel: string,
  years: ReadonlyArray<number | null>,
  generatedAt: Date,
  pubs: MentoredPubsSet = "mentored",
): string {
  const safeTypes = typesLabel.replace(/\s*[\\/:*?"<>|]+\s*/g, "-");
  const yearsLabel = years.length > 0 ? years.map((y) => y ?? "unknown").join("-") : "all-years";
  const mode = pubs === "all" ? " All Pubs" : "";
  return `Mentored Publications ${safeTypes} ${yearsLabel}${mode} - ${isoDate(generatedAt)}.xlsx`;
}

/** `; `-joined, or null (a blank cell) when there are none. */
function mentorNames(mentors: ReadonlyArray<MentorRef>): string | null {
  return mentors.length > 0 ? mentors.map((m) => m.name).join("; ") : null;
}

function mentorCwids(mentors: ReadonlyArray<MentorRef>): string | null {
  return mentors.length > 0 ? mentors.map((m) => m.cwid).join("; ") : null;
}

/** One `; `-joined field across the mentors, a mentor without it as "—" so
 *  the positions still line up with the Mentors column. */
function mentorField(
  mentors: ReadonlyArray<MentorRef>,
  get: (m: MentorRef) => string | null | undefined,
): string | null {
  return mentors.length > 0 ? mentors.map((m) => get(m) || "—").join("; ") : null;
}

function mentorshipTypes(mentors: ReadonlyArray<MentorPair>): string | null {
  return mentors.length > 0 ? mentors.map((m) => mentorshipLabel(m.mentorship)).join("; ") : null;
}

/** Build the workbook and return it as a `Buffer`. */
export async function buildMentoredPublicationsWorkbook(
  report: MentoredPublicationsReport,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Scholars Profile System";
  wb.created = report.generatedAt;

  const { filters, facets } = report;
  const allMode = filters.pubs === "all";

  const summaryRows: CellValue[][] = report.summary.map((r) => {
    const learner = [r.gradYear, r.entryYear, r.program, r.cwid, r.firstName, r.lastName];
    const mentors = [
      mentorNames(r.mentors),
      mentorCwids(r.mentors),
      mentorField(r.mentors, (m) => m.department),
      mentorField(r.mentors, (m) => m.institution),
      mentorshipTypes(r.mentors),
    ];
    return allMode
      ? [
          ...learner,
          ...mentors,
          r.pubsInWindow,
          r.withMentorInWindow,
          r.firstAuthorInWindow,
          r.highImpactInWindow,
          r.pubsAllTime,
        ]
      : [
          ...learner,
          ...mentors,
          r.pubsInWindow,
          r.pubsAllTime,
          r.highImpactInWindow,
          r.firstAuthorInWindow,
        ];
  });
  fillSheet(
    wb.addWorksheet(SUMMARY_SHEET),
    allMode ? SUMMARY_HEADERS_ALL : SUMMARY_HEADERS,
    summaryRows,
  );

  const rawRows: CellValue[][] = report.detail.map((r) => [
    r.gradYear,
    r.entryYear,
    r.program,
    r.learnerCwid,
    r.learnerFirstName,
    r.learnerLastName,
    ...(allMode
      ? [mentorNames(r.paperMentors), mentorCwids(r.paperMentors)]
      : [r.mentorCwid, r.mentorName, r.mentorDepartment, r.mentorInstitution, r.mentorship]),
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
  fillSheet(wb.addWorksheet(RAW_SHEET), allMode ? RAW_HEADERS_ALL : RAW_HEADERS, rawRows);

  const years = filters.gradYears
    ? [
        ...filters.gradYears.filter((y): y is number => y !== null).sort((a, b) => a - b),
        ...(filters.gradYears.includes(null) ? ["Unknown"] : []),
      ].join(", ")
    : "All years";
  const fallbackCount = report.summary.filter((r) => r.entryYearSource === "fallback").length;
  const assumptions: CellValue[][] = [
    ["Generated", isoDate(report.generatedAt)],
    ["Graduation years", years],
    ["Types of mentorship", filters.types.map((k) => MENTORSHIP_TYPE_LABEL[k]).join(", ")],
    [
      "Publication set",
      allMode
        ? "All learner publications: every PubMed- or Scopus-indexed publication on which the learner is a WCM-identified author (ReCiter author graph), whether or not a mentor is on it. Publications with a mentor = the subset also co-authored by one of the learner's selected mentors (the mentored co-publication set)."
        : "Mentored co-publications: every PubMed- or Scopus-indexed publication on which the learner and one of their selected mentors are both WCM-identified authors.",
    ],
    // The page's post-load filters (`applyMentoredPubsFacets`), "All" when unset.
    [
      "In window filter (per publication)",
      facets?.window.length ? facets.window.map((w) => WINDOW_FACET_LABEL[w]).join(", ") : "All",
    ],
    [
      "Author position filter",
      facets?.position.length ? facets.position.map((p) => POSITION_FACET_LABEL[p]).join(", ") : "All",
    ],
    ["Publication years filter", facets?.pubYears.length ? facets.pubYears.join(", ") : "All"],
    [
      "Mentor filter",
      facets?.mentors.length ? facets.mentors.map((m) => `${m.name} (${m.cwid})`).join("; ") : "All",
    ],
    [
      "Learners shown",
      facets?.withPubs ? "Only learners with at least one publication" : "All, including learners with no publications",
    ],
    ["Learners", report.summary.length],
    ["Publication rows", report.detail.length],
    [
      "Window rule",
      `In program window = entry year <= publication year <= graduation year + ${filters.tail} (tail = ${filters.tail} year${filters.tail === 1 ? "" : "s"}).`,
    ],
    [
      "Entry year",
      `The learner's program entry year from the AOC pairing sheet when present; otherwise graduation year - 4 (4-year MD track). ${fallbackCount} of ${report.summary.length} learner${report.summary.length === 1 ? "" : "s"} used the fallback.`,
    ],
    [
      "Counting rule",
      allMode
        ? "Raw Data is one row per (learner, publication); the mentor columns list every one of the learner's mentors on that paper. Summary counts are distinct PMIDs per learner."
        : "A publication co-authored with two of a learner's mentors appears once per mentor in Raw Data but counts once in the learner's Summary counts (distinct PMIDs).",
    ],
    [
      "Publication source",
      allMode
        ? "ReCiter author graph via the mentoring bridge (learner publication list + mentor co-publication list)."
        : "Every PubMed- or Scopus-indexed publication on which the learner and one of their selected mentors are both WCM-identified authors (ReCiter author graph, via the mentoring co-publication bridge or, for co-authorship inferences, the suggestion's own evidence).",
    ],
    [
      "Mentor names",
      "The mentor's name from their Scholars profile when they have one; otherwise the name on the AOC pairing sheet (or the Jenzabar record); otherwise the CWID alone.",
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

  return workbookBuffer(wb);
}
