/**
 * Report 25 — "Patent citations": WCM publications cited in a US patent, by
 * publication, by invention or by person. Reads what the patent-citations
 * import (`etl/patent-citations`) loads: `citing_document` rows at level
 * 'patent', their links, and the rollup `publication.patent_family_count`.
 * Writes nothing. Behind `PATENT_CITATIONS_REPORT`.
 *
 * Built on report 24 (`policy-citations-report.ts`): the same who-filter, the
 * same access rule and the same scope handling. `scope` is never read from the
 * URL: the parser leaves it `[]` (match nothing) and
 * `resolvePatentCitationParams` sets it from the session, on the page and in
 * the download route alike. Every query that reads a person or a publication
 * carries it; the two that do not (`loadPatentDocs`, `searchInventions`) read
 * public patent facts only, for keys a scoped listing produced.
 *
 * Counts are inventions: the documents of one patent family share a
 * `dedup_key` and count once. An invention is shown by its earliest granted
 * patent, or by its earliest published application when none was granted.
 *
 * What the filters do:
 *   - `type`, `unit`, `person`, `pos`, `basis` + `from` / `to` pick the
 *     authorships, and so the papers. No default year: patents cite late.
 *   - `cfrom` / `cto` (year granted or published), `assignee` and `where`
 *     pick which patent documents are counted, in every number on the page.
 *   - `view`, `sort`, `isort`, `q` and `page` are view state.
 *
 * Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { parsePatentId, type PatentDetails } from "@/etl/patent-citations/shape";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  citationParamReader,
  facetChips,
  fiscalLabel,
  likeArg,
  loadPolicyCitationScope,
  loadPublicationDetails,
  policyScopeSql,
  pubYearCriteria,
  pubYearSql,
  scopedPubsSql,
  searchPublications,
  whoChips,
  whoCriteria,
  yearSpan,
  yearWindow,
  type PolicyChip,
  type PubDetails,
  type WhoParams,
} from "@/lib/edit/policy-citations-report";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import { Prisma } from "@/lib/generated/prisma/client";
import { institutionDisplayName } from "@/lib/institutions";
import { formatRoleCategory } from "@/lib/role-display";
import { htmlToPlainText } from "@/lib/utils";

/** PATENT_CITATIONS_REPORT — off: the report is absent from the index, and
 *  its page and download route 404. */
export function isPatentCitationsReportEnabled(): boolean {
  return process.env.PATENT_CITATIONS_REPORT === "on";
}

/** Rows per page, on every tab. */
export const PATENT_PAGE_SIZE = 50;
/** Citing inventions listed under one publication on the page, newest first. */
export const INVENTIONS_SHOWN = 20;
/** Papers listed under one invention on the page, newest first. */
export const INVENTION_PAPERS_SHOWN = 25;
/** The download's Publications and Inventions sheets carry at most this many
 *  rows (the first ones in the chosen order); the Criteria sheet says so. */
export const PATENT_LIST_CAP = 5000;
export const PATENT_INVENTIONS_CAP = 20_000;
/** Assignees offered in the rail, and the first of them shown in the card. */
const ASSIGNEE_OPTIONS = 50;
const ASSIGNEES_SHOWN = 10;
/** Where the patent tables end.
 *  ponytail: a constant, true of the one release loaded so far (PatentsView,
 *  grants through 2025). The import storing its coverage end is the upgrade. */
export const PATENT_DATA_END = { year: 2025, label: "31 December 2025" } as const;

export const WHERE_LABEL = {
  any: "Front page or text",
  front: "Front page",
  body: "Patent text",
} as const;
export type WhereCited = keyof typeof WHERE_LABEL;

export const PATENT_SORT_LABEL = {
  inventions: "Most citing inventions",
  recent: "Most recently cited",
  year: "Publication year",
} as const;
export type PatentSort = keyof typeof PATENT_SORT_LABEL;

export const INVENTION_SORT_LABEL = {
  papers: "Most papers cited",
  recent: "Most recent first",
} as const;
export type InventionSort = keyof typeof INVENTION_SORT_LABEL;

export type PatentView = "publications" | "inventions" | "people";

export type PatentCitationParams = WhoParams & {
  /** Year granted or published (`cfrom` / `cto`); null = open. */
  cfrom: number | null;
  cto: number | null;
  /** Assignee names exactly as stored (`assignee`); empty = any. */
  assignees: string[];
  where: WhereCited;
  view: PatentView;
  sort: PatentSort;
  /** The By invention tab's order (`isort`). */
  inventionSort: InventionSort;
  /** The current tab's search (`q`); "" = none. */
  q: string;
  /** 1-based (`page`). */
  page: number;
};

/** Every param is optional; a stray value is dropped. A bare URL is every
 *  paper in the viewer's scope, any year. */
export function parsePatentCitationParams(sp: URLSearchParams): PatentCitationParams {
  const { one, range, types, units, people, positions, basis, q, page } = citationParamReader(sp);
  const [from, to] = range("from", "to");
  const [cfrom, cto] = range("cfrom", "cto");
  return {
    types,
    units,
    people,
    positions,
    basis,
    from,
    to,
    cfrom,
    cto,
    assignees: [...new Set(sp.getAll("assignee").map((v) => v.trim()))].filter((v) => v && v.length <= 255).slice(0, 20),
    where: one("where", Object.keys(WHERE_LABEL) as WhereCited[], "any"),
    view: one("view", ["publications", "inventions", "people"] as const, "publications"),
    sort: one("sort", Object.keys(PATENT_SORT_LABEL) as PatentSort[], "inventions"),
    inventionSort: one("isort", Object.keys(INVENTION_SORT_LABEL) as InventionSort[], "papers"),
    q,
    page,
    scope: [],
  };
}

