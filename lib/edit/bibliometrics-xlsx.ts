/**
 * The Bibliometrics report as a spreadsheet (`format=xlsx`): one sheet per
 * section of the tab, a Papers sheet with one row per research article in
 * scope (PMID, DOI and every impact count), and a Citing documents sheet with
 * one row per paper and citing document. Same filters as the tab. One
 * scholar's own papers, so the 50-scholar export cap has nothing to apply to.
 *
 * Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { POLICY_LEVELS } from "@/lib/citations/policy-rollup";
import { OWN_FLAG, ownFlagSql } from "@/lib/edit/downstream-reach-report";
import {
  NO_SUMMARY_NOTE,
  POLICY_LEVEL_LABELS,
  POSITION_LABEL,
  UNSTAGED_LABEL,
  UNSTAGED_REASONS,
  filtersNote,
  positionOf,
  type BibliometricsPubRow,
  type BibliometricsReport,
} from "@/lib/edit/bibliometrics";
import { addCriteriaSheet, addListSheet, workbookBuffer } from "@/lib/edit/report-xlsx";
import {
  NO_STAGE_LABEL,
  STAGE_BUCKETS,
  displayStage,
  translationalStageDisplay,
} from "@/lib/translational-stage";
import { htmlToPlainText } from "@/lib/utils";

/** Rows the Citing documents sheet lists; over it, the sheet says so instead. */
export const CITING_ROWS_CAP = 50_000;

const LEVELS = [...POLICY_LEVELS, "clinical", "trial", "patent"] as const;
const LEVEL_LABEL: Record<string, string> = {
  ...Object.fromEntries(POLICY_LEVEL_LABELS),
  clinical: "Clinical studies (excluding the article's own authors)",
  trial: "Registered trials (excluding the article's own authors)",
  patent: "Patents",
};

export type CitingDocRow = {
  pmid: string;
  level: string;
  /** Issuing body, journal, or a patent's assignees. */
  source: string | null;
  title: string;
  year: number | null;
  url: string;
};

/** Every citing document of these papers, the authors' own clinical studies
 *  and trials left out as the tab counts them. One row per paper and
 *  document (a patent family once per paper). Null over `CITING_ROWS_CAP`. */
export async function loadCitingDocRows(pmids: readonly string[]): Promise<CitingDocRow[] | null> {
  if (pmids.length === 0) return [];
  const rows = await db.read.$queryRaw<
    Array<{ pmid: string; level: string; body: string | null; journal: string | null; assignees: string | null; title: string; year: number | null; url: string; dedup: string }>
  >`
    SELECT l.pmid AS pmid, d.level AS level, d.issuing_body AS body, d.journal AS journal,
           IF(d.level = 'patent', JSON_EXTRACT(d.details, '$.assignees'), NULL) AS assignees,
           d.title AS title, d.year AS year, d.url AS url, d.dedup_key AS dedup
      FROM publication_citing_document l
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE l.pmid IN (${Prisma.join([...pmids])})
       AND d.level IN (${Prisma.join([...LEVELS])})
       AND NOT ((d.level = 'clinical' AND ${ownFlagSql("l", OWN_FLAG.clinical!)})
             OR (d.level = 'trial' AND ${ownFlagSql("l", OWN_FLAG.trial!)}))
     LIMIT ${CITING_ROWS_CAP + 1}`;
  if (rows.length > CITING_ROWS_CAP) return null;
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    if (r.level === "patent") {
      const key = `${r.pmid}|${r.dedup}`;
      if (seen.has(key)) return [];
      seen.add(key);
    }
    return [
      {
        pmid: r.pmid,
        level: r.level,
        source: r.body ?? (r.assignees ? assigneesOf(r.assignees) : null) ?? r.journal,
        title: r.title,
        year: r.year === null ? null : Number(r.year),
        url: r.url,
      },
    ];
  });
}

function assigneesOf(json: string): string | null {
  try {
    const a: unknown = JSON.parse(json);
    return Array.isArray(a) && a.length > 0 ? a.join("; ") : null;
  } catch {
    return null;
  }
}

const plain = (s: string | null) => (s ? htmlToPlainText(s, Number.POSITIVE_INFINITY) : s);
const wrap = (ws: ExcelJS.Worksheet, ...cols: number[]) => {
  for (const c of cols) ws.getColumn(c).alignment = { wrapText: true, vertical: "top" };
};

