/**
 * `/edit/research-security` as an `.xlsx`: the current view under the current
 * filters (every row, not one page), a Matched affiliations sheet for the By
 * paper view, then Criteria and Methods sheets. Built on the shared workbook
 * pieces (`report-xlsx.ts`). Columns follow the Section 1286 workbook's tabs.
 */
import ExcelJS from "exceljs";

import {
  articleLink,
  attributionReason,
  isoDay,
  type EntityRow,
  type FundingRow,
  type MatchedString,
  type PaperRow,
  type PersonRow,
  type UnattributedRow,
} from "@/lib/api/research-security-report";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import {
  CAMPUS_LABEL,
  LIST_COUNTRY,
  LIST_FILTER_LABEL,
  VIEW_LABEL,
  campusName,
  type ResearchSecurityFilters,
  type ResearchSecurityView,
} from "@/lib/edit/research-security-dashboard";
import type { ResearchSecurityMethodsDoc } from "@/lib/edit/research-security-methods-doc";

type Cell = string | number;
type Sheet = { columns: string[]; rows: Cell[][] };

const yes = (b: boolean) => (b ? "Yes" : "");
const campusLabel = campusName;

export function entitySheet(rows: readonly EntityRow[]): Sheet {
  return {
    columns: [
      "List",
      "Category",
      "List no.",
      "Entity",
      "Co-publications (confirmed)",
      "with WCM authors",
      "with Cornell University authors",
      "excluding 50+ author consortia",
      "Distinct WCM/CU authors",
      "Papers where WCM/CU author lists entity",
      "Not yet attributed (papers)",
      "Not yet attributed, priority 1-2",
    ],
    rows: rows.map((r) => [
      r.listCode,
      r.category,
      r.listNo ?? "",
      r.entity,
      r.papers,
      r.papersWcm,
      r.papersIthaca,
      r.papersExcludingConsortia,
      r.people,
      r.papersOurAuthorListsEntity,
      r.unattributedPapers,
      r.unattributedPriority12,
    ]),
  };
}

export function personSheet(rows: readonly PersonRow[]): Sheet {
  return {
    columns: [
      "Person ID",
      "Campus",
      "Name",
      "Department",
      "Title",
      "Co-publications (confirmed)",
      "excluding 50+ author consortia",
      "Entities",
    ],
    rows: rows.map((r) => [
      r.cwid ?? "",
      campusLabel(r.campus),
      r.name,
      r.department ?? "",
      r.title ?? "",
      r.papers,
      r.papersExcludingConsortia,
      r.entities.join("; "),
    ]),
  };
}

export function paperSheet(rows: readonly PaperRow[]): Sheet {
  return {
    columns: [
      "ID",
      "Publication date",
      "Title",
      "Journal",
      "Publication type",
      "Total authors",
      "Large consortium (50+ authors)",
      "WCM authors",
      "CU authors",
      "Listed entities",
      "Entity categories",
      "Co-authors at listed entities",
      "WCM/CU author also lists entity",
      "Funding flags (CSC / talent programs)",
      "Source",
      "Link",
    ],
    rows: rows.map((r) => [
      r.article.articleId,
      isoDay(r.article.publicationDate),
      r.article.title ?? "",
      r.article.journal ?? "",
      r.article.publicationType ?? "",
      r.article.totalAuthors,
      yes(r.consortium),
      r.wcmAuthors.join("; "),
      r.ithacaAuthors.join("; "),
      r.entities.join("; "),
      r.categories.join("; "),
      r.coAuthorsAtEntities,
      yes(r.ourAuthorListsEntity),
      r.fundingPrograms.join("; "),
      r.article.source,
      articleLink(r.article) ?? "",
    ]),
  };
}

export function matchedStringsSheet(rows: readonly MatchedString[]): Sheet {
  return {
    columns: [
      "ID",
      "List",
      "Category",
      "List no.",
      "Entity",
      "Co-author",
      "Co-author is WCM/CU author",
      "Matched affiliation string",
    ],
    rows: rows.map((m) => [
      m.articleId,
      m.listCode,
      m.category,
      m.listNo ?? "",
      m.entity,
      m.authorName ?? "",
      yes(m.isInstitutionAuthor),
      m.affiliation ?? "",
    ]),
  };
}