/** The canonical query string. `page` rides only when asked for: any other
 *  change starts at page 1. */
export function patentCitationQueryString(p: PatentCitationParams, over: Partial<PatentCitationParams> = {}): string {
  const x = { ...p, page: 1, ...over };
  const q = new URLSearchParams();
  for (const t of x.types) q.append("type", t);
  for (const u of x.units) q.append("unit", u);
  for (const c of x.people) q.append("person", c);
  for (const v of x.positions) q.append("pos", v);
  for (const a of x.assignees) q.append("assignee", a);
  if (x.where !== "any") q.set("where", x.where);
  q.set("basis", x.basis);
  for (const k of ["from", "to", "cfrom", "cto"] as const) if (x[k] !== null) q.set(k, String(x[k]));
  if (x.view !== "publications") q.set("view", x.view);
  if (x.sort !== "inventions") q.set("sort", x.sort);
  if (x.inventionSort !== "papers") q.set("isort", x.inventionSort);
  if (x.q) q.set("q", x.q);
  if (x.page > 1) q.set("page", String(x.page));
  return q.toString();
}

/** No filter set (the "Reset to defaults" test). */
export function isPatentCitationDefault(p: PatentCitationParams): boolean {
  const filters = (x: PatentCitationParams) =>
    patentCitationQueryString(x, { view: "publications", sort: "inventions", inventionSort: "papers", q: "" });
  return filters(p) === filters(parsePatentCitationParams(new URLSearchParams()));
}

// ---------------------------------------------------------------------------
// Access: report 24's rule, behind the flag.
// ---------------------------------------------------------------------------

type SessionLike = Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward">;

/** The gate, for the page and the index: the flag on, and something to see. */
export async function canViewPatentCitationsReport(session: SessionLike): Promise<boolean> {
  if (!isPatentCitationsReportEnabled()) return false;
  const scope = await loadPolicyCitationScope(session);
  return scope === null || scope.length > 0;
}

/** What the page and the download both do after parsing: pin the scope. */
export async function resolvePatentCitationParams(
  p: PatentCitationParams,
  session: SessionLike,
): Promise<PatentCitationParams> {
  return { ...p, scope: await loadPolicyCitationScope(session) };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const KIND_SQL = Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(d.details, '$.kind'))`;
const WHERE_SQL = Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(l.evidence, '$.where'))`;
/** `MIN()` of this over an invention's documents names the one that stands
 *  for it: granted before application, then earliest year, then lowest id.
 *  One digit, four, ten (`parseRep`). */
const REP_SQL = Prisma.sql`CONCAT(IF(${KIND_SQL} = 'application', '1', '0'), LPAD(COALESCE(d.year, 9999), 4, '0'), LPAD(d.id, 10, '0'))`;

function parseRep(rep: string): { id: number; year: number | null; application: boolean } {
  const year = Number(rep.slice(1, 5));
  return { id: Number(rep.slice(5)), year: year === 9999 ? null : year, application: rep[0] === "1" };
}

/** A filter on the patents themselves. */
const hasPatentFilter = (p: PatentCitationParams, opts: { assignees?: boolean } = {}): boolean =>
  p.cfrom !== null || p.cto !== null || p.where !== "any" || (opts.assignees !== false && p.assignees.length > 0);

/** Which patent documents are counted, after `d.level = 'patent'` (`d` =
 *  `citing_document`, `l` = the link). `assignees: false` leaves that filter
 *  out (the rail's own options). */
function patentSql(p: PatentCitationParams, opts: { assignees?: boolean } = {}): Prisma.Sql {
  const names = opts.assignees === false ? [] : p.assignees;
  return Prisma.sql`${yearWindow(Prisma.sql`d.year`, p.cfrom, p.cto)}
       ${
         names.length > 0
           ? Prisma.sql`AND (${Prisma.join(
               names.map((n) => Prisma.sql`JSON_CONTAINS(d.details, JSON_QUOTE(${n}), '$.assignees')`),
               " OR ",
             )})`
           : Prisma.empty
       }
       ${
         p.where === "any"
           ? Prisma.empty
           : Prisma.sql`AND ${WHERE_SQL} IN (${p.where}, 'both')`
       }`;
}

/** The rollup test on `p`. */
const IS_CITED_SQL = Prisma.sql`p.patent_family_count > 0`;

/** `ok`: the cited publications in scope, one row each, off the rollup (it
 *  can only over-include under a patent filter; the join to the links
 *  decides). */
const citedInScopeSql = (p: PatentCitationParams, opts: { people?: boolean } = {}): Prisma.Sql => Prisma.sql`(SELECT STRAIGHT_JOIN p.pmid
          FROM publication p
          JOIN publication_author pa ON pa.pmid = p.pmid
          JOIN scholar s ON s.cwid = pa.cwid
         WHERE ${IS_CITED_SQL}
           AND ${policyScopeSql(p, opts)}
           ${pubYearSql(p)}
         GROUP BY p.pmid) ok`;

/** `x`: inventions and the latest patent year per publication, counted live
 *  over the links, with no author in sight. */
