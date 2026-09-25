/**
 * Report 9 — "Top clinical and high-impact journal publications": articles in a fixed set of
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
  POSITION_LABEL,
  scopeSql,
  type ArticleCountParams,
} from "@/lib/edit/article-count-report";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { citationIdentifier, formatVolIssuePages } from "@/lib/citation";
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
 *  the URL means the form was submitted, and the URL is taken as-is. The year
 *  basis is report 8's (`basis=fy`: fiscal year July–June by the PubMed add
 *  date, `scopeSql`); absent = calendar year, which is what every link made
 *  before the redesign meant (they never carried `basis`). `jif` is ignored:
 *  an impact-factor floor belongs to report 8. */
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
    jif: 0,
    journals: journals.length > 0 ? journals : [...known],
    view: sp.get("view") === "publications" ? "publications" : "summary",
  };
}

export function highImpactQueryString(p: HighImpactParams, view: HighImpactView = p.view): string {
  const q = new URLSearchParams(articleCountQueryString(p));
  q.delete("jif");
  if (p.basis === "cy") q.delete("basis");
  for (const j of p.journals) q.append("journal", j);
  q.set("view", view);
  return q.toString();
}

export type HighImpactTotals = {
  /** Distinct articles in scope — decides whether the list is loaded. */
  articles: number;
  /** Distinct matching scholars — the headline number, and whether the
   *  download's People sheet is withheld (`SCHOLAR_EXPORT_CAP`). Known even
   *  when the list is over its cap. */
  scholars: number;
};

export async function loadHighImpactTotals(p: HighImpactParams): Promise<HighImpactTotals> {
  const { fromWhere } = scopeSql(p, journalSql(p.journals));
  const [row] = await db.read.$queryRaw<{ n: bigint | number; s: bigint | number }[]>`
    SELECT COUNT(DISTINCT pa.pmid) AS n, COUNT(DISTINCT pa.cwid) AS s
    ${fromWhere}`;
  return { articles: Number(row?.n ?? 0), scholars: Number(row?.s ?? 0) };
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
  /** `2024;83(4):500-510.` — the citation after the journal name. */
  cite: string;
  /** The identifier as the page prints it (`citationIdentifier`): `PMID`
   *  linked to PubMed, an external source unlinked. */
  id: { label: string; value: string; href: string | null };
  /** The byline, shortened for the page (`authorSegments`); `wcm` marks a
   *  matching WCM author, `gap` an elision. Empty when no author string is on file. */
  byline: BylineSegment[];
  /** Matching WCM authors: `Name (first author)` / `(last author)` / `(middle author)`. */
  authors: string[];
  /** The same authors, structured, for the people summary. */
  people: { cwid: string; name: string; department: string | null; personType: string; position: AuthorRole }[];
};

export type AuthorRole = "first" | "last" | "middle";

export type BylineSegment = { text: string; wcm?: boolean; gap?: boolean };

/** The byline the page prints: every author up to `max`; past that the first
 *  three, each matching WCM author (whatever their rank) and the last author,
 *  with a `gap` wherever authors were skipped — a consortium paper's 400
 *  names never bury the WCM author the report is about. `wcm` holds 0-based
 *  indexes into `tokens`. */
export function authorSegments(tokens: readonly string[], wcm: ReadonlySet<number>, max = 10): BylineSegment[] {
  const keep =
    tokens.length <= max
      ? tokens.map((_, i) => i)
      : [...new Set([0, 1, 2, ...[...wcm].filter((i) => i >= 0 && i < tokens.length), tokens.length - 1])].sort(
          (a, b) => a - b,
        );
  const out: BylineSegment[] = [];
  keep.forEach((i, k) => {
    if (k > 0 && i !== keep[k - 1] + 1) out.push({ text: "…", gap: true });
    out.push(wcm.has(i) ? { text: tokens[i], wcm: true } : { text: tokens[i] });
  });
  return out;
}

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
  volume: string | null;
  issue: string | null;
  pages: string | null;
  full_authors_string: string | null;
  authors_string: string | null;
  position: number;
  preferred_name: string;
  cwid: string;
  primary_department: string | null;
  role_category: string | null;
  is_first: number | boolean;
  is_last: number | boolean;
};

