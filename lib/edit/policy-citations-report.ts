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
 *     authorships, and so the publications.
 *   - `body`, `cfrom` / `cto` pick which citing documents are counted, in
 *     every number on the page.
 *   - `level` picks which publications and people are LISTED (one with a
 *     counted document at a ticked level); the counts and the tiles still
 *     cover all four levels. A bare URL lists the three above reviews.
 *   - `view`, `sort`, `pub` (the expanded row) are view state, not filters.
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

/** What a bare URL lists: everything above systematic reviews. */
const DEFAULT_LEVELS: readonly Level[] = ["authority", "guideline", "consensus"];

export const BODIES: readonly string[] = [...new Set(ISSUING_BODIES.map(([, body]) => body))];
/** WHO's documents include IARC's (`ISSUING_BODIES`). */
export const bodyLabel = (body: string) => (body === "WHO" ? "WHO (including IARC)" : body);

export const POSITION_LABEL = {
  first: "First author",
  last: "Last author",
  middle: "Middle author",
} as const;
export type Position = keyof typeof POSITION_LABEL;

export const SORT_LABEL = {
  ranked: "Highest-level citations first",
  guidelines: "Most clinical guidelines",
  reviews: "Most systematic reviews",
  recent: "Most recently cited",
  year: "Publication year",
} as const;
export type PolicySort = keyof typeof SORT_LABEL;

export type PolicyView = "publications" | "people";

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
  basis: YearBasis;
  /** Publication years (`from` / `to`); null = open. */
  from: number | null;
  to: number | null;
  /** Citing-document years (`cfrom` / `cto`), calendar; null = open. */
  cfrom: number | null;
  cto: number | null;
  view: PolicyView;
  sort: PolicySort;
  /** The expanded publication's PMID (`pub`). */
  pub: string | null;
  /** The viewer's units (`resolvePolicyCitationParams`): null = everything,
   *  [] = nothing. Never from the URL. */
  scope: string[] | null;
};

const VIEW_KEYS = new Set(["view", "sort", "pub"]);

/** Every param is optional; a stray value is dropped. A bare URL (nothing but
 *  view state) gets `DEFAULT_LEVELS`; any filter in the URL means the form
 *  was submitted and the URL is taken as-is (no level ticked = every level).
 *  The rail always submits `basis`, so unticking everything never brings the
 *  default back. */
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
  const pub = sp.get("pub")?.trim() ?? "";
  return {
    types: person.types,
    units: person.unitValues,
    people: [...new Set(sp.getAll("person").map((v) => v.trim()))].filter((v) => /^[A-Za-z0-9]{2,16}$/.test(v)),
    positions: among("pos", Object.keys(POSITION_LABEL) as Position[]),
    levels: bare ? [...DEFAULT_LEVELS] : among("level", LEVELS),
    bodies: among("body", BODIES),
    basis: one("basis", Object.keys(BASIS_LABEL) as YearBasis[], "cy"),
    from,
    to,
    cfrom,
    cto,
    view: one("view", ["publications", "people"] as const, "publications"),
    sort: one("sort", Object.keys(SORT_LABEL) as PolicySort[], "ranked"),
    pub: /^[\w.:-]{1,32}$/.test(pub) ? pub : null,
    scope: [],
  };
}

/** The canonical query string: the download link, the chips, the tabs and
 *  the row links build on it. Always carries `basis`, so it is never bare.
 *  `pub` rides only when asked for. */
export function policyCitationQueryString(p: PolicyCitationParams, over: Partial<PolicyCitationParams> = {}): string {
  const x = { ...p, pub: null, ...over };
  const q = new URLSearchParams();
  for (const t of x.types) q.append("type", t);
  for (const u of x.units) q.append("unit", u);
  for (const c of x.people) q.append("person", c);
  for (const v of x.positions) q.append("pos", v);
  for (const l of x.levels) q.append("level", l);
  for (const b of x.bodies) q.append("body", b);
  q.set("basis", x.basis);
  for (const k of ["from", "to", "cfrom", "cto"] as const) if (x[k] !== null) q.set(k, String(x[k]));
  if (x.view !== "publications") q.set("view", x.view);
  if (x.sort !== "ranked") q.set("sort", x.sort);
  if (x.pub) q.set("pub", x.pub);
  return q.toString();
}