const liveCitedSql = (p: PatentCitationParams): Prisma.Sql => Prisma.sql`(SELECT l.pmid, COUNT(DISTINCT d.dedup_key) AS inventions, MAX(d.year) AS latest
          FROM publication_citing_document l
          JOIN citing_document d ON d.id = l.citing_document_id
         WHERE d.level = 'patent' ${patentSql(p)}
         GROUP BY l.pmid) x`;

type Num = bigint | number;
const num = (v: Num | null): number | null => (v === null ? null : Number(v));

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export type PatentPubCounts = {
  pmid: string;
  year: number | null;
  /** Distinct inventions citing it. */
  inventions: number;
  /** The newest counted patent's year; null when read off the rollup. */
  latest: number | null;
};

/**
 * One row per cited publication in scope, unsorted.
 *
 * Two sources, as report 24 has. With no filter on the patents the count is
 * the rollup column `patent_family_count` and the link table is not read.
 * With one, or when the caller needs `latest` (the "Most recently cited"
 * sort, the download), it is the live aggregate over the links. Local
 * database (MariaDB, 249,341 patent links, 24,594 cited papers, 2026-11-26):
 * rollup 0.2 s warm, live 1.1 s.
 */
export async function loadPatentPublicationCounts(
  p: PatentCitationParams,
  opts: { latest?: boolean } = {},
): Promise<PatentPubCounts[]> {
  const live = hasPatentFilter(p) || opts.latest === true;
  const raw = live
    ? await db.read.$queryRaw<{ pmid: string; year: number | null; inventions: Num; latest: Num | null }[]>`
    SELECT STRAIGHT_JOIN x.pmid AS pmid, MAX(p.year) AS year, MAX(x.inventions) AS inventions, MAX(x.latest) AS latest
      FROM ${liveCitedSql(p)}
      JOIN publication p ON p.pmid = x.pmid
      JOIN publication_author pa ON pa.pmid = x.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${policyScopeSql(p)}
       ${pubYearSql(p)}
     GROUP BY x.pmid`
    : await db.read.$queryRaw<{ pmid: string; year: number | null; inventions: Num; latest: Num | null }[]>`
    SELECT STRAIGHT_JOIN p.pmid AS pmid, MAX(p.year) AS year, MAX(p.patent_family_count) AS inventions, NULL AS latest
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${IS_CITED_SQL}
       AND ${policyScopeSql(p)}
       ${pubYearSql(p)}
     GROUP BY p.pmid`;
  return raw.map((r) => ({
    pmid: r.pmid,
    year: num(r.year),
    inventions: Number(r.inventions),
    latest: num(r.latest),
  }));
}

/** Every sort falls back to most inventions, then publication year, newest first. */
export function sortPatentPublications<T extends PatentPubCounts>(rows: readonly T[], sort: PatentSort): T[] {
  const lead: Record<PatentSort, (a: T, b: T) => number> = {
    inventions: () => 0,
    recent: (a, b) => (b.latest ?? 0) - (a.latest ?? 0),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  };
  return [...rows].sort(
    (a, b) =>
      lead[sort](a, b) ||
      b.inventions - a.inventions ||
      (b.year ?? 0) - (a.year ?? 0) ||
      a.pmid.localeCompare(b.pmid),
  );
}

/** Papers and people in scope, cited or not: what the tiles' shares are of.
 *  `publication` is joined only for a year window. */
export async function loadScopeTotals(p: PatentCitationParams): Promise<{ papers: number; people: number }> {
  const [r] = await db.read.$queryRaw<{ papers: Num; people: Num }[]>`
    SELECT COUNT(DISTINCT pa.pmid) AS papers, COUNT(DISTINCT s.cwid) AS people
      FROM publication_author pa
      JOIN scholar s ON s.cwid = pa.cwid
      ${p.from !== null || p.to !== null ? Prisma.sql`JOIN publication p ON p.pmid = pa.pmid` : Prisma.empty}
     WHERE ${policyScopeSql(p)}
       ${pubYearSql(p)}`;
  return { papers: Number(r?.papers ?? 0), people: Number(r?.people ?? 0) };
}

export type PatentPersonRow = {
  cwid: string;
  name: string;
  orgUnit: string | null;
  personType: string;
  institution: string;
  /** Their papers cited in a patent. */
  papers: number;
  /** Distinct inventions citing those papers; null until
   *  `loadPersonInventions` fills it (the rows on the page, or the download). */
  inventions: number | null;
};

/** One row per scholar in scope with a cited paper, most papers first.
 *  Ignores the `person` filter (the Person facet reads it; `loadPatentCitations`
 *  applies the filter). `(pmid, cwid)` is unique among confirmed authorships,
 *  so counting rows is counting papers. */
