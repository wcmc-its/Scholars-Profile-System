/**
 * Report 9 — "High-impact publications": articles in a fixed set of
 * top-tier journals (JAMA, Lancet, NEJM, JCO, Sci Transl Med, Nature, Blood,
 * Circulation, Science, Cell — the families below) by the scholars matching
 * the facets. Built for the Top Ten Clinical Research Achievement Awards ask:
 * original research (`Academic Article`) by full-time WCM faculty as first or
 * last author in the current calendar year — those are the DEFAULTS a bare
 * URL gets; every one is a facet.
 *
 * Scope is report 8's (`scopeSql`, `lib/edit/article-count-report.ts`: only
 * ReCiter-confirmed authorships of active scholars, same who-filters, same
 * position rule) plus a journal-family clause, so the two reports never
 * disagree on who counts. The page and the `.xlsx` route
 * (`/api/edit/reports/high-impact-publications`) share `parseHighImpactParams`
 * and the loaders here.
 *
 * Gate: a `report_access` row on `HIGH_IMPACT_PUBS_REPORT` (superuser /
 * comms_steward always). Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { db } from "@/lib/db";
import {
  articleCountQueryString,
  describeCriteria,
  parseArticleCountParams,
  scopeSql,
  type ArticleCountParams,
} from "@/lib/edit/article-count-report";
import { Prisma } from "@/lib/generated/prisma/client";

type JournalFamily = {
  key: string;
  label: string;
  /** Exact `publication.journal_abbrev` (NLM) values. */
  abbrevs: readonly string[];
  /** `journal_abbrev` prefixes for a family's sibling journals. */
  prefix?: string;
};

export const JOURNAL_FAMILIES: readonly JournalFamily[] = [
  { key: "jama", label: "JAMA (all JAMA journals)", abbrevs: ["JAMA"], prefix: "JAMA " },
  { key: "lancet", label: "The Lancet", abbrevs: ["Lancet"] },
  { key: "nejm", label: "NEJM (all NEJM journals)", abbrevs: ["N Engl J Med"], prefix: "NEJM " },
  { key: "jco", label: "Journal of Clinical Oncology", abbrevs: ["J Clin Oncol"] },
  { key: "stm", label: "Science Translational Medicine", abbrevs: ["Sci Transl Med"] },
  { key: "nature", label: "Nature (all Nature journals)", abbrevs: ["Nature"], prefix: "Nat " },
  { key: "blood", label: "Blood", abbrevs: ["Blood"] },
  { key: "circulation", label: "Circulation", abbrevs: ["Circulation"] },
  { key: "science", label: "Science", abbrevs: ["Science"] },
  { key: "cell", label: "Cell", abbrevs: ["Cell"] },
];

// ponytail: "Nat " is Nature Portfolio's NLM prefix, but a few other
// publishers' titles share it. Excluded by name; add one here if the
// Summary tab ever shows a non-Nature journal under Nature.
const NOT_NATURE = ["Nat Prod Rep", "Nat Prod Res", "Nat Prod Commun", "Nat Sci Sleep"];

/** The family a `journal_abbrev` belongs to, or null. Mirrors {@link journalSql}. */
export function journalFamilyOf(abbrev: string | null): JournalFamily | null {
  if (!abbrev) return null;
  return (
    JOURNAL_FAMILIES.find(
      (f) =>
        f.abbrevs.includes(abbrev) ||
        (f.prefix !== undefined &&
          abbrev.startsWith(f.prefix) &&
          !(f.key === "nature" && NOT_NATURE.includes(abbrev))),
    ) ?? null
  );
}

function journalSql(keys: readonly string[]): Prisma.Sql {
  const clauses = JOURNAL_FAMILIES.filter((f) => keys.includes(f.key)).map((f) => {
    const parts = [Prisma.sql`p.journal_abbrev IN (${Prisma.join(f.abbrevs)})`];
    if (f.prefix) {
      const notIn =
        f.key === "nature" ? Prisma.sql` AND p.journal_abbrev NOT IN (${Prisma.join(NOT_NATURE)})` : Prisma.empty;
      parts.push(Prisma.sql`(p.journal_abbrev LIKE ${`${f.prefix}%`}${notIn})`);
    }
    return Prisma.join(parts, " OR ");
  });
  return Prisma.sql`AND (${Prisma.join(clauses, " OR ")})`;
}