/** One row per article, highest impact factor first (the download's order;
 *  the page re-sorts). */
export async function loadHighImpactList(p: HighImpactParams): Promise<HighImpactRow[]> {
  const { fromWhere } = scopeSql(p, journalSql(p.journals));
  const raw = await db.read.$queryRaw<RawRow[]>`
    SELECT p.pmid, p.title, p.journal, p.year, p.publication_type, j.impact_score_1 AS jif,
           p.date_added_to_entrez, p.cited_by_count, p.doi, p.volume, p.issue, p.pages,
           p.full_authors_string, p.authors_string, pa.position, s.preferred_name, s.cwid,
           s.primary_department, s.role_category, pa.is_first, pa.is_last
    ${fromWhere}
     ORDER BY j.impact_score_1 DESC, p.date_added_to_entrez DESC, p.pmid, pa.position`;
  const byPmid = new Map<string, HighImpactRow>();
  // The matching authors' byline ranks (1-based `position`; 0 = rank unknown,
  // never bolded), gathered before each byline is shortened.
  const ranks = new Map<string, { tokens: string[]; wcm: Set<number> }>();
  for (const r of raw) {
    let row = byPmid.get(r.pmid);
    if (!row) {
      // `full_authors_string` is comma-separated `Lastname Initials` tokens;
      // `authors_string` is the truncated fallback with `((...))` WCM markup.
      const tokens = (r.full_authors_string ?? r.authors_string ?? "")
        .replace(/\(\(|\)\)/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      ranks.set(r.pmid, { tokens, wcm: new Set() });
      const vip = formatVolIssuePages(r.volume, r.issue, r.pages);
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
        cite: r.year === null ? "" : vip ? `${r.year};${vip}.` : `${r.year}.`,
        id: citationIdentifier(r.pmid),
        byline: [],
        authors: [],
        people: [],
      };
      byPmid.set(r.pmid, row);
    }
    if (r.position > 0) ranks.get(r.pmid)!.wcm.add(Number(r.position) - 1);
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
  for (const row of byPmid.values()) {
    const { tokens, wcm } = ranks.get(row.pmid)!;
    row.byline = authorSegments(tokens, wcm);
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
  /** Their articles in the list, with their position on each (first wins
   *  over last when somehow listed twice) — the page's expanded row. */
  pubs: { pmid: string; position: AuthorRole }[];
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
          pubs: [],
          journalCounts: new Map(),
        };
        byCwid.set(cwid, row);
      }
      row.articles++;
      const first = roles.some((x) => x.position === "first");
      const last = roles.some((x) => x.position === "last");
      if (first) row.firstAuthor++;
      if (last) row.lastAuthor++;
      row.pubs.push({ pmid: a.pmid, position: first ? "first" : last ? "last" : "middle" });
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
  const rows = describeCriteria(p, generatedAt, labels).filter(([k]) => k !== "Minimum Journal Impact Factor");
  rows[0] = ["Report", "9. Top clinical and high-impact journal publications"];
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
      `${people.length.toLocaleString()} people match. The people list is only included for ${SCHOLAR_EXPORT_CAP} or fewer; narrow the filters (e.g. by department) to include it. The page's Scholars tab lists everyone.`,
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

/** The bare-URL (awards) defaults, the "Reset to defaults" target. */
export function isHighImpactDefault(p: HighImpactParams): boolean {
  const d = parseHighImpactParams(new URLSearchParams());
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  return (
    same(p.types, d.types) &&
    same(p.units, d.units) &&
    same(p.atypes, d.atypes) &&
    same(p.journals, d.journals) &&
    p.pos === d.pos &&
    p.basis === d.basis &&
    p.from === d.from &&
    p.to === d.to
  );
}

/** A year as the rail and chips print it: `2026`, or `FY2026` on the fiscal basis. */
export function yearLabel(p: Pick<HighImpactParams, "basis">, y: number): string {
  return p.basis === "fy" ? `FY${y}` : String(y);
}

export function yearRangeLabel(p: Pick<HighImpactParams, "basis" | "from" | "to">): string {
  return p.from === p.to ? yearLabel(p, p.from) : `${yearLabel(p, p.from)}–${yearLabel(p, p.to)}`;
}

export type HighImpactChip = {
  group: string;
  value: string;
  /** The query string without this filter; null = not removable. */
  removeQuery: string | null;
};

/**
 * The active filters as chips (the mockup's rules): years and — when every
 * family is on — journals always show, unremovable; each other facet shows
 * one chip per value up to three, else one "N selected" chip that clears it;
 * author position shows unless it is "Any". Removing a chip never yields a
 * bare URL (`from` / `to` / `pos` always ride along), so the awards defaults
 * never come back by surprise.
 */
export function highImpactChips(
  p: HighImpactParams,
  unitLabel: ReadonlyMap<string, string> = new Map(),
): HighImpactChip[] {
  const qs = (next: Partial<HighImpactParams>) => highImpactQueryString({ ...p, ...next });
  const chips: HighImpactChip[] = [{ group: "Years", value: yearRangeLabel(p), removeQuery: null }];
  const facet = (
    group: string,
    values: readonly string[],
    label: (v: string) => string,
    without: (keep: (v: string) => boolean) => Partial<HighImpactParams>,
  ) => {
    if (values.length === 0) return;
    if (values.length > 3) {
      chips.push({ group, value: `${values.length} selected`, removeQuery: qs(without((v) => !values.includes(v))) });
      return;
    }
    for (const v of values) chips.push({ group, value: label(v), removeQuery: qs(without((x) => x !== v)) });
  };
  if (p.journals.length === JOURNAL_FAMILIES.length) {
    chips.push({ group: "Journals", value: `All ${JOURNAL_FAMILIES.length} top-tier families`, removeQuery: null });
  } else {
    // An empty list means every family, so clearing is dropping them all.
    facet(
      "Journals",
      p.journals,
      (k) => JOURNAL_FAMILIES.find((f) => f.key === k)?.label ?? k,
      (keep) => ({ journals: p.journals.filter(keep) }),
    );
  }
  facet("Person type", p.types, (t) => formatRoleCategory(t) ?? t, (keep) => ({ types: p.types.filter(keep) }));
  const unitGroups: [string, (u: string) => boolean][] = [
    ["Department / division", (u) => u.startsWith("dept:") || u.startsWith("div:")],
    ["Centers", (u) => u.startsWith("center:")],
    ["Institution", (u) => u.startsWith("inst:")],
  ];
  for (const [group, inGroup] of unitGroups) {
    const mine = p.units.filter(inGroup);
    facet(
      group,
      mine,
      (u) => unitLabel.get(u) ?? u,
      (keep) => ({ units: p.units.filter((u) => !inGroup(u) || keep(u)) }),
    );
  }
  facet("Article type", p.atypes, (a) => a, (keep) => ({ atypes: p.atypes.filter(keep) }));
  if (p.pos !== "any") chips.push({ group: "Author", value: POSITION_LABEL[p.pos], removeQuery: qs({ pos: "any" }) });
  return chips;
}

/** The note under the Download button: which sheets the workbook carries,
 *  and why one is left out. `withheld` → the page shows it as a warning. */
export function highImpactDownloadNote(totals: HighImpactTotals): { text: string; withheld: boolean } {
  if (totals.articles > HIGH_IMPACT_LIST_CAP) {
    return {
      text: `Includes the Criteria sheet only: ${totals.articles.toLocaleString()} articles is more than ${HIGH_IMPACT_LIST_CAP.toLocaleString()}. Narrow the filters to include the People and Publications sheets.`,
      withheld: true,
    };
  }
  if (totals.scholars > SCHOLAR_EXPORT_CAP) {
    return {
      text: `Includes the Criteria and Publications sheets. The People sheet is left out above ${SCHOLAR_EXPORT_CAP} people (${totals.scholars.toLocaleString()} match); narrow the filters to include it.`,
      withheld: true,
    };
  }
  return { text: "Includes the Criteria, People and Publications sheets.", withheld: false };
}