export async function loadPatentPersonCounts(p: PatentCitationParams): Promise<PatentPersonRow[]> {
  type Row = {
    cwid: string;
    preferred_name: string;
    primary_department: string | null;
    role_category: string | null;
    primary_org_code: string | null;
    papers: Num;
  };
  const raw = hasPatentFilter(p)
    ? await db.read.$queryRaw<Row[]>`
    SELECT STRAIGHT_JOIN s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code,
           COUNT(*) AS papers
      FROM ${liveCitedSql(p)}
      JOIN publication p ON p.pmid = x.pmid
      JOIN publication_author pa ON pa.pmid = x.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${policyScopeSql(p, { people: false })}
       ${pubYearSql(p)}
     GROUP BY s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code`
    : await db.read.$queryRaw<Row[]>`
    SELECT STRAIGHT_JOIN s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code,
           COUNT(*) AS papers
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${IS_CITED_SQL}
       AND ${policyScopeSql(p, { people: false })}
       ${pubYearSql(p)}
     GROUP BY s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code`;
  return raw
    .map((r) => ({
      cwid: r.cwid,
      name: r.preferred_name,
      orgUnit: r.primary_department,
      personType: formatRoleCategory(r.role_category) ?? "",
      institution: r.primary_org_code ? institutionDisplayName(r.primary_org_code) : "",
      papers: Number(r.papers),
      inventions: null,
    }))
    .sort((a, b) => b.papers - a.papers || a.name.localeCompare(b.name));
}

/**
 * Distinct inventions citing each person's papers: `cwids` for the rows on a
 * page, null for everyone in scope (the download).
 * ponytail: this joins links to authorships, the one shape that cannot read a
 * rollup, so the page asks for 50 people at a time and By person sorts by
 * papers only. A per-person rollup table is the upgrade if a sort by
 * inventions is wanted. The join starts from the people for a page and from
 * the cited papers for everyone (the other way round took 11 s locally).
 */
export async function loadPersonInventions(
  p: PatentCitationParams,
  cwids: readonly string[] | null,
): Promise<Map<string, number>> {
  if (cwids !== null && cwids.length === 0) return new Map();
  const authorships =
    cwids === null
      ? Prisma.sql`publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid`
      : Prisma.sql`scholar s
      JOIN publication_author pa ON pa.cwid = s.cwid
      JOIN publication p ON p.pmid = pa.pmid`;
  const raw = await db.read.$queryRaw<{ cwid: string; inventions: Num }[]>`
    SELECT STRAIGHT_JOIN s.cwid, COUNT(DISTINCT d.dedup_key) AS inventions
      FROM ${authorships}
      JOIN publication_citing_document l ON l.pmid = p.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE ${IS_CITED_SQL}
       ${cwids === null ? Prisma.empty : Prisma.sql`AND s.cwid IN (${Prisma.join([...cwids])})`}
       AND ${policyScopeSql(p, { people: false })}
       ${pubYearSql(p)}
       AND d.level = 'patent' ${patentSql(p)}
     GROUP BY s.cwid`;
  return new Map(raw.map((r) => [r.cwid, Number(r.inventions)]));
}

// ---------------------------------------------------------------------------
// Inventions
// ---------------------------------------------------------------------------

export type InventionCounts = {
  /** The family key (`dedup_key`). */
  key: string;
  /** The document that stands for it. */
  docId: number;
  /** That document's year: granted, or published for an application. */
  year: number | null;
  /** No counted document of the invention is a granted patent. */
  application: boolean;
  /** Its counted documents citing a paper in scope. */
  docs: number;
  /** The papers in scope it cites. */
  papers: number;
};

/**
 * One row per invention citing a paper in scope, unsorted: the By invention
 * tab, its count, the Citing inventions tile and the chart all come from this
 * one pass over the links. Driven from the cited papers in scope (`ok`, off
 * the rollup), then their links by primary key. 1.7 s locally for 68,730
 * inventions (2026-11-26); starting from the patents with the who clause
 * behind an `EXISTS`, report 24's shape, took 2.5 s.
 */
export async function loadInventionCounts(p: PatentCitationParams): Promise<InventionCounts[]> {
  const raw = await db.read.$queryRaw<{ dedup_key: string; papers: Num; docs: Num; rep: string }[]>`
    SELECT STRAIGHT_JOIN d.dedup_key, COUNT(DISTINCT l.pmid) AS papers, COUNT(DISTINCT d.id) AS docs,
           MIN(${REP_SQL}) AS rep
      FROM ${citedInScopeSql(p)}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE d.level = 'patent' ${patentSql(p)}
     GROUP BY d.dedup_key`;
  return raw.map((r) => {
    const rep = parseRep(String(r.rep));
    return {
      key: r.dedup_key,
      docId: rep.id,
      year: rep.year,
      application: rep.application,
      docs: Number(r.docs),
      papers: Number(r.papers),
    };
  });
}

/** Every sort falls back to most papers, then newest, then the key. */
export function sortInventions<T extends InventionCounts>(rows: readonly T[], sort: InventionSort): T[] {
  const lead: Record<InventionSort, (a: T, b: T) => number> = {
    papers: () => 0,
    recent: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  };
  return [...rows].sort(
    (a, b) => lead[sort](a, b) || b.papers - a.papers || (b.year ?? 0) - (a.year ?? 0) || a.key.localeCompare(b.key),
  );
}

/** Inventions per year, the ten years ending where the patent data ends. An
 *  invention with no granted patent counts in the year its application was
 *  published. */
export function inventionYears(rows: readonly InventionCounts[], end: number = PATENT_DATA_END.year) {
  const byYear = new Map<number, number>();
  for (const r of rows) if (r.year !== null) byYear.set(r.year, (byYear.get(r.year) ?? 0) + 1);
  return Array.from({ length: 10 }, (_, i) => ({ year: end - 9 + i, count: byYear.get(end - 9 + i) ?? 0 }));
}

/** The inventions with a patent document matching the By invention search:
 *  title, patent number or assignee. Patent facts only, so there is nothing to
 *  scope; the caller intersects it with the scoped listing. */
