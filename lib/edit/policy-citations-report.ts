/**
 * Report 24 — "Guideline and policy citations": WCM publications cited by a
 * health authority (WHO, NICE, CDC, AHRQ, the National Academies), a clinical
 * guideline, a consensus statement or a systematic review, by publication or
 * by person. Reads what the weekly `etl:policy-citations` step maintains
 * (`citing_document`, `publication_citing_document`); writes nothing.
 *
 * Who counts is report 8's rule: only ReCiter-confirmed authorships of active
 * scholars, the shared who-filter (`parsePersonFilter` / `personFilterSql`).
 *
 * Access: any unit administrator can open it, and for them every query is
 * narrowed to the units they administer (`scope`, AND-ed with whatever the URL
 * selects, so a URL can only narrow further); superusers and comms stewards
 * see everything (`scope: null`). `scope` is never read from the URL: the
 * parser leaves it `[]` (match nothing) and `resolvePolicyCitationParams` sets
 * it from the session, on the page and in the download route alike.
 *
 * What the filters do:
 *   - `type`, `unit`, `person`, `pos`, `basis` + `from` / `to` pick the
 *     authorships, and so the publications. A bare URL starts at
 *     `DEFAULT_FROM`.
 *   - `body`, `cfrom` / `cto`, `excl` (hide excluded-study citations) pick
 *     which citing documents are counted, in every number on the page.
 *   - `level` picks which publications, citing documents and people are
 *     LISTED (one with a counted document at a ticked level); the counts and
 *     the tiles still cover all four levels. A bare URL lists the three above
 *     reviews.
 *   - `view`, `sort`, `dsort`, `q` (the tab's search) and `page` are view
 *     state, not filters.
 *
 * A citing document counts once per publication however many journals printed
 * it (`dedup_key`). Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import type { EditSession } from "@/lib/auth/superuser";
import { formatVolIssuePages } from "@/lib/citation";
import { ISSUING_BODIES } from "@/lib/citations/issuing-bodies";
import { db } from "@/lib/db";
import { articleCountDefaultUnits, articleYearExpr, BASIS_LABEL, type YearBasis } from "@/lib/edit/article-count-report";
import { parsePersonFilter, personFilterCriteria, personFilterSql } from "@/lib/edit/person-filter";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import { Prisma } from "@/lib/generated/prisma/client";
import { institutionDisplayName } from "@/lib/institutions";
import { formatRoleCategory } from "@/lib/role-display";
import { htmlToPlainText } from "@/lib/utils";

/** Highest first: the ranked sort's order. */
export const LEVELS = ["authority", "guideline", "consensus", "review"] as const;
export type Level = (typeof LEVELS)[number];
export type LevelCounts = Record<Level, number>;

export const LEVEL_LABEL: Record<Level, string> = {
  authority: "Health authorities",
  guideline: "Clinical guidelines",
  consensus: "Consensus statements",
  review: "Systematic reviews",
};
export const LEVEL_ONE: Record<Level, string> = {
  authority: "Health authority",
  guideline: "Clinical guideline",
  consensus: "Consensus statement",
  review: "Systematic review",
};

/** What a bare URL lists: everything above systematic reviews. */
/** The levels with few enough links to list and chart by citing document. */
export const DOC_LEVELS = ["authority", "guideline", "consensus"] as const;
export type DocLevel = (typeof DOC_LEVELS)[number];
const DEFAULT_LEVELS: readonly Level[] = DOC_LEVELS;
/** What a bare URL starts at: publications from this calendar year on. */
export const DEFAULT_FROM = 2020;
/** Rows per page, on every tab. */
export const POLICY_PAGE_SIZE = 50;

export const BODIES: readonly string[] = [...new Set(ISSUING_BODIES.map(([, body]) => body))];
/** WHO's documents include IARC's (`ISSUING_BODIES`). */
export const bodyLabel = (body: string) => (body === "WHO" ? "WHO (including IARC)" : body);
/** The line under a body's short name. */
export const BODY_NAME: Record<string, string> = {
  WHO: "World Health Organization, including its cancer agency IARC",
  NICE: "National Institute for Health and Care Excellence (UK)",
  CDC: "Centers for Disease Control and Prevention (US)",
  AHRQ: "Agency for Healthcare Research and Quality (US)",
  "National Academies": "National Academies of Sciences, Engineering, and Medicine (US)",
};

export const POSITION_LABEL = {
  first: "First author",
  last: "Last author",
  middle: "Middle author",
} as const;
export type Position = keyof typeof POSITION_LABEL;

export const SORT_LABEL = {
  ranked: "Highest level, most distinct documents",
  guidelines: "Most guidelines",
  recent: "Most recently cited",
  year: "Publication year",
} as const;
export type PolicySort = keyof typeof SORT_LABEL;

export const DOC_SORT_LABEL = {
  recent: "Most recent first",
  papers: "Most WCM papers cited",
  body: "Issuing body",
} as const;
export type DocSort = keyof typeof DOC_SORT_LABEL;

export type PolicyView = "publications" | "documents" | "people";

export type PolicyCitationParams = {
  /** Raw roleCategory values (`type`). */
  types: string[];
  /** Encoded unit values (`unit`), kept raw so they round-trip. */
  units: string[];
  /** CWIDs (`person`). */
  people: string[];
  /** `pos`; empty = any position. */
  positions: Position[];
  /** `level`; empty = every level. Picks what is listed, not what is counted. */
  levels: Level[];
  /** `body`; empty = any issuing body. */
  bodies: string[];
  /** `excl=1`: links that only list the paper as an excluded study do not count. */
  hideExcluded: boolean;
  basis: YearBasis;
  /** Publication years (`from` / `to`); null = open. */
  from: number | null;
  to: number | null;
  /** Citing-document years (`cfrom` / `cto`), calendar; null = open. */
  cfrom: number | null;
  cto: number | null;
  view: PolicyView;
  sort: PolicySort;
  /** The By citing document tab's order (`dsort`). */
  docSort: DocSort;
  /** The current tab's search (`q`); "" = none. */
  q: string;
  /** 1-based (`page`). */
  page: number;
  /** The viewer's units (`resolvePolicyCitationParams`): null = everything,
   *  [] = nothing. Never from the URL. */
  scope: string[] | null;
};

const VIEW_KEYS = new Set(["view", "sort", "dsort", "q", "page"]);

/** Every param is optional; a stray value is dropped. A bare URL (nothing but
 *  view state) gets `DEFAULT_LEVELS` and `DEFAULT_FROM`; any filter in the URL
 *  means the form was submitted and the URL is taken as-is (no level ticked =
 *  every level, no `from` = any year). The rail always submits `basis`, so
 *  clearing everything never brings the defaults back. */
