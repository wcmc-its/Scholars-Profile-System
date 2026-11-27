/**
 * Patents citing one scholar's work, for the Bibliometrics tab
 * (`EDIT_BIBLIOMETRICS`): the Excel download of every citing patent, and the
 * link to report 25 filtered to the scholar. Reads what report 25 reads
 * (`patent-citations-report.ts`) through its loaders. Writes nothing.
 *
 * Access is decided by the caller (`authorizeCvExport` on the one scholar), not
 * by a unit scope, so every query here is restricted to the scholar's visible
 * PMIDs: the confirmed authorships the tab itself counts
 * (`loadScholarPublications`), of any publication type.
 *
 * The workbook is one scholar's own publications and names no other person, so
 * the 50-scholar export cap (`SCHOLAR_EXPORT_CAP`) has nothing to apply to.
 *
 * Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import type { EditSession } from "@/lib/auth/superuser";
import { OWN_PATENTS_NOTE, POSITION_LABEL, positionOf } from "@/lib/edit/bibliometrics";
import { loadScholarPublications } from "@/lib/edit/bibliometrics-loader";
import {
  canViewPatentCitationsReport,
  loadCitingInventionsOfPmids,
  loadInventionCountsOfPmids,
  parsePatentCitationParams,
  PATENT_DATA_END,
  PATENT_LAG_NOTICE,
  PATENT_SOURCES,
  patentCitationQueryString,
  sortInventions,
  sortPatentPublications,
  WHERE_CITED_LABEL,
  withInventionDetails,
  type CitingInvention,
  type InventionRow,
  type PatentPubCounts,
} from "@/lib/edit/patent-citations-report";
import { reportMetaFor } from "@/lib/edit/report-meta";
import { addCriteriaSheet, addListSheet, workbookBuffer } from "@/lib/edit/report-xlsx";
import { htmlToPlainText } from "@/lib/utils";

/** Report 25 with no filter set; its scope is `[]` (match nothing). */
const NO_FILTERS = parsePatentCitationParams(new URLSearchParams());

/** Report 25 filtered to this scholar, or null when the viewer may not open
 *  that report (its flag off, or no unit to see). */
export async function patentReportHref(
  session: Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward">,
  cwid: string,
): Promise<string | null> {
  if (!(await canViewPatentCitationsReport(session))) return null;
  const { slug } = await reportMetaFor("25");
  return `/edit/reports/${slug}?${patentCitationQueryString(NO_FILTERS, { people: [cwid] })}`;
}

/** One of the scholar's papers that a patent cites. */
export type ScholarPatentPub = PatentPubCounts & {
  title: string;
  journal: string | null;
  /** "First", "Senior" or "Co-author". */
  position: string;
  /** Every invention citing it, newest first. */
  citing: CitingInvention[];
};

export type ScholarPatentCitations = {
  scholar: { cwid: string; name: string };
  /** Most citing inventions first. */
  pubs: ScholarPatentPub[];
  /** Most of the scholar's papers cited first. */
  inventions: InventionRow[];
};

/** Every patent citing any of the scholar's visible publications. Null for a
 *  cwid with no scholar. */
export async function loadScholarPatentCitations(cwid: string): Promise<ScholarPatentCitations | null> {
  const own = await loadScholarPublications(cwid);
  if (!own) return null;
  // The rollup picks the papers; the links decide what is listed.
  const cited = own.visible.filter((p) => p.patentFamilyCount > 0);
  const pmids = cited.map((p) => p.pmid);
  const [byPmid, counts] = await Promise.all([
    loadCitingInventionsOfPmids(pmids),
    loadInventionCountsOfPmids(pmids),
  ]);
  const pubs = cited.flatMap((p): ScholarPatentPub[] => {
    const found = byPmid.get(p.pmid);
    if (!found || found.total === 0) return [];
    return [
      {
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        position: POSITION_LABEL[positionOf(p)],
        inventions: found.total,
        latest: found.latest,
        citing: found.shown,
      },
    ];
  });
  return {
    scholar: { cwid, name: own.scholar.preferredName },
    pubs: sortPatentPublications(pubs, "inventions"),
    // `papers: false`: patent facts only, so the unscoped params read nothing.
    inventions: await withInventionDetails(NO_FILTERS, sortInventions(counts, "papers"), { papers: false }),
  };
}