export async function searchInventions(q: string): Promise<Set<string>> {
  const like = likeArg(q);
  // "US 9,000,001 B2" as the dataset's id has it: "us-9000001-b2".
  const digits = /\d{4,}/.exec(q.replace(/[\s,]/g, ""))?.[0];
  const raw = await db.read.$queryRaw<{ dedup_key: string }[]>`
    SELECT DISTINCT d.dedup_key
      FROM citing_document d
     WHERE d.level = 'patent'
       AND (d.title LIKE ${like}
            ${digits ? Prisma.sql`OR d.external_id LIKE ${`%${digits}%`}` : Prisma.empty}
            OR LOWER(CAST(JSON_EXTRACT(d.details, '$.assignees') AS CHAR)) LIKE ${like.toLowerCase()})`;
  return new Set(raw.map((r) => r.dedup_key));
}

export type AssigneeCount = { name: string; inventions: number; papers: number };

/** Inventions and the papers they cite per assignee name, most inventions
 *  first. A name is counted as printed on any counted document of the
 *  invention, so one company can appear under several spellings. */
export async function loadAssigneeCounts(
  p: PatentCitationParams,
  opts: { assignees?: boolean } = {},
): Promise<AssigneeCount[]> {
  const raw = await db.read.$queryRaw<{ name: string | null; inventions: Num; papers: Num }[]>`
    SELECT STRAIGHT_JOIN a.name, COUNT(DISTINCT d.dedup_key) AS inventions, COUNT(DISTINCT l.pmid) AS papers
      FROM ${citedInScopeSql(p)}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
      JOIN JSON_TABLE(d.details, '$.assignees[*]' COLUMNS (name VARCHAR(255) PATH '$')) a
     WHERE d.level = 'patent' ${patentSql(p, opts)}
     GROUP BY a.name
     ORDER BY inventions DESC, a.name
     LIMIT ${ASSIGNEE_OPTIONS}`;
  return raw.flatMap((r) =>
    r.name ? [{ name: r.name, inventions: Number(r.inventions), papers: Number(r.papers) }] : [],
  );
}

// ---------------------------------------------------------------------------
// Patent documents, as shown
// ---------------------------------------------------------------------------

export type PatentDoc = {
  id: number;
  title: string;
  url: string;
  /** "US90000001B2". */
  number: string;
  assignees: string[];
  /** "Given Family"; null when the document names none. */
  firstInventor: string | null;
  inventors: number;
};

/** "Assignee A; Assignee B", or the first inventor (et al.) when the document
 *  names no assignee, as most published applications do not. */
export function patentHolder(d: Pick<PatentDoc, "assignees" | "firstInventor" | "inventors">): string {
  if (d.assignees.length > 0) return d.assignees.join("; ");
  if (d.firstInventor === null) return "";
  return d.inventors > 1 ? `${d.firstInventor} et al.` : d.firstInventor;
}

/** "and 3 related patents", or "" for a document that stands alone. */
export function relatedPatentsLabel(docs: number): string {
  const n = docs - 1;
  return n <= 0 ? "" : `and ${n.toLocaleString()} related ${n === 1 ? "patent" : "patents"}`;
}

/** "granted 2019" / "application published 2021". */
export function patentYearLabel(year: number | null, application: boolean): string {
  const what = application ? "application published" : "granted";
  return year === null ? what : `${what} ${year}`;
}

export const WHERE_CITED_LABEL = {
  front: "cited on the front page",
  body: "cited in the patent's text",
  both: "cited in the text and on the front page",
} as const;

/** Patent facts for these document ids. Nothing here depends on who the
 *  viewer is: the ids come from a scoped listing. */
export async function loadPatentDocs(ids: readonly number[]): Promise<Map<number, PatentDoc>> {
  const out = new Map<number, PatentDoc>();
  // In chunks: the download asks for up to `PATENT_INVENTIONS_CAP` at once.
  for (let i = 0; i < ids.length; i += 5000) {
    const raw = await db.read.$queryRaw<
      { id: number; title: string; url: string; external_id: string; details: unknown }[]
    >`
      SELECT d.id, d.title, d.url, d.external_id, d.details
        FROM citing_document d
       WHERE d.id IN (${Prisma.join(ids.slice(i, i + 5000))})`;
    for (const r of raw) {
      // MariaDB hands JSON back as text, MySQL as an object.
      const details = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as Partial<PatentDetails> | null;
      const inventors = details?.inventors ?? [];
      const first = inventors[0];
      out.set(Number(r.id), {
        id: Number(r.id),
        title: r.title,
        url: r.url,
        number: parsePatentId(r.external_id)?.display ?? r.external_id.toUpperCase(),
        assignees: details?.assignees ?? [],
        firstInventor: first ? `${first.first} ${first.last}`.trim() : null,
        inventors: inventors.length,
      });
    }
  }
  return out;
}

const NO_DOC: Omit<PatentDoc, "id"> = { title: "", url: "", number: "", assignees: [], firstInventor: null, inventors: 0 };

/** One invention under a publication. */
export type CitingInvention = PatentDoc & {
  key: string;
  year: number | null;
  application: boolean;
  /** Its counted documents citing this paper. */
  docs: number;
  where: keyof typeof WHERE_CITED_LABEL;
};