export function parsePolicyCitationParams(sp: URLSearchParams): PolicyCitationParams {
  const bare = ![...sp.keys()].some((k) => !VIEW_KEYS.has(k));
  const person = parsePersonFilter(sp);
  const among = <T extends string>(k: string, allowed: readonly T[]): T[] => {
    const given = sp.getAll(k);
    return allowed.filter((v) => given.includes(v));
  };
  const one = <T extends string>(k: string, allowed: readonly T[], dflt: T): T =>
    allowed.find((v) => v === sp.get(k)) ?? dflt;
  const range = (a: string, b: string): [number | null, number | null] => {
    const year = (k: string) => {
      const n = Number.parseInt(sp.get(k) ?? "", 10);
      return Number.isFinite(n) ? Math.min(2100, Math.max(1900, n)) : null;
    };
    const lo = year(a);
    const hi = year(b);
    return [lo, lo !== null && hi !== null ? Math.max(lo, hi) : hi];
  };
  const [from, to] = range("from", "to");
  const [cfrom, cto] = range("cfrom", "cto");
  const page = Number.parseInt(sp.get("page") ?? "", 10);
  return {
    types: person.types,
    units: person.unitValues,
    people: [...new Set(sp.getAll("person").map((v) => v.trim()))].filter((v) => /^[A-Za-z0-9]{2,16}$/.test(v)),
    positions: among("pos", Object.keys(POSITION_LABEL) as Position[]),
    levels: bare ? [...DEFAULT_LEVELS] : among("level", LEVELS),
    bodies: among("body", BODIES),
    hideExcluded: sp.get("excl") === "1",
    basis: one("basis", Object.keys(BASIS_LABEL) as YearBasis[], "cy"),
    from: bare ? DEFAULT_FROM : from,
    to,
    cfrom,
    cto,
    view: one("view", ["publications", "documents", "people"] as const, "publications"),
    sort: one("sort", Object.keys(SORT_LABEL) as PolicySort[], "ranked"),
    docSort: one("dsort", Object.keys(DOC_SORT_LABEL) as DocSort[], "recent"),
    q: (sp.get("q") ?? "").trim().slice(0, 100),
    page: Number.isFinite(page) ? Math.min(100_000, Math.max(1, page)) : 1,
    scope: [],
  };
}

/** The canonical query string: the download link, the chips, the tabs and
 *  the row links build on it. Always carries `basis`, so it is never bare.
 *  `page` rides only when asked for: any other change starts at page 1. */
export function policyCitationQueryString(p: PolicyCitationParams, over: Partial<PolicyCitationParams> = {}): string {
  const x = { ...p, page: 1, ...over };
  const q = new URLSearchParams();
  for (const t of x.types) q.append("type", t);
  for (const u of x.units) q.append("unit", u);
  for (const c of x.people) q.append("person", c);
  for (const v of x.positions) q.append("pos", v);
  for (const l of x.levels) q.append("level", l);
  for (const b of x.bodies) q.append("body", b);
  if (x.hideExcluded) q.set("excl", "1");
  q.set("basis", x.basis);
  for (const k of ["from", "to", "cfrom", "cto"] as const) if (x[k] !== null) q.set(k, String(x[k]));
  if (x.view !== "publications") q.set("view", x.view);
  if (x.sort !== "ranked") q.set("sort", x.sort);
  if (x.docSort !== "recent") q.set("dsort", x.docSort);
  if (x.q) q.set("q", x.q);
  if (x.page > 1) q.set("page", String(x.page));
  return q.toString();
}

/** Nothing set beyond what a bare URL gets (the "Reset to defaults" test). */
export function isPolicyCitationDefault(p: PolicyCitationParams): boolean {
  const d = parsePolicyCitationParams(new URLSearchParams());
  const filters = (x: PolicyCitationParams) =>
    policyCitationQueryString(x, { view: "publications", sort: "ranked", docSort: "recent", q: "" });
  return filters(p) === filters(d);
}

// ---------------------------------------------------------------------------
// Access: the viewer's units, forced onto every query.
// ---------------------------------------------------------------------------

type SessionLike = Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward">;

/** null = everything (superuser, comms steward); otherwise the units the
 *  viewer administers as `unit` values (report 8's `articleCountDefaultUnits`:
 *  direct `unit_admin` grants on a department, division, center or
 *  institution). [] = administers none of those: no access. */
export async function loadPolicyCitationScope(session: SessionLike): Promise<string[] | null> {
  if (session.isSuperuser || session.isCommsSteward) return null;
  return articleCountDefaultUnits(session);
}

/** The access badge's rule line (the report header and the index row). */
export const POLICY_CITATIONS_ACCESS_RULE =
  "Every administrator of a department, division, center or institution can run it for the units they administer. Superusers and comms stewards see every unit.";

/** The gate, for the page and the index: someone with something to see. */
export async function canViewPolicyCitationsReport(session: SessionLike): Promise<boolean> {
  const scope = await loadPolicyCitationScope(session);
  return scope === null || scope.length > 0;
}