export type HighImpactView = "summary" | "publications";

export type HighImpactParams = ArticleCountParams & {
  /** Journal-family keys; never empty (none picked = every family). */
  journals: string[];
  view: HighImpactView;
};

/** A bare URL (nothing but `view`) gets the awards defaults; any filter in
 *  the URL means the form was submitted, and the URL is taken as-is. */
export function parseHighImpactParams(sp: URLSearchParams): HighImpactParams {
  const hasFilters = [...sp.keys()].some((k) => k !== "view");
  const year = String(new Date().getFullYear());
  const src = hasFilters
    ? sp
    : new URLSearchParams([
        ["type", "full_time_faculty"],
        ["atype", "Academic Article"],
        ["pos", "either"],
        ["from", year],
        ["to", year],
      ]);
  const known = new Set(JOURNAL_FAMILIES.map((f) => f.key));
  const journals = src.getAll("journal").filter((k) => known.has(k));
  return {
    ...parseArticleCountParams(src),
    basis: "cy",
    jif: 0,
    journals: journals.length > 0 ? journals : [...known],
    view: sp.get("view") === "publications" ? "publications" : "summary",
  };
}

export function highImpactQueryString(p: HighImpactParams, view: HighImpactView = p.view): string {
  const q = new URLSearchParams(articleCountQueryString(p));
  q.delete("jif");
  q.delete("basis");
  for (const j of p.journals) q.append("journal", j);
  q.set("view", view);
  return q.toString();
}

export type JournalCount = { family: string; journal: string; count: number };

/** Distinct articles per journal, family order then count. Always cheap —
 *  the Summary tab and the list-cap decision both read it. */
export async function loadJournalCounts(p: HighImpactParams): Promise<JournalCount[]> {
  const { fromWhere } = scopeSql(p, journalSql(p.journals));
  const raw = await db.read.$queryRaw<{ abbrev: string | null; journal: string | null; n: bigint | number }[]>`
    SELECT p.journal_abbrev AS abbrev, MAX(p.journal) AS journal, COUNT(DISTINCT pa.pmid) AS n
    ${fromWhere}
     GROUP BY p.journal_abbrev`;
  const order = new Map(JOURNAL_FAMILIES.map((f, i) => [f.label, i]));
  return raw
    .map((r) => ({
      family: journalFamilyOf(r.abbrev)?.label ?? "Other",
      journal: r.journal ?? r.abbrev ?? "",
      count: Number(r.n),
    }))
    .sort((a, b) => (order.get(a.family) ?? 99) - (order.get(b.family) ?? 99) || b.count - a.count);
}

/** The list is built only up to this many articles (report 8's cap). */
export const HIGH_IMPACT_LIST_CAP = 5000;

export type HighImpactRow = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  articleType: string | null;
  jif: number | null;
  dateAdded: string | null;
  /** NIH iCite citation count (`publication.cited_by_count`); null = none on file. */
  citations: number | null;
  doi: string | null;
  /** Matching WCM authors: `Name (first author)` / `(last author)` / `(middle author)`. */
  authors: string[];
};

type RawRow = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  publication_type: string | null;
  jif: number | string | null;
  date_added_to_entrez: Date | null;
  cited_by_count: number | null;
  doi: string | null;
  preferred_name: string;
  is_first: number | boolean;
  is_last: number | boolean;
};