/** Nothing set beyond what a bare URL gets (the "Reset to defaults" test). */
export function isPolicyCitationDefault(p: PolicyCitationParams): boolean {
  const d = parsePolicyCitationParams(new URLSearchParams());
  const filters = (x: PolicyCitationParams) => policyCitationQueryString(x, { view: "publications", sort: "ranked" });
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

/** Which citing documents are counted (`d` = `citing_document`). */
function docSql(p: PolicyCitationParams): Prisma.Sql {
  return Prisma.sql`${p.bodies.length > 0 ? Prisma.sql`AND d.issuing_body IN (${Prisma.join(p.bodies)})` : Prisma.empty}
       ${yearWindow(Prisma.sql`d.year`, p.cfrom, p.cto)}`;
}

const POSITION_SQL: Record<Position, Prisma.Sql> = {
  first: Prisma.sql`pa.is_first = 1`,
  last: Prisma.sql`pa.is_last = 1`,
  middle: Prisma.sql`(pa.is_first = 0 AND pa.is_last = 0)`,
};

/** Which authorships count, as conditions on `pa` (`publication_author`) and
 *  `s` (`scholar`). The viewer's scope is its own `personFilterSql` clause,
 *  AND-ed with the URL's selection: a `unit` outside the scope matches nobody.
 *  `people: false` leaves the `person` filter out (the Person facet's own
 *  counts, which must not collapse to the people already ticked). */
export function policyScopeSql(p: PolicyCitationParams, opts: { people?: boolean } = {}): Prisma.Sql {
  const scope =
    p.scope === null
      ? Prisma.empty
      : p.scope.length === 0
        ? Prisma.sql`AND 1 = 0`
        : personFilterSql({ types: [], unitValues: p.scope }, { scholar: "s", centerMembership: "scm" });
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

/** A filter on the citing documents themselves (issuing body, citing year). */
const hasDocFilter = (p: PolicyCitationParams): boolean => p.bodies.length > 0 || p.cfrom !== null || p.cto !== null;

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

/** `ok`: the publications in scope that the rollups say an authority cites,
 *  so the who clause is tested once per publication and never per link. The
 *  rollup is unfiltered, so it can only over-include; the caller's own
 *  document filters do the rest. */
const authorityPubsSql = (p: PolicyCitationParams): Prisma.Sql => Prisma.sql`(SELECT p.pmid
          FROM publication p
         WHERE p.authority_count > 0
           AND ${hasAuthorSql(p, Prisma.sql`p.pmid`)}
           ${pubYearSql(p)}) ok`;

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
 *  as a number. */
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
    reviews: (a, b) => b.review - a.review,
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

export type PolicyTiles = { authority: number; guideline: number; either: number; review: number };

export function policyTiles(rows: readonly LevelCounts[]): PolicyTiles {
  const n = (test: (r: LevelCounts) => boolean) => rows.filter(test).length;
  return {
    authority: n((r) => r.authority > 0),
    guideline: n((r) => r.guideline > 0),
    either: n((r) => r.authority > 0 || r.guideline > 0),
    review: n((r) => r.review > 0),
  };
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
  /** Every confirmed, active WCM author, in byline order. */
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

/** The counted citing documents of one publication, highest level first,
 *  newest first within a level. The caller checks the PMID is one the viewer
 *  may see (it is only called for a listed row). */
export async function loadCitingDocuments(p: PolicyCitationParams, pmid: string): Promise<CitingDoc[]> {
  const raw = await db.read.$queryRaw<
    {
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
    SELECT d.id, d.dedup_key, d.level, d.title, d.year, d.url, d.issuing_body, d.authors, d.journal,
           d.journal_abbrev, d.volume, d.issue, d.pages, d.doi, d.publisher, d.source, d.external_id,
           l.locations
      FROM publication_citing_document l
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE l.pmid = ${pmid}
       ${docSql(p)}
     ORDER BY d.year DESC, d.id`;
  const docs = raw.flatMap((r): CitingDoc[] => {
    const level = LEVELS.find((l) => l === r.level);
    if (!level) return [];
    // MariaDB hands a JSON column back as text through a raw query.
    let locations: unknown = r.locations;
    if (typeof locations === "string") {
      try {
        locations = JSON.parse(locations);
      } catch {
        locations = null;
      }
    }
    const vip = formatVolIssuePages(r.volume, r.issue, r.pages);
    return [
      {
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
        locations: Array.isArray(locations)
          ? (locations as { url?: unknown; label?: unknown }[]).flatMap((x) =>
              typeof x?.url === "string" && x.url.startsWith(NCBI) && typeof x.label === "string"
                ? [{ url: x.url, label: x.label }]
                : [],
            )
          : [],
      },
    ];
  });
  return dedupeDocs(docs).sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
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
  tiles: PolicyTiles;
  /** Publications listed (a counted document at a ticked level). */
  pubTotal: number;
  /** The first `limit` of them, in the chosen order. */
  pubs: PubRow[];
  /** Every listed person, ranked (the `person` filter applied). */
  people: PersonRow[];
  /** The Person facet: everyone in scope ignoring the `person` filter, by
   *  authority-cited papers. */
  facetPeople: PersonRow[];
};

export async function loadPolicyCitations(p: PolicyCitationParams, limit: number): Promise<PolicyCitationData> {
  const [counts, everyone] = await Promise.all([loadPublicationCounts(p), loadPersonCounts(p)]);
  const listed = sortPublications(listedAt(counts, p.levels), p.sort);
  const picked = p.people.length > 0 ? everyone.filter((r) => p.people.includes(r.cwid)) : everyone;
  return {
    cited: counts.length,
    tiles: policyTiles(counts),
    pubTotal: listed.length,
    pubs: await withDetails(p, listed.slice(0, limit)),
    people: listedAt(picked, p.levels),
    facetPeople: everyone,
  };
}

// ---------------------------------------------------------------------------
// Summary cards (page only)
// ---------------------------------------------------------------------------

export type PolicySummary = {
  /** Authority documents and the papers they cite, per issuing body. */
  bodies: { body: string; documents: number; papers: number }[];
  /** Citing guidelines per citing-document year, ascending. */
  guidelineYears: { year: number; count: number }[];
  newly: {
    /** When citations were first recorded; null = nothing recorded yet. */
    firstImport: Date | null;
    /** The window's start: 30 days back, or the day after the first import
     *  if that is later, so the first import's backfill never counts as new. */
    since: Date;
    /** True while the first import, not the 30 days, bounds the window. */
    sinceFirstImport: boolean;
    documents: number;
    items: { title: string; url: string; year: number | null; journal: string | null; pmid: string; pubTitle: string }[];
  };
};

export const NEWLY_CITED_DAYS = 30;
const DAY_MS = 86_400_000;

export async function loadPolicySummary(p: PolicyCitationParams, now: Date = new Date()): Promise<PolicySummary> {
  const levels = p.levels.length > 0 ? p.levels : LEVELS;
  const [first] = await db.read.$queryRaw<{ first: Date | null }[]>`
    SELECT MIN(first_seen_at) AS first FROM publication_citing_document`;
  const firstImport = first?.first ?? null;
  const windowStart = new Date(now.getTime() - NEWLY_CITED_DAYS * DAY_MS);
  const afterImport = firstImport === null ? windowStart : new Date(firstImport.getTime() + DAY_MS);
  const sinceFirstImport = afterImport > windowStart;
  const since = sinceFirstImport ? afterImport : windowStart;
  // The recent links are picked first, by date alone; everything else is
  // tested only on those.
  const recent = Prisma.sql`
          FROM (SELECT pmid, citing_document_id, first_seen_at
                  FROM publication_citing_document
                 WHERE first_seen_at >= ${since}) l
          JOIN citing_document d ON d.id = l.citing_document_id
          JOIN publication p ON p.pmid = l.pmid
         WHERE d.level IN (${Prisma.join([...levels])})
           ${docSql(p)}
           ${pubYearSql(p)}
           AND ${hasAuthorSql(p, Prisma.sql`l.pmid`)}`;
  type NewRow = {
    dedup_key: string;
    title: string;
    url: string;
    year: number | null;
    journal_abbrev: string | null;
    journal: string | null;
    pmid: string;
    pub_title: string;
  };
  const [bodies, years, count, items] = await Promise.all([
    db.read.$queryRaw<{ body: string | null; documents: Num; papers: Num }[]>`
      SELECT d.issuing_body AS body, COUNT(DISTINCT d.dedup_key) AS documents, COUNT(DISTINCT l.pmid) AS papers
        FROM ${authorityPubsSql(p)}
        JOIN publication_citing_document l ON l.pmid = ok.pmid
        JOIN citing_document d ON d.id = l.citing_document_id
       WHERE d.level = 'authority'
         ${docSql(p)}
       GROUP BY d.issuing_body
       ORDER BY documents DESC, body`,
    // Driven from the documents: `citing_document` is indexed on `level`
    // and the links on `citing_document_id`, and there are only about 55,000
    // guideline links. Staging, 2026-11-25: 2.0 s this way, 14.8 s starting
    // from the publications the rollup says a guideline cites.
    db.read.$queryRaw<{ y: number; n: Num }[]>`
      SELECT STRAIGHT_JOIN d.year AS y, COUNT(DISTINCT d.dedup_key) AS n
        FROM citing_document d
        JOIN publication_citing_document l ON l.citing_document_id = d.id
        JOIN publication p ON p.pmid = l.pmid
       WHERE d.level = 'guideline' AND d.year IS NOT NULL
         ${docSql(p)}
         ${pubYearSql(p)}
         AND ${hasAuthorSql(p, Prisma.sql`l.pmid`)}
       GROUP BY d.year
       ORDER BY d.year`,
    db.read.$queryRaw<{ n: Num }[]>`SELECT COUNT(DISTINCT d.dedup_key) AS n ${recent}`,
    // ponytail: over-fetches 40 rows so five distinct documents survive a
    // document that cites several papers or was printed in several journals;
    // one with more than 40 such rows would show fewer than five.
    db.read.$queryRaw<NewRow[]>`
      SELECT d.dedup_key, d.title, d.url, d.year, d.journal_abbrev, d.journal, p.pmid, p.title AS pub_title
      ${recent}
       ORDER BY l.first_seen_at DESC, d.year DESC, d.id
       LIMIT 40`,
  ]);
  return {
    bodies: bodies.flatMap((r) =>
      r.body ? [{ body: r.body, documents: Number(r.documents), papers: Number(r.papers) }] : [],
    ),
    guidelineYears: years.map((r) => ({ year: Number(r.y), count: Number(r.n) })),
    newly: {
      firstImport,
      since,
      sinceFirstImport,
      documents: Number(count[0]?.n ?? 0),
      items: dedupeDocs(items.map((r) => ({ ...r, dedupKey: r.dedup_key })))
        .slice(0, 5)
        .map((r) => ({
          title: r.title,
          url: r.url,
          year: r.year === null ? null : Number(r.year),
          journal: r.journal_abbrev ?? r.journal,
          pmid: r.pmid,
          pubTitle: r.pub_title,
        })),
    },
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
      "Publication year basis",
      p.basis === "fy"
        ? "Fiscal year, July 1 – June 30, named by the ending calendar year, by the date the article was added to PubMed"
        : "Calendar year of publication",
    ],
    ["Publication years", yearSpan(p.from, p.to) ?? "All"],
    ["Citing document year", yearSpan(p.cfrom, p.cto) ?? "All"],
    ["Order", SORT_LABEL[p.sort]],
    [
      "Counting rule",
      "A citing document counts once per publication, however many journals printed it. Only ReCiter-confirmed authorships of active scholars count; person type, department, division, institution and center membership are the scholar's current values.",
    ],
  ];
}

/**
 * The workbook: Publications, People, Criteria.
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

  addCriteriaSheet(wb, [
    ...describePolicyCitationCriteria(p, generatedAt, labels),
    [
      "Publications sheet",
      data.pubTotal > data.pubs.length
        ? `Lists the first ${data.pubs.length.toLocaleString()} of ${data.pubTotal.toLocaleString()} publications in the order above. Narrow the filters to list the rest.`
        : `Lists all ${data.pubTotal.toLocaleString()} publications.`,
    ],
    [
      "People sheet",
      `Lists all ${data.people.length.toLocaleString()} people, with no contact details. This report is exempt from the 50-person limit on scholar exports (decided 2026-11-24).`,
    ],
  ]);

  return workbookBuffer(wb);
}