export function fundingSheet(rows: readonly FundingRow[]): Sheet {
  return {
    columns: [
      "ID",
      "Link",
      "Publication date",
      "Program flagged",
      "Grant agency",
      "Grant ID",
      "WCM authors",
      "CU authors",
      "Title",
    ],
    rows: rows.map((r) => [
      r.article.articleId,
      articleLink(r.article) ?? "",
      isoDay(r.article.publicationDate),
      r.program,
      r.agency ?? "",
      r.grantId ?? "",
      r.wcmAuthors.join("; "),
      r.ithacaAuthors.join("; "),
      r.article.title ?? "",
    ]),
  };
}

export function unattributedSheet(rows: readonly UnattributedRow[]): Sheet {
  return {
    columns: [
      "Priority",
      "Already in confirmed report",
      "Why unattributed",
      "Candidate person",
      "Campus",
      "Department",
      "ReCiter score",
      "Publication date",
      "Title",
      "Journal",
      "Listed entities",
      "Entity categories",
      "Total authors",
      "Large consortium (50+ authors)",
      "Candidate also lists entity",
      "ID",
      "Link",
    ],
    rows: rows.map((r) => [
      r.priority,
      r.alreadyConfirmed ? "Yes (another author confirmed)" : "",
      attributionReason(r.person),
      r.person.cwid ? `${r.person.displayName} (${r.person.cwid})` : r.person.displayName,
      campusLabel(r.person.campus),
      r.person.department ?? "",
      r.person.reciterScore ?? "",
      isoDay(r.article.publicationDate),
      r.article.title ?? "",
      r.article.journal ?? "",
      r.entities.join("; "),
      r.categories.join("; "),
      r.article.totalAuthors,
      yes(r.article.totalAuthors >= 50),
      yes(r.candidateListsEntity),
      r.article.articleId,
      articleLink(r.article) ?? "",
    ]),
  };
}

/** The filters as Criteria rows. */
export function researchSecurityCriteria(
  view: ResearchSecurityView,
  f: ResearchSecurityFilters,
): Array<readonly [string, string]> {
  return [
    ["View", VIEW_LABEL[view]],
    ["Campus", f.campus === "both" ? "WCM and Cornell University" : CAMPUS_LABEL[f.campus]],
    ["List", view === "funding" ? "Not applicable (funding flags)" : LIST_FILTER_LABEL[f.list]],
    ["Category", view === "funding" ? "Not applicable (funding flags)" : (f.category ?? "All")],
    [
      f.list === LIST_COUNTRY ? "Country" : "Entity",
      view === "funding" ? "Not applicable (funding flags)" : (f.entity ?? "All"),
    ],
    ["Person (cwid)", f.person ?? "All"],
    ["Publication date", `${f.dateFrom} to ${f.dateTo ?? "present"}`],
    ["50+ author consortia", f.excludeConsortia ? "Excluded" : "Included"],
  ];
}

function addSheet(wb: ExcelJS.Workbook, name: string, sheet: Sheet): void {
  const ws = wb.addWorksheet(name);
  ws.addRow(sheet.columns);
  boldRow(ws, 1);
  for (const r of sheet.rows) ws.addRow(r);
  sheet.columns.forEach((c, i) => (ws.getColumn(i + 1).width = Math.min(60, Math.max(14, c.length + 2))));
}

export async function buildResearchSecurityWorkbook(input: {
  view: ResearchSecurityView;
  filters: ResearchSecurityFilters;
  /** The search text the rows were narrowed by, if any. */
  search?: string;
  sheet: Sheet;
  /** By paper only: the exact matched strings behind the rows. */
  matchedStrings?: Sheet;
  methods: ResearchSecurityMethodsDoc;
  dataAsOf: Date | null;
  generatedAt: Date;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addSheet(wb, VIEW_LABEL[input.view], input.sheet);
  if (input.matchedStrings) addSheet(wb, "Matched affiliations", input.matchedStrings);
  addCriteriaSheet(wb, [
    ...researchSecurityCriteria(input.view, input.filters),
    ["Search", input.search ?? "None"],
    ["Rows", input.sheet.rows.length.toLocaleString("en-US")],
    ["Data as of", input.dataAsOf ? input.dataAsOf.toISOString().slice(0, 10) : "unknown"],
    ["Generated", input.generatedAt.toISOString()],
    ["Caution", input.methods.notice],
  ]);
  const ws = wb.addWorksheet("Methods");
  ws.addRow(["Item", "Detail"]);
  boldRow(ws, 1);
  for (const s of input.methods.sections) ws.addRow([s.heading, s.body]);
  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 120;
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  return workbookBuffer(wb);
}