export async function buildBibliometricsWorkbook(
  r: BibliometricsReport,
  articles: readonly BibliometricsPubRow[],
  citing: CitingDocRow[] | null,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const filters = filtersNote(r.filters);

  const summary = addCriteriaSheet(wb, [
    ["Scholar", r.scholar.name],
    ["Calculated", r.asOf],
    ["Filters", filters ?? "None: every research article"],
    ["Summary", r.summary.length > 0 ? `${r.scholar.name} ${r.summary.join(" ")}` : NO_SUMMARY_NOTE],
    ["h-index (all publications)", String(r.metrics.hIndex)],
    ["h5-index (last 5 years, all publications)", String(r.metrics.h5Index)],
    ["Rated research articles", String(r.metrics.ratedArticles)],
    ["Unrated research articles", String(r.metrics.unratedArticles)],
    ["In the top 10% by NIH percentile", String(r.metrics.topDecileArticles)],
    ["Share in the top 10%", r.metrics.topDecilePct === null ? "–" : `${r.metrics.topDecilePct}%`],
  ]);
  summary.name = "Summary";

  const output = addListSheet(wb, "Output", ["Year", "First author", "Senior author", "Co-author", "All"], [10, 14, 14, 14, 10]);
  for (const y of r.output.byYear) output.addRow([y.year, y.first, y.senior, y.co, y.count]);
  output.addRow(["All years in scope", r.output.first, r.output.senior, r.output.coAuthor, r.output.total]).font = {
    bold: true,
  };

  const stages = r.stages !== null;
  const papers = addListSheet(
    wb,
    "Papers",
    [
      "Rank",
      "PMID",
      "DOI",
      "Title",
      "Journal",
      "Year",
      "Author position",
      "NIH percentile",
      "Citation ratio",
      "Cited by",
      "Health authorities",
      "Guidelines",
      "Consensus statements",
      "Systematic reviews",
      "Clinical studies",
      "Registered trials",
      "Patent families",
      ...(stages ? ["Translational stage"] : []),
    ],
    [6, 12, 26, 70, 30, 8, 14, 12, 12, 10, 12, 12, 12, 12, 12, 12, 12, 24],
  );
  for (const [i, p] of articles.entries()) {
    const stage = displayStage(p.translationalStage, p.translationalStageConfidence);
    papers.addRow([
      i + 1,
      p.pmid,
      p.doi,
      plain(p.title),
      plain(p.journal),
      p.year,
      POSITION_LABEL[positionOf(p)],
      p.nihPercentile,
      p.relativeCitationRatio,
      p.citationCount,
      p.authorityCount,
      p.guidelineCount,
      p.consensusCount,
      p.reviewCount,
      p.clinicalCiteCount ?? 0,
      p.trialCount ?? 0,
      p.patentFamilyCount,
      ...(stages ? [stage ? translationalStageDisplay(stage) : NO_STAGE_LABEL] : []),
    ]);
  }
  wrap(papers, 4);

  const impact = addListSheet(wb, "Downstream impact", ["Cited in", "Articles cited", "Citing documents", "By body"], [56, 14, 16, 60]);
  for (const l of r.policy) {
    impact.addRow([l.label, l.papers, l.documents, l.bodies.map((b) => `${b.body} ${b.count}`).join(" · ")]);
  }
  impact.addRow([LEVEL_LABEL.clinical, r.research.clinical.papers, r.research.clinical.documents]);
  impact.addRow([LEVEL_LABEL.trial, r.research.trial.papers, r.research.trial.documents]);
  impact.addRow([
    `Patents${r.patents.dataEnd ? ` (patent data through ${r.patents.dataEnd})` : ""}`,
    r.patents.papers,
    r.patents.inventions,
    "Citing documents count inventions (patent families).",
  ]);
  wrap(impact, 4);

  if (r.stages) {
    const s = r.stages;
    const ws = addListSheet(wb, "Translational stage", ["Stage", "Research articles", "Share of staged"], [56, 18, 16]);
    for (const k of STAGE_BUCKETS) {
      ws.addRow([k === "none" ? NO_STAGE_LABEL : translationalStageDisplay(k), s.counts[k], k === "none" ? null : s.shares[k] / 100]);
      ws.getCell(ws.rowCount, 3).numFmt = "0%";
    }
    for (const k of UNSTAGED_REASONS) if (s.unstaged[k] > 0) ws.addRow([`Unstaged: ${UNSTAGED_LABEL[k]}`, s.unstaged[k]]);
    wrap(ws, 1);
  }

  const docs = addListSheet(
    wb,
    "Citing documents",
    ["PMID", "Paper title", "Cited in", "Source", "Citing document", "Year", "Link"],
    [12, 50, 36, 30, 70, 8, 46],
  );
  if (citing === null) {
    docs.addRow([`More than ${CITING_ROWS_CAP.toLocaleString("en-US")} citing documents, over the limit for this sheet. Narrow the filters to list them.`]);
  } else {
    const rank = new Map(articles.map((p, i) => [p.pmid, i]));
    const title = new Map(articles.map((p) => [p.pmid, plain(p.title)]));
    const order = (l: string) => (LEVELS as readonly string[]).indexOf(l);
    const sorted = [...citing].sort(
      (a, b) =>
        order(a.level) - order(b.level) ||
        (rank.get(a.pmid) ?? 0) - (rank.get(b.pmid) ?? 0) ||
        (b.year ?? 0) - (a.year ?? 0),
    );
    for (const d of sorted) {
      docs.addRow([d.pmid, title.get(d.pmid) ?? null, LEVEL_LABEL[d.level] ?? d.level, d.source, plain(d.title), d.year, d.url]);
    }
  }
  wrap(docs, 2, 5);

  addCriteriaSheet(wb, r.definitions.map((d) => [d.term ?? "Note", d.text] as const)).name = "Definitions";
  return workbookBuffer(wb);
}
