/**
 * Report 18 — Publication citation report: the center's publications in a
 * period with their `center_publication_relevance` answer, in the shape of
 * EVAL's publication export (Title | Investigators | Journal | Publication
 * Date | Cancer Relevant | PubMed ID | Notes). Params, row shape, the
 * investigator line and the workbook; the loader is
 * `pub-citation-report.server.ts`. DB-free.
 *
 * Exempt from SCHOLAR_EXPORT_CAP (approved 2026-10-29) on the condition that
 * the export carries NO CWID column: publication-grain citation data with
 * investigator names only, like the NCI 2A export.
 */
import ExcelJS from "exceljs";

import { isCenterMembershipActive } from "@/lib/api/center-member-count";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export type PubCitationMembershipType = "research" | "clinical" | "all";
export type PubCitationRelevance = "yes" | "all";

export type PubCitationParams = {
  /** `YYYY-MM-DD`, both ends inclusive. */
  start: string;
  end: string;
  membership: PubCitationMembershipType;
  relevance: PubCitationRelevance;
};

export type PubCitationRow = {
  pmid: string;
  title: string;
  journal: string | null;
  /** `Publication.dateAddedToEntrez` as `YYYY-MM-DD`. */
  date: string;
  /** Null = the relevance step has not decided it. */
  relevant: boolean | null;
  reason: string | null;
  /** Every confirmed WCM author in byline order; `line` is "Last, First - PROGRAM"
   *  ({@link investigatorLine}). The cwid is for the page's hover card only and
   *  never reaches the workbook. */
  investigators: Array<{ cwid: string; line: string }>;
};

export const PUB_CITATION_COLUMNS = [
  "Title",
  "Investigators",
  "Journal",
  "Publication Date",
  "Cancer Relevant",
  "PubMed ID",
  "Notes",
] as const;

const TYPES: readonly PubCitationMembershipType[] = ["research", "clinical", "all"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Defaults: this calendar year to date, research members, relevant only. */
export function parsePubCitationParams(sp: URLSearchParams, now = new Date()): PubCitationParams {
  const date = (k: string, fallback: string) => {
    const v = sp.get(k) ?? "";
    return ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : fallback;
  };
  const today = now.toISOString().slice(0, 10);
  const membership = sp.get("membership") as PubCitationMembershipType | null;
  return {
    start: date("start", `${today.slice(0, 4)}-01-01`),
    end: date("end", today),
    membership: membership && TYPES.includes(membership) ? membership : "research",
    relevance: sp.get("relevance") === "all" ? "all" : "yes",
  };
}

export const pubCitationQueryString = (p: PubCitationParams) =>
  new URLSearchParams({
    start: p.start,
    end: p.end,
    membership: p.membership,
    relevance: p.relevance,
  }).toString();

/** A membership row, as {@link programAsOf} reads it. */
export type PubCitationStint = {
  programCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
  membershipRoleKey: string | null;
};

/** Does the stint cover `dateIso`? Inclusive, open-ended on a null bound; never an invitee. */
export const stintCovers = (stint: PubCitationStint | undefined, dateIso: string) =>
  !!stint && isCenterMembershipActive(stint, dateIso);

/** The member's program on `dateIso`: their code only while the stint covers that date. */
export const programAsOf = (stint: PubCitationStint | undefined, dateIso: string) =>
  stint && stintCovers(stint, dateIso) ? stint.programCode : null;

/** "Given Middle Surname" → "Surname, Given Middle". A one-word name is left alone. */
export function lastFirst(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return fullName.trim();
  return `${words[words.length - 1]}, ${words.slice(0, -1).join(" ")}`;
}

/** EVAL's line: "Last, First - PROGRAM", the bare name for a non-member or out-of-stint author. */
export const investigatorLine = (fullName: string, programCode: string | null) =>
  programCode ? `${lastFirst(fullName)} - ${programCode}` : lastFirst(fullName);

const relevantLabel = (r: boolean | null) => (r === null ? "" : r ? "Yes" : "No");

export function pubCitationCriteria(p: PubCitationParams): Array<[string, string]> {
  return [
    ["Period", `${p.start} to ${p.end} (date added to PubMed)`],
    [
      "Membership type",
      p.membership === "all"
        ? "All members"
        : `${p.membership[0].toUpperCase()}${p.membership.slice(1)} members`,
    ],
    ["Cancer relevant", p.relevance === "yes" ? "Yes only" : "All"],
  ];
}

/**
 * EVAL's workbook: one sheet per answer ("Cancer Relevance = No", then
 * "= Yes", then "= Not scored" when any), the seven columns, one investigator
 * per line. Then the Criteria sheet. No CWID column (see the cap note above).
 */
export async function buildPubCitationWorkbook(
  rows: readonly PubCitationRow[],
  params: PubCitationParams,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const groups: Array<[string, PubCitationRow[]]> = [
    ["No", rows.filter((r) => r.relevant === false)],
    ["Yes", rows.filter((r) => r.relevant === true)],
    ["Not scored", rows.filter((r) => r.relevant === null)],
  ];
  for (const [label, group] of groups) {
    if (group.length === 0 && (label !== "Yes" || params.relevance === "all")) continue;
    const ws = wb.addWorksheet(`Cancer Relevance = ${label}`);
    ws.addRow([...PUB_CITATION_COLUMNS]);
    boldRow(ws, 1);
    for (const r of group)
      ws.addRow([
        r.title,
        r.investigators.map((i) => i.line).join("\n"),
        r.journal ?? "",
        new Date(`${r.date}T00:00:00Z`),
        relevantLabel(r.relevant),
        r.pmid,
        r.reason ?? "",
      ]);
    [58, 48, 25, 17, 17, 15, 50].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    for (const c of [1, 2, 3, 6, 7])
      ws.getColumn(c).alignment = { wrapText: true, vertical: "top" };
    ws.getColumn(4).numFmt = "dd mmm yyyy";
  }
  addCriteriaSheet(wb, [
    ...pubCitationCriteria(params),
    ["Publications", rows.length.toLocaleString()],
    ["Generated", generatedAt.toISOString()],
  ]);
  return workbookBuffer(wb);
}