export type PubInventions = {
  /** Inventions citing the paper, under the patent filters. */
  total: number;
  /** The newest counted patent's year. */
  latest: number | null;
  /** The newest `INVENTIONS_SHOWN` of them. */
  shown: CitingInvention[];
};

/** The citing inventions of these publications (one page of rows), per PMID,
 *  and only for publications the viewer may see (`scopedPubsSql`). */
export async function loadCitingInventions(
  p: PatentCitationParams,
  pmids: readonly string[],
): Promise<Map<string, PubInventions>> {
  const out = new Map<string, PubInventions>();
  if (pmids.length === 0) return out;
  const raw = await db.read.$queryRaw<
    { pmid: string; dedup_key: string; docs: Num; rep: string; latest: Num | null; front: Num | null; body: Num | null }[]
  >`
    SELECT ok.pmid, d.dedup_key, COUNT(DISTINCT d.id) AS docs, MIN(${REP_SQL}) AS rep, MAX(d.year) AS latest,
           MAX(${WHERE_SQL} IN ('front', 'both')) AS front, MAX(${WHERE_SQL} IN ('body', 'both')) AS body
      FROM ${scopedPubsSql(p, pmids)}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE d.level = 'patent' ${patentSql(p)}
     GROUP BY ok.pmid, d.dedup_key`;
  const groups = new Map<string, (Omit<CitingInvention, keyof PatentDoc> & { id: number })[]>();
  for (const r of raw) {
    const rep = parseRep(String(r.rep));
    const list = groups.get(r.pmid) ?? [];
    groups.set(r.pmid, list);
    const front = Number(r.front ?? 0) > 0;
    const body = Number(r.body ?? 0) > 0;
    list.push({
      id: rep.id,
      key: r.dedup_key,
      year: rep.year,
      application: rep.application,
      docs: Number(r.docs),
      where: front && body ? "both" : front ? "front" : "body",
    });
    const pub = out.get(r.pmid) ?? { total: 0, latest: null, shown: [] };
    out.set(r.pmid, pub);
    pub.total += 1;
    const latest = num(r.latest);
    if (latest !== null && latest > (pub.latest ?? 0)) pub.latest = latest;
  }
  for (const list of groups.values()) list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.id - b.id).splice(INVENTIONS_SHOWN);
  // One document can stand for an invention under several publications.
  const docs = await loadPatentDocs([...new Set([...groups.values()].flatMap((list) => list.map((g) => g.id)))]);
  for (const [pmid, list] of groups) {
    out.get(pmid)!.shown = list.map((g) => ({ ...NO_DOC, ...docs.get(g.id), ...g }));
  }
  return out;
}

export type PatentPubRow = PatentPubCounts & PubDetails & { shown: CitingInvention[] };

/** The rows of one page, or one sheet: each publication's own columns and
 *  authors, and (`inventions`) its citing inventions. */
export async function withPublicationDetails(
  p: PatentCitationParams,
  rows: readonly PatentPubCounts[],
  opts: { inventions: boolean },
): Promise<PatentPubRow[]> {
  const pmids = rows.map((r) => r.pmid);
  const [pubs, inventions] = await Promise.all([
    loadPublicationDetails(p, pmids),
    opts.inventions ? loadCitingInventions(p, pmids) : new Map<string, PubInventions>(),
  ]);
  return rows.map((r) => {
    const inv = inventions.get(r.pmid);
    return {
      ...r,
      ...(pubs.get(r.pmid) ?? { title: "", journal: null, doi: null, authors: [] }),
      latest: r.latest ?? inv?.latest ?? null,
      shown: inv?.shown ?? [],
    };
  });
}

export type InventionRow = InventionCounts &
  Omit<PatentDoc, "id"> & {
    /** The newest `INVENTION_PAPERS_SHOWN` of the papers in scope it cites. */
    shown: { pmid: string; title: string; journal: string | null; year: number | null }[];
  };

/**
 * The rows of one page, or one sheet: each invention's patent facts, and
 * (`papers`) the papers in scope it cites.
 *
 * The papers query joins authorships rather than testing them behind
 * `EXISTS`: MariaDB materialised the whole authorship table for the `EXISTS`
 * (1.9 s locally for one page, against 0.1 s this way, 2026-11-26).
 * ponytail: `dedup_key` has no index, so finding one page's keys reads every
 * patent row (112,000 locally, 0.04 s). An index on it is the upgrade.
 */
export async function withInventionDetails(
  p: PatentCitationParams,
  rows: readonly InventionCounts[],
  opts: { papers: boolean },
): Promise<InventionRow[]> {
  if (rows.length === 0) return [];
  type Paper = { pmid: string; title: string; journal: string | null; year: number | null };
  const [docs, pairs] = await Promise.all([
    loadPatentDocs(rows.map((r) => r.docId)),
    opts.papers
      ? db.read.$queryRaw<(Paper & { dedup_key: string })[]>`
      SELECT STRAIGHT_JOIN d.dedup_key, p.pmid, MAX(p.year) AS year, MAX(p.title) AS title, MAX(p.journal) AS journal
        FROM citing_document d
        JOIN publication_citing_document l ON l.citing_document_id = d.id
        JOIN publication p ON p.pmid = l.pmid
        JOIN publication_author pa ON pa.pmid = p.pmid
        JOIN scholar s ON s.cwid = pa.cwid
       WHERE d.level = 'patent'
         AND d.dedup_key IN (${Prisma.join(rows.map((r) => r.key))})
         ${patentSql(p)}
         AND ${policyScopeSql(p)}
         ${pubYearSql(p)}
       GROUP BY d.dedup_key, p.pmid`
      : [],
  ]);
  const byKey = new Map<string, Paper[]>();
  for (const { dedup_key, ...r } of pairs) {
    const list = byKey.get(dedup_key) ?? [];
    byKey.set(dedup_key, list);
    list.push({ ...r, year: num(r.year) });
  }
  return rows.map((r) => ({
    ...NO_DOC,
    ...docs.get(r.docId),
    ...r,
    shown: (byKey.get(r.key) ?? [])
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.pmid.localeCompare(b.pmid))
      .slice(0, INVENTION_PAPERS_SHOWN),
  }));
}