/** One row per article, highest impact factor first. */
export async function loadHighImpactList(p: HighImpactParams): Promise<HighImpactRow[]> {
  const { fromWhere } = scopeSql(p, journalSql(p.journals));
  const raw = await db.read.$queryRaw<RawRow[]>`
    SELECT p.pmid, p.title, p.journal, p.year, p.publication_type, j.impact_score_1 AS jif,
           p.date_added_to_entrez, p.cited_by_count, p.doi, s.preferred_name, pa.is_first, pa.is_last
    ${fromWhere}
     ORDER BY j.impact_score_1 DESC, p.date_added_to_entrez DESC, p.pmid, pa.position`;
  const byPmid = new Map<string, HighImpactRow>();
  for (const r of raw) {
    let row = byPmid.get(r.pmid);
    if (!row) {
      row = {
        pmid: r.pmid,
        title: r.title,
        journal: r.journal,
        year: Number(r.year),
        articleType: r.publication_type,
        jif: r.jif === null ? null : Number(r.jif),
        dateAdded: r.date_added_to_entrez ? r.date_added_to_entrez.toISOString().slice(0, 10) : null,
        citations: r.cited_by_count === null ? null : Number(r.cited_by_count),
        doi: r.doi,
        authors: [],
      };
      byPmid.set(r.pmid, row);
    }
    const position = r.is_first ? "first author" : r.is_last ? "last author" : "middle author";
    row.authors.push(`${r.preferred_name} (${position})`);
  }
  return [...byPmid.values()];
}

export function describeHighImpactCriteria(
  p: HighImpactParams,
  generatedAt: Date,
  labels?: ReadonlyMap<string, string>,
): [string, string][] {
  const rows = describeCriteria(p, generatedAt, labels).filter(
    ([k]) => k !== "Year basis" && k !== "Minimum Journal Impact Factor",
  );
  rows[0] = ["Report", "9. High-impact publications"];
  rows.splice(2, 0, [
    "Journals",
    JOURNAL_FAMILIES.filter((f) => p.journals.includes(f.key))
      .map((f) => f.label)
      .join("; "),
  ]);
  return rows;
}

export async function buildHighImpactWorkbook(
  p: HighImpactParams,
  counts: JournalCount[],
  list: HighImpactRow[] | null,
  generatedAt: Date,
  labels?: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const bold = (ws: ExcelJS.Worksheet, r: number) => (ws.getRow(r).font = { bold: true });
  const total = counts.reduce((s, c) => s + c.count, 0);

  const pubs = wb.addWorksheet("Publications");
  if (list) {
    pubs.addRow([
      "PMID",
      "Title",
      "Journal",
      "Journal impact factor",
      "WCM first/last author(s)",
      "Date added to Entrez",
      "NIH citation count",
      "Article type",
      "Year",
      "DOI",
    ]);
    bold(pubs, 1);
    pubs.views = [{ state: "frozen", ySplit: 1 }];
    for (const a of list) {
      pubs.addRow([
        a.pmid,
        a.title,
        a.journal,
        a.jif,
        a.authors.join("; "),
        a.dateAdded,
        a.citations,
        a.articleType,
        a.year,
        a.doi,
      ]);
    }
    for (const [i, w] of [12, 70, 30, 12, 40, 14, 12, 16, 8, 28].entries()) pubs.getColumn(i + 1).width = w;
    pubs.getColumn(2).alignment = { wrapText: true, vertical: "top" };
    pubs.getColumn(5).alignment = { wrapText: true, vertical: "top" };
  } else {
    pubs.addRow([
      `${total.toLocaleString()} articles exceeds the ${HIGH_IMPACT_LIST_CAP.toLocaleString()}-row limit for this sheet. Narrow the filters to list them.`,
    ]);
  }

  const summary = wb.addWorksheet("Summary");
  summary.addRow(["Journal family", "Journal", "Articles"]);
  bold(summary, 1);
  for (const c of counts) summary.addRow([c.family, c.journal, c.count]);
  summary.addRow(["Total", "", total]);
  bold(summary, summary.rowCount);
  summary.getColumn(1).width = 32;
  summary.getColumn(2).width = 50;

  const criteria = wb.addWorksheet("Criteria");
  criteria.addRow(["Criterion", "Value"]);
  bold(criteria, 1);
  for (const [k, v] of describeHighImpactCriteria(p, generatedAt, labels)) criteria.addRow([k, v]);
  criteria.getColumn(1).width = 32;
  criteria.getColumn(2).width = 100;
  criteria.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

