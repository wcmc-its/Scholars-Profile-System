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
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { Prisma } from "@/lib/generated/prisma/client";
import { formatRoleCategory } from "@/lib/role-display";

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
// publishers' titles share it. Excluded by name; add one here if a
// non-Nature journal ever shows up in the list.
const NOT_NATURE = ["Nat Prod Rep", "Nat Prod Res", "Nat Prod Commun", "Nat Sci Sleep"];

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

/** Distinct articles in scope — decides whether the list is loaded. */
export async function loadHighImpactTotal(p: HighImpactParams): Promise<number> {
  const { fromWhere } = scopeSql(p, journalSql(p.journals));
  const [row] = await db.read.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(DISTINCT pa.pmid) AS n
    ${fromWhere}`;
  return Number(row?.n ?? 0);
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
  /** The same authors, structured, for the people summary. */
  people: { cwid: string; name: string; department: string | null; personType: string; position: AuthorRole }[];
};

type AuthorRole = "first" | "last" | "middle";

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
  cwid: string;
  primary_department: string | null;
  role_category: string | null;
  is_first: number | boolean;
  is_last: number | boolean;
};

/** One row per article, highest impact factor first. */
export async function loadHighImpactList(p: HighImpactParams): Promise<HighImpactRow[]> {
  const { fromWhere } = scopeSql(p, journalSql(p.journals));
  const raw = await db.read.$queryRaw<RawRow[]>`
    SELECT p.pmid, p.title, p.journal, p.year, p.publication_type, j.impact_score_1 AS jif,
           p.date_added_to_entrez, p.cited_by_count, p.doi, s.preferred_name, s.cwid,
           s.primary_department, s.role_category, pa.is_first, pa.is_last
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
        people: [],
      };
      byPmid.set(r.pmid, row);
    }
    const position: AuthorRole = r.is_first ? "first" : r.is_last ? "last" : "middle";
    row.authors.push(`${r.preferred_name} (${position} author)`);
    row.people.push({
      cwid: r.cwid,
      name: r.preferred_name,
      department: r.primary_department,
      personType: formatRoleCategory(r.role_category) ?? "",
      position,
    });
  }
  return [...byPmid.values()];
}

export type PersonSummaryRow = {
  cwid: string;
  name: string;
  department: string | null;
  personType: string;
  articles: number;
  firstAuthor: number;
  lastAuthor: number;
  /** Sum of the articles' NIH citation counts (none on file = 0). */
  citations: number;
  /** Distinct journals, most articles first. */
  journals: string[];
};

/** One row per matching scholar, most articles first. An article where the
 *  same person is somehow listed twice still counts once for them. */
export function summarizePeople(list: HighImpactRow[]): PersonSummaryRow[] {
  const byCwid = new Map<string, PersonSummaryRow & { journalCounts: Map<string, number> }>();
  for (const a of list) {
    for (const cwid of new Set(a.people.map((x) => x.cwid))) {
      const roles = a.people.filter((x) => x.cwid === cwid);
      const who = roles[0];
      let row = byCwid.get(cwid);
      if (!row) {
        row = {
          cwid,
          name: who.name,
          department: who.department,
          personType: who.personType,
          articles: 0,
          firstAuthor: 0,
          lastAuthor: 0,
          citations: 0,
          journals: [],
          journalCounts: new Map(),
        };
        byCwid.set(cwid, row);
      }
      row.articles++;
      if (roles.some((x) => x.position === "first")) row.firstAuthor++;
      if (roles.some((x) => x.position === "last")) row.lastAuthor++;
      row.citations += a.citations ?? 0;
      if (a.journal) row.journalCounts.set(a.journal, (row.journalCounts.get(a.journal) ?? 0) + 1);
    }
  }
  return [...byCwid.values()]
    .map(({ journalCounts, ...r }) => ({
      ...r,
      journals: [...journalCounts].sort((x, y) => y[1] - x[1]).map(([j]) => j),
    }))
    .sort((x, y) => y.articles - x.articles || x.name.localeCompare(y.name));
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
  total: number,
  list: HighImpactRow[] | null,
  generatedAt: Date,
  labels?: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const bold = (ws: ExcelJS.Worksheet, r: number) => (ws.getRow(r).font = { bold: true });
  const overCap = `${total.toLocaleString()} articles exceeds the ${HIGH_IMPACT_LIST_CAP.toLocaleString()}-row limit for this sheet. Narrow the filters to list them.`;

  // People first: the report is about who. A list of scholars is a scholar
  // export, so above SCHOLAR_EXPORT_CAP the sheet is withheld, never truncated.
  const summary = wb.addWorksheet("People");
  const people = list ? summarizePeople(list) : null;
  if (!people) {
    summary.addRow([overCap]);
  } else if (people.length > SCHOLAR_EXPORT_CAP) {
    summary.addRow([
      `${people.length.toLocaleString()} people match. The people list is only included for ${SCHOLAR_EXPORT_CAP} or fewer; narrow the filters (e.g. by department) to include it. The page's Summary tab lists everyone.`,
    ]);
    summary.getColumn(1).width = 100;
  } else {
    summary.addRow([
      "Name",
      "CWID",
      "Department",
      "Person type",
      "Articles",
      "As first author",
      "As last author",
      "NIH citations",
      "Journals",
    ]);
    bold(summary, 1);
    summary.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of people) {
      summary.addRow([
        r.name,
        r.cwid,
        r.department,
        r.personType,
        r.articles,
        r.firstAuthor,
        r.lastAuthor,
        r.citations,
        r.journals.join("; "),
      ]);
    }
    for (const [i, w] of [28, 10, 30, 22, 10, 12, 12, 12, 60].entries()) summary.getColumn(i + 1).width = w;
    summary.getColumn(9).alignment = { wrapText: true, vertical: "top" };
  }

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
    pubs.addRow([overCap]);
  }

  const criteria = wb.addWorksheet("Criteria");
  criteria.addRow(["Criterion", "Value"]);
  bold(criteria, 1);
  for (const [k, v] of describeHighImpactCriteria(p, generatedAt, labels)) criteria.addRow([k, v]);
  criteria.getColumn(1).width = 32;
  criteria.getColumn(2).width = 100;
  criteria.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