// ---------------------------------------------------------------------------
// The one loader the page and the download share
// ---------------------------------------------------------------------------

export type PatentCitationData = {
  /** Papers and people in scope, cited or not. */
  scope: { papers: number; people: number };
  /** Cited publications in scope. */
  pubTotal: number;
  /** Those the search keeps, in the chosen order: what the pages run over. */
  pubs: PatentPubCounts[];
  /** Inventions citing a paper in scope. */
  inventionTotal: number;
  /** Those the search keeps, in the chosen order. */
  inventions: InventionCounts[];
  /** The chart: inventions per year, ten years. */
  years: { year: number; count: number }[];
  /** The card: most inventions first, under every filter. */
  assignees: AssigneeCount[];
  /** The rail's options: the same, ignoring the `assignee` filter. */
  assigneeOptions: AssigneeCount[];
  /** People in scope with a cited paper (the `person` filter applied). */
  peopleTotal: number;
  /** Those the search keeps, most papers first; `inventions` not yet filled. */
  people: PatentPersonRow[];
  /** The Person facet: everyone in scope ignoring the `person` filter. */
  facetPeople: PatentPersonRow[];
};

/** Counts and listings, with no row details: the caller slices a page (or a
 *  sheet) and loads the details for those rows. `q` searches the tab it was
 *  typed on: publications by title, PMID or author; inventions by patent
 *  title, number or assignee; people by name or CWID. */
export async function loadPatentCitations(
  p: PatentCitationParams,
  opts: { latest?: boolean } = {},
): Promise<PatentCitationData> {
  const [scope, counts, everyone, inventions, assignees, assigneeOptions, pubHits, inventionHits] = await Promise.all([
    loadScopeTotals(p),
    loadPatentPublicationCounts(p, { latest: opts.latest === true || p.sort === "recent" }),
    loadPatentPersonCounts(p),
    loadInventionCounts(p),
    loadAssigneeCounts(p),
    p.assignees.length > 0 ? loadAssigneeCounts(p, { assignees: false }) : null,
    p.q && p.view === "publications" ? searchPublications(p, p.q, IS_CITED_SQL) : null,
    p.q && p.view === "inventions" ? searchInventions(p.q) : null,
  ]);
  const picked = p.people.length > 0 ? everyone.filter((r) => p.people.includes(r.cwid)) : everyone;
  const needle = p.view === "people" ? p.q.toLowerCase() : "";
  return {
    scope,
    pubTotal: counts.length,
    pubs: sortPatentPublications(pubHits ? counts.filter((r) => pubHits.has(r.pmid)) : counts, p.sort),
    inventionTotal: inventions.length,
    inventions: sortInventions(
      inventionHits ? inventions.filter((r) => inventionHits.has(r.key)) : inventions,
      p.inventionSort,
    ),
    years: inventionYears(inventions),
    assignees: assignees.slice(0, ASSIGNEES_SHOWN),
    assigneeOptions: assigneeOptions ?? assignees,
    peopleTotal: picked.length,
    people: picked.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.cwid.toLowerCase() === needle),
    facetPeople: everyone,
  };
}

// ---------------------------------------------------------------------------
// Chips, criteria, workbook
// ---------------------------------------------------------------------------

/** The active filters as chips; the viewer's scope first, and not removable. */
export function patentCitationChips(
  p: PatentCitationParams,
  unitLabel: ReadonlyMap<string, string> = new Map(),
  personName: ReadonlyMap<string, string> = new Map(),
): PolicyChip[] {
  const qs = (next: Partial<PatentCitationParams>) => patentCitationQueryString(p, next);
  const chips = whoChips(p, qs, unitLabel, personName);
  const published = yearSpan(p.from, p.to, fiscalLabel(p));
  if (published) chips.push({ group: "Published", value: published, removeQuery: qs({ from: null, to: null }) });
  const patentYear = yearSpan(p.cfrom, p.cto);
  if (patentYear) {
    chips.push({ group: "Patent year", value: patentYear, removeQuery: qs({ cfrom: null, cto: null }) });
  }
  chips.push(...facetChips("Assignee", p.assignees, (a) => a, (keep) => qs({ assignees: p.assignees.filter(keep) })));
  if (p.where !== "any") {
    chips.push({ group: "Where cited", value: WHERE_LABEL[p.where], removeQuery: qs({ where: "any" }) });
  }
  return chips;
}

/** Why recent papers show little, on the page and in the Criteria sheet. */
export const PATENT_LAG_NOTICE =
  "Patents usually cite a paper years after it is published: half of first citations come seven or more years later. Recent papers show few or none, so this report says little about the last five years of work.";