/** What the page and the download both do after parsing: pin the scope. */
export async function resolvePolicyCitationParams(
  p: PolicyCitationParams,
  session: SessionLike,
): Promise<PolicyCitationParams> {
  return { ...p, scope: await loadPolicyCitationScope(session) };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const yearWindow = (expr: Prisma.Sql, lo: number | null, hi: number | null): Prisma.Sql =>
  lo !== null && hi !== null
    ? Prisma.sql`AND ${expr} BETWEEN ${lo} AND ${hi}`
    : lo !== null
      ? Prisma.sql`AND ${expr} >= ${lo}`
      : hi !== null
        ? Prisma.sql`AND ${expr} <= ${hi}`
        : Prisma.empty;

/** An excluded-study citation: a link whose every location names an
 *  excluded-studies list (a review's "Excluded Studies" appendix), so the
 *  document looked at the paper and set it aside. */
export function isExcludedStudyCitation(locations: readonly { label: string }[]): boolean {
  return locations.length > 0 && locations.every((x) => /excluded/i.test(x.label));
}

/** The same test on `l` (`publication_citing_document`), negated: keeps a
 *  link unless every label matches. `JSON_SEARCH` returns one path or an array
 *  of them (`JSON_LENGTH` 1 or n) and NULL for no match or no locations, which
 *  keeps the link. JSON text compares case-sensitively, hence the `LOWER`.
 *  ponytail: computed per link, so it needs the live aggregate. Staging
 *  (Aurora MySQL 8.0, 390,000 links, 4,329 of them excluded-study,
 *  2026-11-25): the per-publication pass takes 4.6 s with it, 3.6 s for the
 *  live aggregate alone, 0.4 s off the rollups. A flag on the link, set by
 *  `etl:policy-citations` and folded into the rollups, is the upgrade. */
const NOT_EXCLUDED_SQL = Prisma.sql`AND COALESCE(JSON_LENGTH(JSON_SEARCH(LOWER(CAST(l.locations AS CHAR)), 'all', '%excluded%', NULL, '$[*].label')) = JSON_LENGTH(l.locations), 0) = 0`;

/** Which citing documents are counted (`d` = `citing_document`, `l` = the link). */
function docSql(p: PolicyCitationParams): Prisma.Sql {
  return Prisma.sql`${p.bodies.length > 0 ? Prisma.sql`AND d.issuing_body IN (${Prisma.join(p.bodies)})` : Prisma.empty}
       ${yearWindow(Prisma.sql`d.year`, p.cfrom, p.cto)}
       ${p.hideExcluded ? NOT_EXCLUDED_SQL : Prisma.empty}`;
}

const POSITION_SQL: Record<Position, Prisma.Sql> = {
  first: Prisma.sql`pa.is_first = 1`,
  last: Prisma.sql`pa.is_last = 1`,
  middle: Prisma.sql`(pa.is_first = 0 AND pa.is_last = 0)`,
};

/** The viewer's units alone, as a condition on `s`. */
const viewerScopeSql = (p: PolicyCitationParams): Prisma.Sql =>
  p.scope === null
    ? Prisma.empty
    : p.scope.length === 0
      ? Prisma.sql`AND 1 = 0`
      : personFilterSql({ types: [], unitValues: p.scope }, { scholar: "s", centerMembership: "scm" });

/** Which authorships count, as conditions on `pa` (`publication_author`) and
 *  `s` (`scholar`). The viewer's scope is its own `personFilterSql` clause,
 *  AND-ed with the URL's selection: a `unit` outside the scope matches nobody.
 *  `people: false` leaves the `person` filter out (the Person facet's own
 *  counts, which must not collapse to the people already ticked). */
export function policyScopeSql(p: PolicyCitationParams, opts: { people?: boolean } = {}): Prisma.Sql {
  const scope = viewerScopeSql(p);
  const listCwids = opts.people !== false && p.people.length > 0 ? p.people : null;
  return Prisma.sql`pa.is_confirmed = 1
       AND s.deleted_at IS NULL AND s.status = 'active'
       ${scope}
       ${personFilterSql({ types: p.types, unitValues: p.units, listCwids }, { scholar: "s", centerMembership: "cm" })}
       ${p.positions.length > 0 ? Prisma.sql`AND (${Prisma.join(p.positions.map((k) => POSITION_SQL[k]), " OR ")})` : Prisma.empty}`;
}

/** "This publication has a matching authorship": a semi-join, so a paper with
 *  five matching authors is still one row. */
const hasAuthorSql = (p: PolicyCitationParams, pmid: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`EXISTS (SELECT 1 FROM publication_author pa
                 JOIN scholar s ON s.cwid = pa.cwid
                WHERE pa.pmid = ${pmid} AND ${policyScopeSql(p)})`;

/** The publication-year window (`p` = `publication`). */
const pubYearSql = (p: PolicyCitationParams): Prisma.Sql =>
  yearWindow(articleYearExpr({ basis: p.basis, added: null }), p.from, p.to);

/** A filter on the citing documents themselves (issuing body, citing year,
 *  excluded-study citations hidden). */
const hasDocFilter = (p: PolicyCitationParams): boolean =>
  p.bodies.length > 0 || p.cfrom !== null || p.cto !== null || p.hideExcluded;

/**
 * `x`: one row per cited publication, its counted documents per level, with
 * no author in sight; people are attached afterwards.
 *
 * Two sources, one switch. With no filter on the documents, `x` reads the
 * rollup columns `etl:policy-citations` keeps on `publication`. With one, the
 * rollups no longer answer the question and `x` is the live aggregate over the
 * links. Measured on staging (390,000 links, 2026-11-25): the live aggregate
 * costs about 3 s wherever it appears, and one page load evaluated it in six
 * queries, 19 s in all; joining links to authorships before the
 * `COUNT(DISTINCT …)`, the first shape, took 56 s cold.
 */
export function citedSql(p: PolicyCitationParams): Prisma.Sql {
  if (!hasDocFilter(p)) {
    return Prisma.sql`(SELECT pmid, latest_citing_year AS latest, authority_count AS authority,
               guideline_count AS guideline, consensus_count AS consensus, review_count AS review
          FROM publication
         WHERE authority_count > 0 OR guideline_count > 0 OR consensus_count > 0 OR review_count > 0) x`;
  }
  const counts = Prisma.join(
    LEVELS.map(
      (l) => Prisma.sql`COUNT(DISTINCT CASE WHEN d.level = ${l} THEN d.dedup_key END) AS ${Prisma.raw(l)}`,
    ),
    ", ",
  );
  return Prisma.sql`(SELECT l.pmid, MAX(d.year) AS latest, ${counts}
          FROM publication_citing_document l
          JOIN citing_document d ON d.id = l.citing_document_id
         WHERE 1 = 1
           ${docSql(p)}
         GROUP BY l.pmid) x`;
}

/** `ok`: these publications, less any the viewer may not see. The PMIDs come
 *  from a listing that was already narrowed; testing the who clause again
 *  here, once per publication and never per link, keeps every query scoped on
 *  its own. */
const scopedPubsSql = (p: PolicyCitationParams, pmids: readonly string[]): Prisma.Sql => Prisma.sql`(SELECT p.pmid
          FROM publication p
         WHERE p.pmid IN (${Prisma.join([...pmids])})
           AND ${hasAuthorSql(p, Prisma.sql`p.pmid`)}) ok`;

/** `COUNT(CASE WHEN x.<level> > 0 THEN 1 END) AS <level>`, per level: the
 *  rows of `x` cited at each level. */
const citedCounts = Prisma.join(
  LEVELS.map((l) => Prisma.sql`COUNT(CASE WHEN x.${Prisma.raw(l)} > 0 THEN 1 END) AS ${Prisma.raw(l)}`),
  ", ",
);

type Num = bigint | number;
const toCounts = (r: Record<Level, Num>): LevelCounts => ({
  authority: Number(r.authority),
  guideline: Number(r.guideline),
  consensus: Number(r.consensus),
  review: Number(r.review),
});

// ---------------------------------------------------------------------------
// Counts, ranking, what is listed
// ---------------------------------------------------------------------------

export type PubCounts = LevelCounts & {
  pmid: string;
  year: number | null;
  /** The newest counted citing document's year. */
  latest: number | null;
};

/** Authority documents first, then guidelines, then consensus statements,
 *  then reviews: each level only breaks a tie in the one above. Never shown
 *  as a number.
 *  ponytail: the counts are per `dedup_key`, so six editions of one authority
 *  document rank as six; the rows group them (`groupEditions`). Ranking on
 *  grouped documents needs an edition key stored by `etl:policy-citations`. */
export function compareRanked(a: LevelCounts, b: LevelCounts): number {
  for (const l of LEVELS) if (a[l] !== b[l]) return b[l] - a[l];
  return 0;
}

const newestFirst = (a: PubCounts, b: PubCounts) => (b.year ?? 0) - (a.year ?? 0) || a.pmid.localeCompare(b.pmid);

/** Every sort falls back to the ranked order, then publication year, newest first. */
export function sortPublications<T extends PubCounts>(rows: readonly T[], sort: PolicySort): T[] {
  const lead: Record<PolicySort, (a: T, b: T) => number> = {
    ranked: () => 0,
    guidelines: (a, b) => b.guideline - a.guideline,
    recent: (a, b) => (b.latest ?? 0) - (a.latest ?? 0),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  };
  return [...rows].sort((a, b) => lead[sort](a, b) || compareRanked(a, b) || newestFirst(a, b));
}

/** The rows with a counted document at a ticked level (none ticked = any). */
export function listedAt<T extends LevelCounts>(rows: readonly T[], levels: readonly Level[]): T[] {
  const want = levels.length > 0 ? levels : LEVELS;
  return rows.filter((r) => want.some((l) => r[l] > 0));
}

/** Papers cited at each level, one tile per level. */
export function policyTiles(rows: readonly LevelCounts[]): LevelCounts {
  const n = (l: Level) => rows.filter((r) => r[l] > 0).length;
  return { authority: n("authority"), guideline: n("guideline"), consensus: n("consensus"), review: n("review") };
}

/** One row per cited publication in scope, every level, unsorted: fetched
 *  once, and both the tiles and the listed rows are derived from it in Node
 *  (at most about 81,000 small rows) rather than by two passes over `x`.
 *
 *  `STRAIGHT_JOIN` pins the order as written: the cited publications, then
 *  each one's authorships by index. `GROUP BY` on the publication key folds a
 *  paper with several matching authors back to one row; the other columns are
 *  one value per publication, so `MAX()` just names it (valid under
 *  ONLY_FULL_GROUP_BY on MariaDB and MySQL alike). With the rollup source the
 *  counts are read straight off `p`, with no second visit to `publication`.
 *  Measured on staging (Aurora MySQL, 76,655 cited publications, 2026-11-25):
 *  this form 1.2 s, the same join with `DISTINCT` 5.0 to 7.8 s, an `EXISTS`
 *  on the authorships 2.7 s. */
export async function loadPublicationCounts(p: PolicyCitationParams): Promise<PubCounts[]> {
  const live = hasDocFilter(p);
  const key = live ? Prisma.sql`x.pmid` : Prisma.sql`p.pmid`;
  const col = (l: Level | "latest") =>
    live ? Prisma.sql`x.${Prisma.raw(l)}` : Prisma.sql`p.${Prisma.raw(l === "latest" ? "latest_citing_year" : `${l}_count`)}`;
  const from = live
    ? Prisma.sql`${citedSql(p)}
      JOIN publication p ON p.pmid = x.pmid`
    : Prisma.sql`publication p`;
  const isCited = live
    ? Prisma.empty
    : Prisma.sql`(${Prisma.join(LEVELS.map((l) => Prisma.sql`${col(l)} > 0`), " OR ")}) AND `;
  const raw = await db.read.$queryRaw<(Record<Level, Num> & { pmid: string; year: number | null; latest: number | null })[]>`
    SELECT STRAIGHT_JOIN ${key} AS pmid, MAX(p.year) AS year, MAX(${col("latest")}) AS latest,
           ${Prisma.join(LEVELS.map((l) => Prisma.sql`MAX(${col(l)}) AS ${Prisma.raw(l)}`), ", ")}
      FROM ${from}
      JOIN publication_author pa ON pa.pmid = ${key}
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${isCited}${policyScopeSql(p)}
       ${pubYearSql(p)}
     GROUP BY ${key}`;
  return raw.map((r) => ({
    pmid: r.pmid,
    year: r.year === null ? null : Number(r.year),
    latest: r.latest === null ? null : Number(r.latest),
    ...toCounts(r),
  }));
}

const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

/** The cited publications in scope matching the By publication search: the
 *  PMID exactly, or the text in the title or in a matching author's name.
 *  Reads the rollups whatever the document filters are (it can only
 *  over-include; the caller intersects it with the listing). */
export async function searchPublications(p: PolicyCitationParams, q: string): Promise<Set<string>> {
  const like = likeArg(q);
  const raw = await db.read.$queryRaw<{ pmid: string }[]>`
    SELECT STRAIGHT_JOIN p.pmid
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE (p.authority_count > 0 OR p.guideline_count > 0 OR p.consensus_count > 0 OR p.review_count > 0)
       AND ${policyScopeSql(p)}
       ${pubYearSql(p)}
       AND (p.pmid = ${q} OR p.title LIKE ${like} OR s.preferred_name LIKE ${like})
     GROUP BY p.pmid`;
  return new Set(raw.map((r) => r.pmid));
}

export type PersonRow = LevelCounts & {
  cwid: string;
  name: string;
  orgUnit: string | null;
  personType: string;
  institution: string;
};

/** One row per scholar in scope: their papers cited at each level, ranked.
 *  `(pmid, cwid)` is unique among confirmed authorships (299,533 rows, 299,533
 *  distinct pairs on staging, 2026-11-25), so each `x` row reaches a scholar
 *  once and counting rows is counting distinct papers.
 *  Ignores the `person` filter (the Person facet reads it; the By person view
 *  applies the filter in `loadPolicyCitations`). */
export async function loadPersonCounts(p: PolicyCitationParams): Promise<PersonRow[]> {
  const raw = await db.read.$queryRaw<
    (Record<Level, Num> & {
      cwid: string;
      preferred_name: string;
      primary_department: string | null;
      role_category: string | null;
      primary_org_code: string | null;
    })[]
  >`
    SELECT STRAIGHT_JOIN s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code,
           ${citedCounts}
      FROM ${citedSql(p)}
      JOIN publication p ON p.pmid = x.pmid
      JOIN publication_author pa ON pa.pmid = x.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${policyScopeSql(p, { people: false })}
       ${pubYearSql(p)}
     GROUP BY s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code`;
  return raw
    .map((r) => ({
      cwid: r.cwid,
      name: r.preferred_name,
      orgUnit: r.primary_department,
      personType: formatRoleCategory(r.role_category) ?? "",
      institution: r.primary_org_code ? institutionDisplayName(r.primary_org_code) : "",
      ...toCounts(r),
    }))
    .sort((a, b) => compareRanked(a, b) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Publication rows and their citing documents
// ---------------------------------------------------------------------------

export type PubRow = PubCounts & {
  title: string;
  journal: string | null;
  doi: string | null;
  /** The confirmed, active WCM authors the viewer may see (everyone for a
   *  superuser, their units' people for a unit administrator), in byline order. */
  authors: { cwid: string; name: string; position: Position }[];
  /** Counted authority documents per issuing body, most first. */
  bodies: { body: string; count: number }[];
};

async function withDetails(p: PolicyCitationParams, rows: PubCounts[]): Promise<PubRow[]> {
  if (rows.length === 0) return [];
  const pmids = Prisma.join(rows.map((r) => r.pmid));
  const [pubs, bodies] = await Promise.all([
    db.read.$queryRaw<
      {
        pmid: string;
        title: string;
        journal: string | null;
        doi: string | null;
        cwid: string;
        preferred_name: string;
        is_first: number | boolean;
        is_last: number | boolean;
      }[]
    >`
      SELECT p.pmid, p.title, p.journal, p.doi, s.cwid, s.preferred_name, pa.is_first, pa.is_last
        FROM publication p
        JOIN publication_author pa ON pa.pmid = p.pmid
        JOIN scholar s ON s.cwid = pa.cwid
       WHERE p.pmid IN (${pmids})
         AND pa.is_confirmed = 1
         AND s.deleted_at IS NULL AND s.status = 'active'
         ${viewerScopeSql(p)}
       ORDER BY p.pmid, pa.position`,
    db.read.$queryRaw<{ pmid: string; body: string | null; n: Num }[]>`
      SELECT l.pmid, d.issuing_body AS body, COUNT(DISTINCT d.dedup_key) AS n
        FROM publication_citing_document l
        JOIN citing_document d ON d.id = l.citing_document_id
       WHERE l.pmid IN (${pmids})
         AND d.level = 'authority'
         ${docSql(p)}
       GROUP BY l.pmid, d.issuing_body`,
  ]);
  const out = new Map<string, PubRow>(
    rows.map((r) => [r.pmid, { ...r, title: "", journal: null, doi: null, authors: [], bodies: [] }]),
  );
  for (const r of pubs) {
    const row = out.get(r.pmid);
    if (!row || row.authors.some((a) => a.cwid === r.cwid)) continue;
    row.title = r.title;
    row.journal = r.journal;
    row.doi = r.doi;
    row.authors.push({
      cwid: r.cwid,
      name: r.preferred_name,
      position: r.is_first ? "first" : r.is_last ? "last" : "middle",
    });
  }
  for (const r of bodies) {
    if (r.body) out.get(r.pmid)?.bodies.push({ body: r.body, count: Number(r.n) });
  }
  for (const row of out.values()) row.bodies.sort((a, b) => b.count - a.count || a.body.localeCompare(b.body));
  return rows.map((r) => out.get(r.pmid)!);
}

export type CitingDoc = {
  id: number;
  dedupKey: string;
  level: Level;
  title: string;
  year: number | null;
  url: string;
  issuingBody: string | null;
  /** Every author as stored, "Ghany MG, Morgan TR"; null for Bookshelf. */
  authors: string | null;
  journal: string | null;
  /** `2024;83(4):500-510`, or the year alone. */
  cite: string;
  doi: string | null;
  /** Bookshelf: the publication statement. */
  publisher: string | null;
  pmid: string | null;
  bookshelfId: string | null;
  /** Bookshelf: the chapters and sections citing the paper. */
  locations: { url: string; label: string }[];
};

/** One entry per `dedupKey`, the first kept: the same guideline printed in
 *  several journals is one document, as the counts have it. */
export function dedupeDocs<T extends { dedupKey: string }>(docs: readonly T[]): T[] {
  const seen = new Set<string>();
  return docs.filter((d) => !seen.has(d.dedupKey) && seen.add(d.dedupKey));
}

const NCBI = "https://www.ncbi.nlm.nih.gov/";

/** A link's `locations` as stored. MariaDB hands a JSON column back as text
 *  through a raw query. Only NCBI links are kept. */
function parseLocations(raw: unknown): { url: string; label: string }[] {
  let locations = raw;
  if (typeof locations === "string") {
    try {
      locations = JSON.parse(locations);
    } catch {
      return [];
    }
  }
  return Array.isArray(locations)
    ? (locations as { url?: unknown; label?: unknown }[]).flatMap((x) =>
        typeof x?.url === "string" && x.url.startsWith(NCBI) && typeof x.label === "string"
          ? [{ url: x.url, label: x.label }]
          : [],
      )
    : [];
}

/** Systematic reviews listed under one publication on the page; the row's
 *  count is the full number and the spreadsheet's Citations sheet has the rest. */
export const REVIEWS_SHOWN = 20;

/** The counted citing documents of these publications (one page of rows),
 *  per PMID, highest level first, newest first within a level; at most
 *  `REVIEWS_SHOWN` reviews each. One query for the page, and only for
 *  publications the viewer may see (`scopedPubsSql`). */
export async function loadCitingDocuments(
  p: PolicyCitationParams,
  pmids: readonly string[],
): Promise<Map<string, CitingDoc[]>> {
  const out = new Map<string, CitingDoc[]>();
  if (pmids.length === 0) return out;
  const raw = await db.read.$queryRaw<
    {
      pmid: string;
      id: number;
      dedup_key: string;
      level: string;
      title: string;
      year: number | null;
      url: string;
      issuing_body: string | null;
      authors: string | null;
      journal: string | null;
      journal_abbrev: string | null;
      volume: string | null;
      issue: string | null;
      pages: string | null;
      doi: string | null;
      publisher: string | null;
      source: string;
      external_id: string;
      locations: unknown;
    }[]
  >`
    SELECT t.*
      FROM (SELECT ok.pmid, d.id, d.dedup_key, d.level, d.title, d.year, d.url, d.issuing_body, d.authors, d.journal,
                   d.journal_abbrev, d.volume, d.issue, d.pages, d.doi, d.publisher, d.source, d.external_id,
                   l.locations,
                   ROW_NUMBER() OVER (PARTITION BY ok.pmid, d.level ORDER BY d.year DESC, d.id) AS rn
              FROM ${scopedPubsSql(p, pmids)}
              JOIN publication_citing_document l ON l.pmid = ok.pmid
              JOIN citing_document d ON d.id = l.citing_document_id
             WHERE 1 = 1
               ${docSql(p)}) t
     WHERE t.level <> 'review' OR t.rn <= ${REVIEWS_SHOWN}
     ORDER BY t.year DESC, t.id`;
  for (const r of raw) {
    const level = LEVELS.find((l) => l === r.level);
    if (!level) continue;
    const vip = formatVolIssuePages(r.volume, r.issue, r.pages);
    const docs = out.get(r.pmid) ?? [];
    out.set(r.pmid, docs);
    docs.push({
      id: Number(r.id),
      dedupKey: r.dedup_key,
      level,
      title: r.title,
      year: r.year === null ? null : Number(r.year),
      url: r.url,
      issuingBody: r.issuing_body,
      authors: r.authors,
      journal: r.journal_abbrev ?? r.journal,
      cite: [r.year, vip].filter(Boolean).join(";"),
      doi: r.doi,
      publisher: r.publisher,
      pmid: r.source === "pubmed" ? r.external_id : null,
      bookshelfId: r.source === "bookshelf" ? r.external_id : null,
      locations: parseLocations(r.locations),
    });
  }
  for (const [pmid, docs] of out) {
    out.set(pmid, dedupeDocs(docs).sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editions, and how a document cites a paper
// ---------------------------------------------------------------------------

/** A title less what marks an edition: case-folded, and any trailing year
 *  or "update" phrase dropped ("…: 2025 Update", "… – Update 2019", "…: An
 *  Update", "… 2021" all fold to "…"). */
export function editionTitle(title: string): string {
  let t = title.toLowerCase().replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t
      .replace(/[\s:;,.()[\]–—-]+$/, "")
      .replace(/\b(19|20)\d{2}$/, "")
      .replace(/\b(an? )?((final|evidence|review|partial) )?update[sd]?$/, "");
  }
  return t;
}

/** Authority documents that are editions of one document (same issuing body,
 *  same `editionTitle`) fold into one group, newest first; every other
 *  document is a group of its own. Groups keep first-seen order.
 *  ponytail: grouped at read time from the title alone. An edition retitled
 *  beyond a year or "update" stays separate; a stored edition key in
 *  `etl:policy-citations` is the upgrade. */
export function groupEditions<
  T extends { level: Level; issuingBody: string | null; title: string | null; year: number | null; dedupKey: string },
>(docs: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const d of docs) {
    const key =
      d.level === "authority" && d.title !== null
        ? `${d.issuingBody ?? ""}|${editionTitle(d.title)}`
        : `|${d.level}|${d.dedupKey}`;
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => (b.year ?? 0) - (a.year ?? 0)));
}

/** "2021–2025", "2023", or "" when no edition has a year. */
export function yearRange(lo: number | null, hi: number | null): string {
  return lo === null || hi === null ? "" : lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** The "How it cites this paper" line for one document, from its editions'
 *  locations: "listed as an excluded study in 5 editions, and cited in 2
 *  chapters or sections". null when no edition says where. */
export function howCited(editions: readonly { locations: readonly { label: string }[] }[]): string | null {
  const excluded = editions.filter((e) => isExcludedStudyCitation(e.locations)).length;
  const cited = [
    ...new Set(editions.flatMap((e) => e.locations.map((x) => x.label).filter((label) => !/excluded/i.test(label)))),
  ];
  const parts = [
    excluded === 0
      ? null
      : editions.length === 1
        ? "listed as an excluded study"
        : `listed as an excluded study in ${excluded} ${excluded === 1 ? "edition" : "editions"}`,
    cited.length === 0
      ? null
      : cited.length <= 2
        ? `cited in ${cited.join(" and ")}`
        : `cited in ${cited.length} chapters or sections`,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? `${parts.join(", and ")}.` : null;
}

// ---------------------------------------------------------------------------
// By citing document, and the two summary cards
// ---------------------------------------------------------------------------

/** One citation of a publication in scope by a document at one of
 *  `DOC_LEVELS`. `title` is carried for authority documents only (it is what
 *  groups editions). */
export type DocLink = {
  id: number;
  dedupKey: string;
  level: Level;
  year: number | null;
  issuingBody: string | null;
  title: string | null;
  pmid: string;
};

/** Every such link, ungrouped: the By citing document tab, the chart and the
 *  issuing-body card are all folded from it in Node. Driven from the
 *  documents (`citing_document` is indexed on `level`, the links on
 *  `citing_document_id`), the who clause behind an `EXISTS`: the shape the
 *  guideline chart already had (2.0 s on staging, 2026-11-25, against 14.8 s
 *  starting from the publications).
 *  ponytail: systematic reviews are never read here. They are five links in
 *  six, and this shape took 10 to 56 s over them; listing reviews by citing
 *  document needs a rollup table first. */
export async function loadDocLinks(p: PolicyCitationParams): Promise<DocLink[]> {
  const raw = await db.read.$queryRaw<
    { id: number; dedup_key: string; level: string; year: number | null; issuing_body: string | null; title: string | null; pmid: string }[]
  >`
    SELECT STRAIGHT_JOIN d.id, d.dedup_key, d.level, d.year, d.issuing_body,
           CASE WHEN d.level = 'authority' THEN d.title END AS title, l.pmid
      FROM citing_document d
      JOIN publication_citing_document l ON l.citing_document_id = d.id
      JOIN publication p ON p.pmid = l.pmid
     WHERE d.level IN (${Prisma.join([...DOC_LEVELS])})
       ${docSql(p)}
       ${pubYearSql(p)}
       AND ${hasAuthorSql(p, Prisma.sql`l.pmid`)}`;
  return raw.flatMap((r) => {
    const level = DOC_LEVELS.find((l) => l === r.level);
    return level
      ? [
          {
            id: Number(r.id),
            dedupKey: r.dedup_key,
            level,
            year: r.year === null ? null : Number(r.year),
            issuingBody: r.issuing_body,
            title: r.title,
            pmid: r.pmid,
          },
        ]
      : [];
  });
}

/** One row of the By citing document tab: a document, or the editions of one. */
export type DocGroup = {
  /** The newest edition's `dedupKey`. */
  key: string;
  level: Level;
  body: string | null;
  /** One per edition, newest first. */
  docs: { id: number; year: number | null }[];
  yearMin: number | null;
  yearMax: number | null;
  /** The distinct publications in scope it cites, over every edition. */
  pmids: string[];
};

/** Links to documents (one per `dedupKey`, the lowest id standing for it) to
 *  edition groups. */
export function groupDocLinks(links: readonly DocLink[]): DocGroup[] {
  const docs = new Map<string, Omit<DocLink, "pmid"> & { pmids: Set<string> }>();
  for (const { pmid, ...d } of links) {
    const doc = docs.get(d.dedupKey);
    if (!doc) docs.set(d.dedupKey, { ...d, pmids: new Set([pmid]) });
    else {
      doc.pmids.add(pmid);
      if (d.id < doc.id) doc.id = d.id;
    }
  }
  return groupEditions([...docs.values()]).map((editions) => {
    const years = editions.flatMap((d) => (d.year === null ? [] : [d.year]));
    return {
      key: editions[0].dedupKey,
      level: editions[0].level,
      body: editions[0].issuingBody,
      docs: editions.map((d) => ({ id: d.id, year: d.year })),
      yearMin: years.length > 0 ? Math.min(...years) : null,
      yearMax: years.length > 0 ? Math.max(...years) : null,
      pmids: [...new Set(editions.flatMap((d) => [...d.pmids]))],
    };
  });
}

/** Every sort falls back to newest first, then most papers. */
export function sortDocGroups(groups: readonly DocGroup[], sort: DocSort): DocGroup[] {
  const recent = (a: DocGroup, b: DocGroup) =>
    (b.yearMax ?? 0) - (a.yearMax ?? 0) || b.pmids.length - a.pmids.length || a.key.localeCompare(b.key);
  const lead: Record<DocSort, (a: DocGroup, b: DocGroup) => number> = {
    recent: () => 0,
    papers: (a, b) => b.pmids.length - a.pmids.length,
    // Authority documents by body, A to Z; everything else (no body) after.
    body: (a, b) => (a.body === null ? 1 : 0) - (b.body === null ? 1 : 0) || (a.body ?? "").localeCompare(b.body ?? ""),
  };
  return [...groups].sort((a, b) => lead[sort](a, b) || recent(a, b));
}

export type PolicySummary = {
  /** Authority documents (editions grouped) and the papers they cite, per
   *  issuing body, most documents first. */
  bodies: { body: string; documents: number; papers: number }[];
  /** Citing documents per citing-document year, ascending, per charted
   *  level. Each edition counts in its own year. */
  years: Record<DocLevel, { year: number; count: number }[]>;
};

export function policySummary(groups: readonly DocGroup[]): PolicySummary {
  const bodies = new Map<string, { documents: number; pmids: Set<string> }>();
  const years = new Map<Level, Map<number, number>>(DOC_LEVELS.map((l) => [l, new Map()]));
  for (const g of groups) {
    if (g.level === "authority" && g.body) {
      const b = bodies.get(g.body) ?? { documents: 0, pmids: new Set<string>() };
      bodies.set(g.body, b);
      b.documents += 1;
      for (const pmid of g.pmids) b.pmids.add(pmid);
    }
    const byYear = years.get(g.level);
    for (const d of g.docs) if (byYear && d.year !== null) byYear.set(d.year, (byYear.get(d.year) ?? 0) + 1);
  }
  const series = (l: Level) =>
    [...(years.get(l) ?? [])].map(([year, count]) => ({ year, count })).sort((a, b) => a.year - b.year);
  return {
    bodies: [...bodies]
      .map(([body, b]) => ({ body, documents: b.documents, papers: b.pmids.size }))
      .sort((a, b) => b.documents - a.documents || a.body.localeCompare(b.body)),
    years: { authority: series("authority"), guideline: series("guideline"), consensus: series("consensus") },
  };
}

/** Papers listed under one citing document on the page; the row's count is
 *  the full number. */
export const DOC_PAPERS_SHOWN = 25;

export type DocRow = DocGroup & {
  /** The newest edition's. */
  title: string;
  url: string;
  journal: string | null;
  bookshelf: boolean;
  /** The first `DOC_PAPERS_SHOWN` of `pmids`, newest first. */
  papers: { pmid: string; title: string; journal: string | null; year: number | null }[];
};

async function withDocDetails(p: PolicyCitationParams, groups: DocGroup[]): Promise<DocRow[]> {
  if (groups.length === 0) return [];
  const shown = new Map(groups.map((g) => [g.key, g.pmids.slice(0, DOC_PAPERS_SHOWN)]));
  const [docs, pubs] = await Promise.all([
    // Document metadata only, for ids a scoped listing produced: nothing here
    // depends on who the viewer is.
    db.read.$queryRaw<
      { id: number; title: string; url: string; journal: string | null; journal_abbrev: string | null; source: string }[]
    >`
      SELECT d.id, d.title, d.url, d.journal, d.journal_abbrev, d.source
        FROM citing_document d
       WHERE d.id IN (${Prisma.join(groups.map((g) => g.docs[0].id))})`,
    db.read.$queryRaw<{ pmid: string; title: string; journal: string | null; year: number | null }[]>`
      SELECT p.pmid, p.title, p.journal, p.year
        FROM publication p
       WHERE p.pmid IN (${Prisma.join([...new Set([...shown.values()].flat())])})
         AND ${hasAuthorSql(p, Prisma.sql`p.pmid`)}`,
  ]);
  const doc = new Map(docs.map((d) => [Number(d.id), d]));
  const pub = new Map(pubs.map((r) => [r.pmid, { ...r, year: r.year === null ? null : Number(r.year) }]));
  return groups.map((g) => {
    const d = doc.get(g.docs[0].id);
    return {
      ...g,
      title: d?.title ?? "",
      url: d?.url ?? "",
      journal: d ? (d.journal_abbrev ?? d.journal) : null,
      bookshelf: d?.source === "bookshelf",
      papers: (shown.get(g.key) ?? [])
        .flatMap((pmid) => pub.get(pmid) ?? [])
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.pmid.localeCompare(b.pmid)),
    };
  });
}

export type PolicyDocuments = {
  summary: PolicySummary;
  /** Documents listed (at a ticked level; reviews never). */
  docTotal: number;
  /** One page of them, in the chosen order; empty off the documents tab. */
  docs: DocRow[];
};

/** Page only: the By citing document tab and the summary cards, from one
 *  pass over the links. The cards cover every charted level whatever `level`
 *  lists, like the tiles. */
export async function loadPolicyDocuments(p: PolicyCitationParams): Promise<PolicyDocuments> {
  const groups = groupDocLinks(await loadDocLinks(p));
  const want = p.levels.length > 0 ? p.levels : LEVELS;
  const listed = sortDocGroups(groups.filter((g) => want.includes(g.level)), p.docSort);
  const offset = (p.page - 1) * POLICY_PAGE_SIZE;
  return {
    summary: policySummary(groups),
    docTotal: listed.length,
    docs: p.view === "documents" ? await withDocDetails(p, listed.slice(offset, offset + POLICY_PAGE_SIZE)) : [],
  };
}

// ---------------------------------------------------------------------------
// The download's Citations sheet
// ---------------------------------------------------------------------------

/** The Citations sheet carries at most this many rows; systematic reviews
 *  are the first to go. The Criteria sheet says so when it cuts. */
export const POLICY_CITATIONS_CAP = 20_000;

export type CitationPair = {
  pmid: string;
  pubTitle: string;
  level: Level;
  body: string | null;
  title: string;
  year: number | null;
  /** Bookshelf: the chapters and sections citing the paper, "; "-joined. */
  where: string;
  url: string;
};

/** One row per publication and counted citing document, at the listed
 *  levels, for the publications on the Publications sheet (so the same scope
 *  and filters, tested again in `scopedPubsSql`), in that sheet's order. */
export async function loadCitationPairs(
  p: PolicyCitationParams,
  pubs: readonly Pick<PubRow, "pmid" | "title">[],
  cap: number = POLICY_CITATIONS_CAP,
): Promise<{ rows: CitationPair[]; more: boolean }> {
  if (pubs.length === 0) return { rows: [], more: false };
  const levels = p.levels.length > 0 ? p.levels : LEVELS;
  const raw = await db.read.$queryRaw<
    { pmid: string; dedup_key: string; level: string; issuing_body: string | null; title: string; year: number | null; url: string; locations: unknown }[]
  >`
    SELECT ok.pmid, d.dedup_key, d.level, d.issuing_body, d.title, d.year, d.url, l.locations
      FROM ${scopedPubsSql(p, pubs.map((r) => r.pmid))}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE d.level IN (${Prisma.join([...levels])})
       ${docSql(p)}
     ORDER BY FIELD(d.level, 'authority', 'guideline', 'consensus', 'review'), ok.pmid, d.year DESC, d.id
     LIMIT ${cap + 1}`;
  const order = new Map(pubs.map((r, i) => [r.pmid, i]));
  const title = new Map(pubs.map((r) => [r.pmid, r.title]));
  const seen = new Set<string>();
  const rows = raw.slice(0, cap).flatMap((r): CitationPair[] => {
    const level = LEVELS.find((l) => l === r.level);
    const key = `${r.pmid}|${r.dedup_key}`;
    if (!level || seen.has(key)) return [];
    seen.add(key);
    return [
      {
        pmid: r.pmid,
        pubTitle: title.get(r.pmid) ?? "",
        level,
        body: r.issuing_body,
        title: r.title,
        year: r.year === null ? null : Number(r.year),
        where: parseLocations(r.locations).map((x) => x.label).join("; "),
        url: r.url,
      },
    ];
  });
  // Stable: within a publication the SQL order (level, then newest) holds.
  rows.sort((a, b) => (order.get(a.pmid) ?? 0) - (order.get(b.pmid) ?? 0));
  return { rows, more: raw.length > cap };
}

// ---------------------------------------------------------------------------
// The one loader the page and the download share
// ---------------------------------------------------------------------------

/** The download's Publications sheet carries at most this many rows (the
 *  first ones in the chosen order); the Criteria sheet says so when it cuts. */
export const POLICY_LIST_CAP = 5000;

export type PolicyCitationData = {
  /** Cited publications in scope, at any level. */
  cited: number;
  /** Over every cited publication in scope, whatever `level` lists. */
  tiles: LevelCounts;
  /** Publications listed (a counted document at a ticked level). */
  pubTotal: number;
  /** Those the search keeps (`pubTotal` without one): what the pages run over. */
  pubMatched: number;
  /** `limit` of them from `offset`, in the chosen order. */
  pubs: PubRow[];
  /** Every listed person, ranked (the `person` filter and the search applied). */
  people: PersonRow[];
  /** The Person facet: everyone in scope ignoring the `person` filter, by
   *  authority-cited papers. */
  facetPeople: PersonRow[];
};

/** `q` searches the tab it was typed on: publications by title, PMID or
 *  author; people by name or CWID. */
export async function loadPolicyCitations(
  p: PolicyCitationParams,
  limit: number,
  offset = 0,
): Promise<PolicyCitationData> {
  const [counts, everyone, hits] = await Promise.all([
    loadPublicationCounts(p),
    loadPersonCounts(p),
    p.q && p.view === "publications" ? searchPublications(p, p.q) : null,
  ]);
  const listed = sortPublications(listedAt(counts, p.levels), p.sort);
  const matched = hits ? listed.filter((r) => hits.has(r.pmid)) : listed;
  const picked = p.people.length > 0 ? everyone.filter((r) => p.people.includes(r.cwid)) : everyone;
  const needle = p.view === "people" ? p.q.toLowerCase() : "";
  return {
    cited: counts.length,
    tiles: policyTiles(counts),
    pubTotal: listed.length,
    pubMatched: matched.length,
    pubs: await withDetails(p, matched.slice(offset, offset + limit)),
    people: listedAt(picked, p.levels).filter(
      (r) => !needle || r.name.toLowerCase().includes(needle) || r.cwid.toLowerCase() === needle,
    ),
    facetPeople: everyone,
  };
}

// ---------------------------------------------------------------------------
// Chips, criteria, workbook
// ---------------------------------------------------------------------------

/** "2001 to 2026", "2001 or later", "2026 or earlier", or null when open. */
export function yearSpan(lo: number | null, hi: number | null, label: (y: number) => string = String): string | null {
  if (lo !== null && hi !== null) return lo === hi ? label(lo) : `${label(lo)} to ${label(hi)}`;
  if (lo !== null) return `${label(lo)} or later`;
  return hi !== null ? `${label(hi)} or earlier` : null;
}

export const fiscalLabel = (p: Pick<PolicyCitationParams, "basis">) => (y: number) =>
  p.basis === "fy" ? `FY${y}` : String(y);

export type PolicyChip = { group: string; value: string; removeQuery: string | null };

/** The active filters as chips: one per value up to three, else one
 *  "N selected" chip that clears the facet. The viewer's scope shows first
 *  and cannot be removed. */
export function policyCitationChips(
  p: PolicyCitationParams,
  unitLabel: ReadonlyMap<string, string> = new Map(),
  personName: ReadonlyMap<string, string> = new Map(),
): PolicyChip[] {
  const qs = (next: Partial<PolicyCitationParams>) => policyCitationQueryString(p, next);
  const chips: PolicyChip[] = [];
  if (p.scope !== null) {
    chips.push({ group: "Unit", value: p.scope.map((u) => unitLabel.get(u) ?? u).join("; "), removeQuery: null });
  }
  const facet = <V extends string>(
    group: string,
    values: readonly V[],
    label: (v: V) => string,
    without: (keep: (v: V) => boolean) => Partial<PolicyCitationParams>,
  ) => {
    if (values.length > 3) {
      chips.push({ group, value: `${values.length} selected`, removeQuery: qs(without(() => false)) });
      return;
    }
    for (const v of values) chips.push({ group, value: label(v), removeQuery: qs(without((x) => x !== v)) });
  };
  facet("Person type", p.types, (t) => formatRoleCategory(t) ?? t, (keep) => ({ types: p.types.filter(keep) }));
  const unitGroups: [string, (u: string) => boolean][] = [
    ["Org unit", (u) => u.startsWith("dept:") || u.startsWith("div:")],
    ["Centers", (u) => u.startsWith("center:")],
    ["Primary institution", (u) => u.startsWith("inst:")],
  ];
  for (const [group, inGroup] of unitGroups) {
    facet(
      group,
      p.units.filter(inGroup),
      (u) => unitLabel.get(u) ?? u,
      (keep) => ({ units: p.units.filter((u) => !inGroup(u) || keep(u)) }),
    );
  }
  facet("Person", p.people, (c) => personName.get(c) ?? c, (keep) => ({ people: p.people.filter(keep) }));
  facet("Author", p.positions, (k) => POSITION_LABEL[k], (keep) => ({ positions: p.positions.filter(keep) }));
  facet("Level", p.levels, (l) => LEVEL_LABEL[l], (keep) => ({ levels: p.levels.filter(keep) }));
  facet("Issuing body", p.bodies, bodyLabel, (keep) => ({ bodies: p.bodies.filter(keep) }));
  if (p.hideExcluded) {
    chips.push({ group: "Excluded-study citations", value: "Hidden", removeQuery: qs({ hideExcluded: false }) });
  }
  const published = yearSpan(p.from, p.to, fiscalLabel(p));
  if (published) chips.push({ group: "Published", value: published, removeQuery: qs({ from: null, to: null }) });
  const citing = yearSpan(p.cfrom, p.cto);
  if (citing) {
    chips.push({ group: "Citing document year", value: citing, removeQuery: qs({ cfrom: null, cto: null }) });
  }
  return chips;
}

const roleLabel = (r: string) => formatRoleCategory(r) ?? r;

/** The Criteria sheet, verbatim: every filter, "All" when unset. */
export function describePolicyCitationCriteria(
  p: PolicyCitationParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
): [string, string][] {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");
  return [
    ["Report", "24. Guideline and policy citations"],
    ["Generated", generatedAt.toISOString()],
    [
      "Access",
      p.scope === null
        ? "All units"
        : `Limited to the units you administer: ${list(p.scope.map((u) => labels.get(u) ?? u))}`,
    ],
    ...personFilterCriteria({ types: p.types, unitValues: p.units }, labels, roleLabel),
    ["Person (CWID)", list(p.people)],
    ["Author position", list(p.positions.map((k) => POSITION_LABEL[k]))],
    [
      "Level",
      p.levels.length > 0
        ? `${list(p.levels.map((l) => LEVEL_LABEL[l]))} (lists the publications and people cited at these levels; the counts cover every level)`
        : "All",
    ],
    ["Issuing body", list(p.bodies.map(bodyLabel))],
    [
      "Excluded-study citations",
      p.hideExcluded
        ? "Hidden: a citation does not count when the document only lists the paper among its excluded studies"
        : "Counted",
    ],
    [
      "Publication year basis",
      p.basis === "fy"
        ? "Fiscal year, July 1 – June 30, named by the ending calendar year, by the date the article was added to PubMed"
        : "Calendar year of publication",
    ],
    ["Publication years", yearSpan(p.from, p.to) ?? "All"],
    ["Citing document year", yearSpan(p.cfrom, p.cto) ?? "All"],
    ["Order", SORT_LABEL[p.sort]],
    ...(p.q ? ([[p.view === "people" ? "Search (people)" : "Search (publications)", p.q]] as [string, string][]) : []),
    [
      "Counting rule",
      "A citing document counts once per publication, however many journals printed it. Only ReCiter-confirmed authorships of active scholars count; person type, department, division, institution and center membership are the scholar's current values.",
    ],
  ];
}

/**
 * The workbook: Publications, People, Citations, Criteria.
 *
 * The People sheet lists EVERY matching person. This report is a decided,
 * named exception to the 50-scholar export cap (`SCHOLAR_EXPORT_CAP`,
 * `lib/api/export-scholars.ts`), which is left as it is. The report owner,
 * 2026-11-24: "I'm fine with breaking our per person rule. The report is kind
 * of pointless otherwise." The sheet carries name, CWID, org unit, person
 * type, primary institution and the counts, and no contact details.
 */
export async function buildPolicyCitationWorkbook(
  p: PolicyCitationParams,
  data: PolicyCitationData,
  generatedAt: Date,
  labels?: ReadonlyMap<string, string>,
  citations: { rows: CitationPair[]; more: boolean } = { rows: [], more: false },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const levelHeaders = ["Health authority documents", "Clinical guidelines", "Consensus statements", "Systematic reviews"];

  const pubs = wb.addWorksheet("Publications");
  pubs.addRow(["PMID", "Title", "Journal", "Year", "WCM authors", "Health authorities", ...levelHeaders, "DOI"]);
  boldRow(pubs, 1);
  pubs.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of data.pubs) {
    pubs.addRow([
      r.pmid,
      htmlToPlainText(r.title, Number.POSITIVE_INFINITY),
      r.journal ? htmlToPlainText(r.journal, Number.POSITIVE_INFINITY) : r.journal,
      r.year,
      r.authors.map((a) => `${a.name} (${a.position} author)`).join("; "),
      r.bodies.map((b) => `${b.body} (${b.count})`).join("; "),
      ...LEVELS.map((l) => r[l]),
      r.doi,
    ]);
  }
  for (const [i, w] of [12, 70, 30, 8, 40, 30, 14, 12, 12, 12, 28].entries()) pubs.getColumn(i + 1).width = w;
  pubs.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  pubs.getColumn(5).alignment = { wrapText: true, vertical: "top" };

  const people = wb.addWorksheet("People");
  people.addRow([
    "Name",
    "CWID",
    "Org unit",
    "Person type",
    "Primary institution",
    "Papers cited by health authorities",
    "Papers cited in guidelines",
    "Papers cited in consensus statements",
    "Papers cited in reviews",
  ]);
  boldRow(people, 1);
  people.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of data.people) {
    people.addRow([r.name, r.cwid, r.orgUnit, r.personType, r.institution, ...LEVELS.map((l) => r[l])]);
  }
  for (const [i, w] of [28, 10, 30, 22, 28, 16, 14, 16, 14].entries()) people.getColumn(i + 1).width = w;

  const pairs = wb.addWorksheet("Citations");
  pairs.addRow(["PMID", "Paper title", "Level", "Issuing body", "Citing document", "Year", "Where cited", "Link"]);
  boldRow(pairs, 1);
  pairs.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of citations.rows) {
    pairs.addRow([
      r.pmid,
      htmlToPlainText(r.pubTitle, Number.POSITIVE_INFINITY),
      LEVEL_ONE[r.level],
      r.body,
      htmlToPlainText(r.title, Number.POSITIVE_INFINITY),
      r.year,
      r.where,
      r.url,
    ]);
  }
  for (const [i, w] of [12, 60, 20, 18, 70, 8, 40, 46].entries()) pairs.getColumn(i + 1).width = w;

  addCriteriaSheet(wb, [
    ...describePolicyCitationCriteria(p, generatedAt, labels),
    [
      "Publications sheet",
      data.pubTotal > data.pubs.length
        ? `Lists the first ${data.pubs.length.toLocaleString()} of ${data.pubTotal.toLocaleString()} publications in the order above. Narrow the filters to list the rest.`
        : `Lists all ${data.pubTotal.toLocaleString()} publications.`,
    ],
    [
      "Citations sheet",
      `One row per publication on the Publications sheet and citing document, at the levels above. ${
        citations.more
          ? `Lists the first ${POLICY_CITATIONS_CAP.toLocaleString()} rows, health authorities first and systematic reviews last. Narrow the filters to list the rest.`
          : `Lists all ${citations.rows.length.toLocaleString()} rows (the limit is ${POLICY_CITATIONS_CAP.toLocaleString()}).`
      }`,
    ],
    [
      "People sheet",
      `Lists all ${data.people.length.toLocaleString()} people, with no contact details. This report is exempt from the 50-person limit on scholar exports (decided 2026-11-24).`,
    ],
  ]);

  return workbookBuffer(wb);
}