const plain = (s: string | null) => (s ? htmlToPlainText(s, Number.POSITIVE_INFINITY) : s);
const grantedOrPublished = (application: boolean) => (application ? "Application published" : "Granted");

/** The workbook: Citations (one row per paper and invention), Publications,
 *  Inventions, Criteria. */
export async function buildScholarPatentWorkbook(data: ScholarPatentCitations, generatedAt: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const citations = addListSheet(
    wb,
    "Citations",
    [
      "PMID",
      "Paper title",
      "Journal",
      "Year",
      "Author position",
      "Patent",
      "Patent title",
      "Assignees",
      "First inventor",
      "Granted or published",
      "Patent year",
      "Where cited",
      "Related patents",
      "Link",
    ],
    [12, 60, 28, 8, 14, 20, 60, 36, 24, 22, 10, 34, 14, 46],
  );
  for (const p of data.pubs) {
    for (const d of p.citing) {
      citations.addRow([
        p.pmid,
        plain(p.title),
        plain(p.journal),
        p.year,
        p.position,
        d.number,
        d.title,
        d.assignees.join("; "),
        d.firstInventor,
        grantedOrPublished(d.application),
        d.year,
        WHERE_CITED_LABEL[d.where],
        Math.max(0, d.docs - 1),
        d.url,
      ]);
    }
  }
  citations.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  citations.getColumn(7).alignment = { wrapText: true, vertical: "top" };

  const pubs = addListSheet(
    wb,
    "Publications",
    ["PMID", "Title", "Journal", "Year", "Author position", "Citing inventions", "Latest citing patent year"],
    [12, 70, 30, 8, 14, 14, 14],
  );
  for (const p of data.pubs) {
    pubs.addRow([p.pmid, plain(p.title), plain(p.journal), p.year, p.position, p.inventions, p.latest]);
  }
  pubs.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const inventions = addListSheet(
    wb,
    "Inventions",
    ["Patent", "Title", "Assignees", "First inventor", "Granted or published", "Year", "Related patents", "Papers cited", "Link"],
    [20, 70, 40, 24, 22, 8, 14, 14, 46],
  );
  for (const r of data.inventions) {
    inventions.addRow([
      r.number,
      r.title,
      r.assignees.join("; "),
      r.firstInventor,
      grantedOrPublished(r.application),
      r.year,
      Math.max(0, r.docs - 1),
      r.papers,
      r.url,
    ]);
  }
  inventions.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  addCriteriaSheet(wb, [
    ["Report", "Patents citing this work"],
    ["Scholar", data.scholar.name],
    ["Generated", generatedAt.toISOString()],
    [
      "Publications covered",
      "The scholar's ReCiter-confirmed publications of every type, as their profile shows them. Publications the scholar hid are left out.",
    ],
    [
      "Counting rule",
      "Counts are inventions: related patents (one patent family) count once, and an invention is listed by its earliest granted patent, or by its earliest published application when none was granted.",
    ],
    ["The scholar's own patents", OWN_PATENTS_NOTE],
    ["Reading the numbers", `${PATENT_LAG_NOTICE} The patent data ends at ${PATENT_DATA_END.label}.`],
    ["Sources", PATENT_SOURCES.replace(/^Sources: /, "")],
    ["Citations sheet", `One row per paper and citing invention: ${citations.rowCount - 1} in all.`],
    ["Inventions sheet", "One row per invention, with how many of the scholar's papers it cites."],
  ]);

  return workbookBuffer(wb);
}