export const PATENT_SOURCES =
  "Sources: Reliance on Science (Marx and Fuegi), CC BY-NC 4.0, with patent details from USPTO PatentsView. US patents only. A patent citing a paper does not mean the paper's authors hold the patent.";

/** The Criteria sheet, verbatim: every filter, "All" when unset. */
export function describePatentCitationCriteria(
  p: PatentCitationParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
): [string, string][] {
  const search = { publications: "Search (publications)", inventions: "Search (inventions)", people: "Search (people)" };
  return [
    ["Report", "25. Patent citations"],
    ["Generated", generatedAt.toISOString()],
    ...whoCriteria(p, labels),
    ...pubYearCriteria(p),
    ["Patent year granted or published", yearSpan(p.cfrom, p.cto) ?? "All"],
    ["Assignee", p.assignees.length > 0 ? p.assignees.join("; ") : "All"],
    ["Where cited", WHERE_LABEL[p.where]],
    ["Order", `${PATENT_SORT_LABEL[p.sort]} (publications); ${INVENTION_SORT_LABEL[p.inventionSort].toLowerCase()} (inventions)`],
    ...(p.q ? ([[search[p.view], p.q]] as [string, string][]) : []),
    [
      "Counting rule",
      "Counts are inventions: related patents (one patent family) count once, and an invention is listed by its earliest granted patent. Only ReCiter-confirmed authorships of active scholars count; person type, department, division, institution and center membership are the scholar's current values.",
    ],
    ["Reading the numbers", `${PATENT_LAG_NOTICE} The patent data ends at ${PATENT_DATA_END.label}.`],
    ["Sources", PATENT_SOURCES.replace(/^Sources: /, "")],
  ];
}

const plain = (s: string) => htmlToPlainText(s, Number.POSITIVE_INFINITY);
const sheetNote = (shown: number, total: number, what: string, cap: number) =>
  total > shown
    ? `Lists the first ${shown.toLocaleString()} of ${total.toLocaleString()} ${what} in the order above (the limit is ${cap.toLocaleString()}). Narrow the filters to list the rest.`
    : `Lists all ${total.toLocaleString()} ${what} (the limit is ${cap.toLocaleString()}).`;

/**
 * The workbook: Publications, Inventions, People, Criteria.
 *
 * The People sheet follows report 24's decided, named exception to the
 * 50-scholar export cap (`SCHOLAR_EXPORT_CAP`, `lib/api/export-scholars.ts`,
 * which is left as it is) and goes no further: every matching person, with
 * name, CWID, org unit, person type, primary institution and the counts, and
 * no contact details.
 */
export async function buildPatentCitationWorkbook(
  p: PatentCitationParams,
  data: {
    pubs: PatentPubRow[];
    pubTotal: number;
    inventions: InventionRow[];
    inventionTotal: number;
    people: PatentPersonRow[];
  },
  generatedAt: Date,
  labels?: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, header: string[], widths: number[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(header);
    boldRow(ws, 1);
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const [i, w] of widths.entries()) ws.getColumn(i + 1).width = w;
    return ws;
  };

  const pubs = sheet(
    "Publications",
    ["PMID", "Title", "Journal", "Year", "WCM authors", "Citing inventions", "Latest citing patent year", "DOI"],
    [12, 70, 30, 8, 40, 14, 14, 28],
  );
  for (const r of data.pubs) {
    pubs.addRow([
      r.pmid,
      plain(r.title),
      r.journal ? plain(r.journal) : r.journal,
      r.year,
      r.authors.map((a) => `${a.name} (${a.position} author)`).join("; "),
      r.inventions,
      r.latest,
      r.doi,
    ]);
  }
  pubs.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  pubs.getColumn(5).alignment = { wrapText: true, vertical: "top" };

  const inventions = sheet(
    "Inventions",
    ["Patent", "Title", "Assignees", "First inventor", "Granted or published", "Year", "Related patents", "WCM papers cited", "Link"],
    [20, 70, 40, 24, 22, 8, 14, 14, 46],
  );
  for (const r of data.inventions) {
    inventions.addRow([
      r.number,
      r.title,
      r.assignees.join("; "),
      r.firstInventor,
      r.application ? "Application published" : "Granted",
      r.year,
      Math.max(0, r.docs - 1),
      r.papers,
      r.url,
    ]);
  }
  inventions.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const people = sheet(
    "People",
    ["Name", "CWID", "Org unit", "Person type", "Primary institution", "Papers cited in a patent", "Citing inventions"],
    [28, 10, 30, 22, 28, 16, 14],
  );
  for (const r of data.people) {
    people.addRow([r.name, r.cwid, r.orgUnit, r.personType, r.institution, r.papers, r.inventions]);
  }

  addCriteriaSheet(wb, [
    ...describePatentCitationCriteria(p, generatedAt, labels),
    ["Publications sheet", sheetNote(data.pubs.length, data.pubTotal, "publications", PATENT_LIST_CAP)],
    [
      "Inventions sheet",
      `One row per invention, shown by its earliest granted patent. ${sheetNote(data.inventions.length, data.inventionTotal, "inventions", PATENT_INVENTIONS_CAP)}`,
    ],
    [
      "People sheet",
      `Lists all ${data.people.length.toLocaleString()} people, with no contact details. This report follows report 24's exemption from the 50-person limit on scholar exports.`,
    ],
  ]);

  return workbookBuffer(wb);
}
