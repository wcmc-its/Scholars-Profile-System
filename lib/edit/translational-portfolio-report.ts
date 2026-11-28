/**
 * Report 26 — "Translational portfolio": where WCM publications sit on the
 * translational spectrum (T0 → T3–4), how that changed over the years, by
 * department / division / center / research area, and who does the work.
 * Grants and clinical trials are counted beside publications (tiles, unit
 * table, scholar rows, their own lists; rules in
 * `translational-portfolio-activities.ts`). Trials carry a stage from their
 * trial phase, kept as a separate series: `act=trials` switches the stage
 * charts and the table's stage columns to them, never mixing them into
 * publication shares.
 * Grants have no stage yet.
 *
 * Scope: report 8's own (`scopeSql`, `lib/edit/article-count-report.ts`) —
 * ReCiter-confirmed authorships of active scholars, the unit rule
 * (`personFilterSql`: department / division incl. a manual division's
 * hand-added members / current center members), calendar year of
 * publication, research articles only (`PORTFOLIO_ARTICLE_TYPES`). So a year's
 * stage split here equals report 8's for the same unit and years with
 * `atype=Academic Article`. On top: a research area (`publication_topic`, the topic
 * pages' 0.3 score floor) and a scholar (that person's first- or
 * senior-author papers).
 *
 * Stage rule: `displayStage` — a T stage, confidence not "low". Everything
 * else is "No stage", computed as the remainder. Shares (and gaps) are among
 * STAGED publications only (`stagedShares`), so falling coverage (#3610) does
 * not read as a shift between stages; how many have a stage is its own figure,
 * "Stage assigned".
 *
 * People are described, never ranked by share: the Scholars list counts each
 * scholar's first- or senior-author publications (`is_first` / `is_last`, the
 * people ranking's `firstOrLast`), lists only those with at least
 * `MIN_SCHOLAR_ACTIVITIES`, and sorts by count.
 *
 * URL (all optional; a bad value falls back, never a 400): `unit` (the shared
 * who-filter vocabulary, `parsePersonFilter`), `from` / `to`, `area` (topic
 * id, repeated), `gaps=1` (Research areas tab: gapped areas only), `rows=all`
 * (the whole unit table), `stage` (repeated), `cwid` (scope to one scholar),
 * `q` (name / CWID lookup), `by` (table tab), `view` (`scholars`, the default,
 * | `activities`), `page`.
 *
 * Gate: report 8's audience (`canViewArticleCountReport`), and only while
 * REPORT_TRANSLATIONAL_PORTFOLIO and SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET are
 * both "on". Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { cachedRead } from "@/lib/api/swr-cache";
import { resolveSearchPubsTranslationalStageFacet } from "@/lib/api/search-flags";
import { TOPIC_ACTIVITY_SCORE_FLOOR } from "@/lib/api/topic-activity";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  canViewArticleCountReport,
  NO_STAGE_LABEL,
  scopeSql,
  STAGE_NOT_LOW,
  type ArticleCountParams,
} from "@/lib/edit/article-count-report";
import {
  currentCenterMembershipSql,
  MANUAL_DIVISION_SOURCE,
  parsePersonFilter,
  personFilterCriteria,
  personFilterSql,
  unitLabels,
  utcToday,
} from "@/lib/edit/person-filter";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import { institutionDisplayName } from "@/lib/institutions";
import {
  ACTIVITY_AREA_RULE,
  GRANT_RULE,
  loadPortfolioGrants,
  loadPortfolioTrials,
  loadUnitMemberships,
  peopleOf,
  stageCountsOfItems,
  stageTally,
  tally,
  TRIAL_RULE,
  unitKeys,
  type ActivityScope,
  type PortfolioGrant,
  type PortfolioTrial,
} from "@/lib/edit/translational-portfolio-activities";
import { Prisma } from "@/lib/generated/prisma/client";
import { formatRoleCategory } from "@/lib/role-display";
import {
  countsIn,
  countsTotal,
  emptyCounts,
  exactStagedShares,
  isTranslationalStage,
  STAGE_BUCKETS,
  STAGE_RULE,
  stageAssignedShare,
  stagedShares,
  stagedTotal,
  TRIAL_STAGE_RULE,
  TRANSLATIONAL_STAGES,
  translationalStageDisplay,
  type StageCounts,
  type TranslationalStage,
} from "@/lib/translational-stage";

/** A research area's stage under this share of its STAGED publications is
 *  called out as a gap… */
export const GAP_SHARE = 3;
/** …but only for an area with at least this many staged publications (noise). */
export const MIN_AREA_SIZE = 50;
/** The unit table shows this many rows until "View all". */
export const TABLE_PREVIEW_ROWS = 9;
/** The Scholars list leaves out anyone with fewer qualifying publications. */
export const MIN_SCHOLAR_ACTIVITIES = 3;
/** Rows per page, both lists. */
export const PORTFOLIO_PAGE_SIZE = 25;

export function isTranslationalPortfolioReportEnabled(): boolean {
  return process.env.REPORT_TRANSLATIONAL_PORTFOLIO === "on" && resolveSearchPubsTranslationalStageFacet();
}

export async function canViewTranslationalPortfolioReport(session: EditSession): Promise<boolean> {
  return isTranslationalPortfolioReportEnabled() && canViewArticleCountReport(session);
}

export const UNIT_TABS = {
  dept: { label: "Departments", head: "Department" },
  div: { label: "Divisions", head: "Division" },
  center: { label: "Centers", head: "Center or institute" },
  area: { label: "Research areas", head: "Research area" },
} as const;
export type UnitTab = keyof typeof UNIT_TABS;

/** The list under the table: scholars (the default), publications
 *  (`activities`), grants or clinical trials. */
export const PORTFOLIO_VIEWS = ["scholars", "activities", "grants", "trials"] as const;
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number];

/** Whose stages the charts and table show (`act`): publications, or clinical trials. */
export type StageActivity = "pubs" | "trials";

export type PortfolioParams = {
  /** Encoded unit values (`dept:` / `div:` / `center:` + CODE). The rail sends
   *  one; the parser keeps accepting several, as report 8's links do. */
  units: string[];
  from: number;
  to: number;
  /** Research area topic ids (repeated `area`); a publication in ANY counts. */
  areas: string[];
  /** Primary institution codes (repeated `inst`, `Scholar.primaryOrgCode`): a
   *  scholar at ANY counts, and the filter narrows the unit (AND), unlike report
   *  8's `unit=inst:`, which ORs with the other units. */
  insts: string[];
  /** Research areas tab: only the areas with a gap (`gaps=1`). */
  gaps: boolean;
  /** The unit table in full instead of its first `TABLE_PREVIEW_ROWS` (`rows=all`). */
  allRows: boolean;
  stages: TranslationalStage[];
  cwid: string | null;
  q: string;
  by: UnitTab;
  view: PortfolioView;
  /** `act=trials`: the stage charts and table columns show trials' stages. */
  act: StageActivity;
  page: number;
};

/** The first publication year with stages: ReciterAI staged almost nothing
 *  earlier (49 publications across 2016–2019, staging 2026-11-27), so a
 *  window starting before it reads as a shift that is only missing data. */
export const FIRST_STAGED_YEAR = 2020;

/** Research articles only (report 8's `atype`; ReCiter's "Academic Article",
 *  shown as Research Article). Reviews, editorials, letters, book chapters and
 *  errata almost never get a stage (165 of them staged across 2020-2025), so
 *  counting them only inflated No stage (#3610). */
export const PORTFOLIO_ARTICLE_TYPES: readonly string[] = ["Academic Article"];

/** The default window: `FIRST_STAGED_YEAR` through the current year. The
 *  current year is partial, but shares are within each year and its staging
 *  keeps pace (2026: 44% staged, 2025: 47%, staging 2026-11-28), so it reads
 *  like any other year; only its counts are smaller. */
export function defaultYears(now = new Date()): { from: number; to: number } {
  const y = now.getUTCFullYear();
  return { from: FIRST_STAGED_YEAR, to: Math.max(FIRST_STAGED_YEAR, y) };
}

export function parsePortfolioParams(sp: URLSearchParams): PortfolioParams {
  const d = defaultYears();
  const int = (k: string, dflt: number, lo: number, hi: number) => {
    const n = Number.parseInt(sp.get(k) ?? "", 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const from = int("from", d.from, 1900, 2100);
  const to = Math.max(from, int("to", d.to, 1900, 2100));
  const cwid = sp.get("cwid")?.trim() ?? "";
  const by = sp.get("by");
  const unitValues = parsePersonFilter(sp).unitValues;
  return {
    units: unitValues.filter((u) => !u.startsWith("inst:")),
    from,
    to,
    areas: [...new Set(sp.getAll("area").map((a) => a.trim()))].filter((a) => /^[A-Za-z0-9_-]{1,128}$/.test(a)).slice(0, 50),
    // A report 8 link's `unit=inst:X` lands here too, as a filter on the scope.
    insts: [...new Set([...sp.getAll("inst"), ...unitValues.filter((u) => u.startsWith("inst:")).map((u) => u.slice(5))].map((c) => c.trim()))]
      .filter((c) => /^[A-Za-z0-9 _-]{1,32}$/.test(c))
      .slice(0, 50),
    gaps: sp.get("gaps") === "1",
    allRows: sp.get("rows") === "all",
    stages: TRANSLATIONAL_STAGES.filter((s) => sp.getAll("stage").includes(s)),
    cwid: /^[A-Za-z0-9]{2,32}$/.test(cwid) ? cwid : null,
    q: (sp.get("q") ?? "").trim().slice(0, 100),
    by: by && by in UNIT_TABS ? (by as UnitTab) : "dept",
    // The Scholars list is the default; `view=activities` is the publication list.
    view: (PORTFOLIO_VIEWS as readonly string[]).includes(sp.get("view") ?? "") ? (sp.get("view") as PortfolioView) : "scholars",
    act: sp.get("act") === "trials" ? "trials" : "pubs",
    page: int("page", 1, 1, 10_000),
  };
}

/** The params the report page and its `.xlsx` read: never one scholar. One
 *  scholar is their own page (`/edit/scholar/[cwid]/translational-portfolio`),
 *  gated by `authorizeCvExport`; the report's gate is wider, so `?cwid=` must
 *  not scope anything here (the page redirects it, the download ignores it). */
export function parsePortfolioReportParams(sp: URLSearchParams): PortfolioParams {
  return { ...parsePortfolioParams(sp), cwid: null };
}

/** The canonical query string: every selection, so a view round-trips. */
export function portfolioQueryString(p: PortfolioParams): string {
  const q = new URLSearchParams();
  for (const u of p.units) q.append("unit", u);
  q.set("from", String(p.from));
  q.set("to", String(p.to));
  for (const a of p.areas) q.append("area", a);
  for (const i of p.insts) q.append("inst", i);
  if (p.gaps) q.set("gaps", "1");
  if (p.allRows) q.set("rows", "all");
  for (const s of p.stages) q.append("stage", s);
  if (p.cwid) q.set("cwid", p.cwid);
  if (p.q) q.set("q", p.q);
  if (p.by !== "dept") q.set("by", p.by);
  if (p.view !== "scholars") q.set("view", p.view);
  if (p.act !== "pubs") q.set("act", p.act);
  if (p.page > 1) q.set("page", String(p.page));
  return q.toString();
}

/** "T0 + T2" — the selection as the page names it. */
export function stagesLabel(stages: readonly TranslationalStage[]): string {
  return stages.map((s) => s.replace("-", "–")).join(" + ");
}

// ---------------------------------------------------------------------------
// Counts and shares (pure).
// ---------------------------------------------------------------------------

// Moved to `@/lib/translational-stage` (client-safe); re-exported for this report's callers.
export {
  countsIn,
  countsTotal,
  emptyCounts,
  exactStagedShares,
  STAGE_BUCKETS,
  stageAssignedShare,
  stagedShares,
  stagedTotal,
  STAGE_RULE,
  type StageBucket,
  type StageCounts,
  type StageShares,
} from "@/lib/translational-stage";
/** The T stages an area is thin at: under `GAP_SHARE` of its STAGED
 *  publications (No stage is not in the denominator, matching the shares the
 *  page shows), for an area with at least `MIN_AREA_SIZE` staged publications
 *  (else none). */
export function gapStages(c: StageCounts): TranslationalStage[] {
  if (stagedTotal(c) < MIN_AREA_SIZE) return [];
  const ex = exactStagedShares(c);
  return TRANSLATIONAL_STAGES.filter((s) => ex[s] < GAP_SHARE);
}

export type TableRow = { key: string; counts: StageCounts };

/** The unit table's order: with stages picked, by share in the pick; on
 *  Research areas with nothing picked, the sized areas by thinnest stage
 *  first, then the small ones by volume; else by volume. */
export function sortTableRows<T extends TableRow>(
  rows: T[],
  tab: UnitTab,
  stages: readonly TranslationalStage[],
  /** The stage counts to sort on (a row's trials under `act=trials`). */
  countsOf: (r: T) => StageCounts = (r) => r.counts,
): T[] {
  const vol = (a: T, b: T) => countsTotal(countsOf(b)) - countsTotal(countsOf(a)) || a.key.localeCompare(b.key);
  if (stages.length > 0) {
    const share = (r: T) => stages.reduce((n, s) => n + exactStagedShares(countsOf(r))[s], 0);
    return [...rows].sort((a, b) => share(b) - share(a) || vol(a, b));
  }
  if (tab === "area") {
    const sized = (r: T) => stagedTotal(countsOf(r)) >= MIN_AREA_SIZE;
    const thin = (r: T) => Math.min(...TRANSLATIONAL_STAGES.map((s) => exactStagedShares(countsOf(r))[s]));
    return [...rows].sort(
      (a, b) => Number(sized(b)) - Number(sized(a)) || (sized(a) ? thin(a) - thin(b) : 0) || vol(a, b),
    );
  }
  return [...rows].sort(vol);
}

/** The Scholars list: each scholar's count in the picked stages (all four T
 *  stages when none is picked), at least `MIN_SCHOLAR_ACTIVITIES`, by count. */
export function rankScholars(
  byCwid: ReadonlyMap<string, StageCounts>,
  stages: readonly TranslationalStage[],
): { cwid: string; n: number; counts: StageCounts }[] {
  const pick = stages.length > 0 ? stages : TRANSLATIONAL_STAGES;
  return [...byCwid]
    .map(([cwid, counts]) => ({ cwid, n: countsIn(counts, pick), counts }))
    .filter((r) => r.n >= MIN_SCHOLAR_ACTIVITIES)
    .sort((a, b) => b.n - a.n || a.cwid.localeCompare(b.cwid));
}

// ---------------------------------------------------------------------------
// Queries.
// ---------------------------------------------------------------------------

/** The SQL form of `displayStage`: the stage, else NULL (= No stage). */
const stageCase = () => Prisma.sql`CASE WHEN p.translational_stage IN (${Prisma.join([...TRANSLATIONAL_STAGES])}) AND ${STAGE_NOT_LOW} THEN p.translational_stage END`;

/** Report 8's params for this view. A scholar scope is that scholar's first-
 *  or senior-author papers (`pos: "either"` plus the cwid clause). */
function articleScope(p: PortfolioParams, opts: { stages?: TranslationalStage[]; units?: string[] } = {}): ArticleCountParams {
  return {
    types: [],
    units: opts.units ?? p.units,
    atypes: [...PORTFOLIO_ARTICLE_TYPES],
    stages: opts.stages ?? [],
    jif: 0,
    pos: p.cwid ? "either" : "any",
    basis: "cy",
    from: p.from,
    to: p.to,
    added: null,
    list: null,
    listData: null,
  };
}

/** The area, institution and scholar clauses on top of report 8's scope.
 *  `insts: false` leaves the institution out (the all-of-WCM baseline). */
function extraSql(p: PortfolioParams, opts: { insts?: boolean } = {}): Prisma.Sql {
  return Prisma.sql`${
    p.insts.length > 0 && opts.insts !== false
      ? personFilterSql({ types: [], unitValues: p.insts.map((c) => `inst:${c}`) }, { scholar: "s" })
      : Prisma.empty
  } ${
    p.areas.length > 0
      ? Prisma.sql`AND p.pmid IN (SELECT pt_a.pmid FROM publication_topic pt_a WHERE pt_a.parent_topic_id IN (${Prisma.join(p.areas)}) AND pt_a.score >= ${TOPIC_ACTIVITY_SCORE_FLOOR})`
      : Prisma.empty
  } ${p.cwid ? Prisma.sql`AND pa.cwid = ${p.cwid}` : Prisma.empty}`;
}

/** The scoped (publication, author, year, department, stage) rows — the one
 *  set every count below groups. `byYear` drives the join from the year window
 *  (`publication(year)`) instead of a full `publication_author` scan: about 2x
 *  faster on staging (3.4 s → 1.6 s), the same rows. Off when the scope is a
 *  handful of CWIDs, where the `publication_author(cwid)` index wins. */
function scopedSelect(ac: ArticleCountParams, extra: Prisma.Sql, byYear = true): Prisma.Sql {
  const { fromWhere } = scopeSql(ac, extra);
  const hint = byYear ? Prisma.raw("/*+ JOIN_PREFIX(p) */") : Prisma.empty;
  return Prisma.sql`SELECT ${hint} DISTINCT pa.pmid, pa.cwid, p.year AS y, s.dept_code AS dc, ${stageCase()} AS st ${fromWhere}`;
}

function scopedRows(ac: ArticleCountParams, extra: Prisma.Sql, byYear = true): Prisma.Sql {
  return Prisma.sql`(${scopedSelect(ac, extra, byYear)}) x`;
}

/** `areaPeople`: per research area, the scholars the Scholars list would show
 *  for that area (run over the list's first / senior scope, at least
 *  `MIN_SCHOLAR_ACTIVITIES` papers in the picked stages), so the area table's
 *  "N scholars" link opens a list of N; its count lands in the `none` bucket. */
type Grouping = "all" | "year" | "cwid" | "areaPeople" | UnitTab;

/** How each grouping maps a scoped row to its group: the unit rule
 *  `personFilterSql` applies, as a join instead of a filter. */
function groupSql(g: Grouping): { key: Prisma.Sql; join: Prisma.Sql } {
  const today = utcToday();
  switch (g) {
    case "all":
      return { key: Prisma.sql`'all'`, join: Prisma.empty };
    case "year":
      return { key: Prisma.sql`x.y`, join: Prisma.empty };
    case "cwid":
      return { key: Prisma.sql`x.cwid`, join: Prisma.empty };
    case "dept":
      return { key: Prisma.sql`x.dc`, join: Prisma.sql`WHERE x.dc IS NOT NULL` };
    case "div":
      return {
        key: Prisma.sql`m.g`,
        join: Prisma.sql`JOIN (
            SELECT cwid, div_code AS g FROM scholar WHERE div_code IS NOT NULL
            UNION
            SELECT dm.cwid, dm.division_code FROM division_membership dm
              JOIN division d ON d.code = dm.division_code
             WHERE d.source = ${Prisma.raw(`'${MANUAL_DIVISION_SOURCE}'`)}
          ) m ON m.cwid = x.cwid`,
      };
    case "center":
      return {
        key: Prisma.sql`cm.center_code`,
        join: Prisma.sql`JOIN center_membership cm ON cm.cwid = x.cwid AND ${currentCenterMembershipSql("cm", today)}`,
      };
    case "areaPeople":
    case "area":
      // `v`: the scope's distinct (publication, area) pairs, built in `stageCounts`.
      return { key: Prisma.sql`v.g`, join: Prisma.sql`JOIN v ON v.pmid = x.pmid` };
  }
}

/** Distinct publications per group, split by displayed stage, for several
 *  groupings in ONE query: the scoped set is built once (CTE `x`) and each
 *  grouping is a `UNION ALL` branch over it. The read replica runs parallel
 *  scans no faster than serial ones, so one scan instead of one per grouping is
 *  the win (default view: 4 queries ~18 s → 1 query ~3 s on staging). An article
 *  has one stage, so a group's buckets are disjoint and sum to its count.
 *  Cached (`cachedRead`, keyed by the SQL itself): aggregates only, the data
 *  changes nightly, and paging re-asks the same counts. */
async function stageCounts<G extends Grouping>(
  ac: ArticleCountParams,
  extra: Prisma.Sql,
  gs: readonly G[],
  byYear = true,
  /** `areaPeople` only: the stages a scholar's papers must be in (`rankScholars`). */
  pick: readonly TranslationalStage[] = TRANSLATIONAL_STAGES,
): Promise<Map<G, Map<string, StageCounts>>> {
  const branches = gs.map((g) => {
    const { key, join } = groupSql(g);
    if (g === "areaPeople")
      return Prisma.sql`SELECT ${g} AS k, t.g, NULL AS st, COUNT(*) AS n FROM (
          SELECT ${key} AS g, x.cwid FROM x ${join}
           WHERE x.st IN (${Prisma.join([...pick])})
           GROUP BY ${key}, x.cwid
          HAVING COUNT(DISTINCT x.pmid) >= ${MIN_SCHOLAR_ACTIVITIES}
        ) t GROUP BY t.g`;
    // Area counts publications: the distinct (pmid, stage) set `u`, not every authorship.
    const from = g === "area" ? Prisma.sql`u x` : Prisma.sql`x`;
    return Prisma.sql`SELECT ${g} AS k, ${key} AS g, x.st, COUNT(DISTINCT x.pmid) AS n FROM ${from} ${join} GROUP BY g, x.st`;
  });
  // publication_topic has a row per (pmid, author, area): dedupe it to `v` once.
  const sql = Prisma.sql`WITH x AS (${scopedSelect(ac, extra, byYear)}),
    u AS (SELECT DISTINCT pmid, st FROM x),
    v AS (SELECT DISTINCT pt.pmid, pt.parent_topic_id AS g FROM u JOIN publication_topic pt ON pt.pmid = u.pmid AND pt.score >= ${TOPIC_ACTIVITY_SCORE_FLOOR})
    ${Prisma.join(branches, " UNION ALL ")}`;
  const raw = await cachedRead(`tp26:${sql.sql}:${JSON.stringify(sql.values)}`, () =>
    db.read.$queryRaw<{ k: string; g: string | number | null; st: string | null; n: bigint | number }[]>(sql),
  );
  const out = new Map<G, Map<string, StageCounts>>(gs.map((g) => [g, new Map()]));
  for (const r of raw) {
    if (r.g === null) continue;
    const m = out.get(r.k as G)!;
    const k = String(r.g);
    const c = m.get(k) ?? emptyCounts();
    c[isTranslationalStage(r.st) ? r.st : "none"] += Number(r.n);
    m.set(k, c);
  }
  return out;
}

/** Current members and their departments, per center. */
async function centerSizes(): Promise<Map<string, { members: number; departments: number }>> {
  const raw = await db.read.$queryRaw<{ g: string; m: bigint | number; d: bigint | number }[]>`
    SELECT cm.center_code AS g, COUNT(DISTINCT cm.cwid) AS m, COUNT(DISTINCT s.dept_code) AS d
      FROM center_membership cm
      JOIN scholar s ON s.cwid = cm.cwid AND s.deleted_at IS NULL AND s.status = 'active'
     WHERE ${currentCenterMembershipSql("cm", utcToday())}
     GROUP BY cm.center_code`;
  return new Map(raw.map((r) => [r.g, { members: Number(r.m), departments: Number(r.d) }]));
}

export type PortfolioScholar = {
  cwid: string;
  name: string;
  title: string | null;
  department: string | null;
  slug: string | null;
};

export type RecentWork = { pmid: string; title: string; year: number; stage: TranslationalStage };

async function loadScholars(cwids: string[]): Promise<Map<string, PortfolioScholar>> {
  if (cwids.length === 0) return new Map();
  const rows = await db.read.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true, primaryTitle: true, primaryDepartment: true, slug: true },
  });
  return new Map(
    rows.map((r) => [
      r.cwid,
      { cwid: r.cwid, name: r.preferredName, title: r.primaryTitle, department: r.primaryDepartment, slug: r.slug },
    ]),
  );
}

/** Each scholar's most recent staged papers in scope (picked stages, else any
 *  T stage), first or senior author, up to `n` each. */
async function recentWorks(
  p: PortfolioParams,
  cwids: string[],
  n: number,
): Promise<Map<string, RecentWork[]>> {
  if (cwids.length === 0) return new Map();
  const ac = { ...articleScope(p, { stages: p.stages.length > 0 ? p.stages : [...TRANSLATIONAL_STAGES] }), pos: "either" as const };
  const raw = await db.read.$queryRaw<{ cwid: string; pmid: string; title: string; y: number; st: string }[]>`
    SELECT x.cwid, x.pmid, pub.title, x.y, x.st
      FROM ${scopedRows(ac, Prisma.sql`${extraSql(p)} AND pa.cwid IN (${Prisma.join(cwids)})`, false)}
      JOIN publication pub ON pub.pmid = x.pmid
     ORDER BY x.y DESC, x.pmid DESC`;
  const out = new Map<string, RecentWork[]>();
  for (const r of raw) {
    const list = out.get(r.cwid) ?? [];
    if (list.length < n && isTranslationalStage(r.st)) {
      list.push({ pmid: r.pmid, title: r.title, year: Number(r.y), stage: r.st });
      out.set(r.cwid, list);
    }
  }
  return out;
}

export type UnitTableRow = TableRow & {
  label: string;
  href: string;
  /** The second line (division count, parent, members, scholars). */
  note: string;
  /** Research areas tab: the note ("169 scholars") links to the Scholars list
   *  filtered to the area; this is that list's query string. */
  noteHref: string | null;
  gaps: TranslationalStage[];
  /** Grant projects and clinical trials with an investigator in this row. */
  grants: number;
  trials: number;
  /** This row's trials by stage (`act=trials`). */
  trialCounts: StageCounts;
};

/** One page of the Grants or Clinical trials list, with its investigators' names. */
export type ActivityListPage<T> = { total: number; rows: (T & { names: Map<string, string> })[] };

export type PortfolioData = {
  /** Every stage bucket in scope (the stage pick does not narrow it). */
  all: StageCounts;
  /** Grant projects and trials active in the window (no stage, so no pick). */
  grants: number;
  trials: number;
  byYear: { year: number; counts: StageCounts; grants: number; trials: number; trialCounts: StageCounts }[];
  /** Trials by stage in scope, and for all of WCM (the baseline; filled on a unit view under
   *  `act=trials` and for the download, else the scope's own). */
  trialStages: { all: StageCounts; baseline: StageCounts };
  /** All of WCM for the same years / area / scholar (the table's baseline). */
  baseline: StageCounts;
  /** The same for grants and trials; only filled for the download (the page shows no baseline counts). */
  baselineActivities: { grants: number; trials: number } | null;
  /** Every row, sorted (the page shows the first `TABLE_PREVIEW_ROWS` until
   *  "View all"; the Download has them all). With `gaps`, only gapped areas. */
  table: UnitTableRow[];
  /** Areas of at least `MIN_AREA_SIZE` staged publications, and those with no gap. */
  areaCoverage: { sized: number; spanning: number };
  /** Research area ids in scope, most publications first (the rail's order). */
  areaOrder: string[];
  scholars: {
    total: number;
    rows: (PortfolioScholar & { n: number; counts: StageCounts; works: RecentWork[]; grants: number; trials: number })[];
  };
  /** The scoped scholar (`cwid`), with their recent staged papers. */
  person: (PortfolioScholar & { works: RecentWork[] }) | null;
  /** The Activities list's page of pmids, newest first, and its total. */
  activities: { total: number; pmids: string[] };
  grantList: ActivityListPage<PortfolioGrant>;
  trialList: ActivityListPage<PortfolioTrial>;
};

export type PortfolioChoices = {
  facets: DataQualityFacets;
  labels: Map<string, string>;
  areas: { id: string; label: string }[];
};

export async function loadPortfolioChoices(): Promise<PortfolioChoices> {
  const [facets, areas] = await Promise.all([
    loadDataQualityFacets(db.read),
    db.read.topic.findMany({ select: { id: true, label: true }, orderBy: { label: "asc" } }),
  ]);
  return { facets, labels: unitLabels(facets), areas };
}

/** Scholars matching the lookup text: exact CWID, or a name containing it.
 *  The rail's type-ahead (`/api/edit/reports/translational-portfolio/scholars`). */
export async function lookupScholars(q: string): Promise<PortfolioScholar[]> {
  if (q.length < 2) return [];
  const rows = await db.read.scholar.findMany({
    where: {
      deletedAt: null,
      status: "active",
      OR: [{ cwid: q.toLowerCase() }, { preferredName: { contains: q } }],
    },
    select: { cwid: true, preferredName: true, primaryTitle: true, primaryDepartment: true, slug: true },
    orderBy: { preferredName: "asc" },
    take: 8,
  });
  return rows.map((r) => ({
    cwid: r.cwid,
    name: r.preferredName,
    title: r.primaryTitle,
    department: r.primaryDepartment,
    slug: r.slug,
  }));
}

/** Everything the page draws, in one parallel batch. `forExport` skips the
 *  page-only parts (lookup, the Activities page, the person card). */
export async function loadPortfolio(
  p: PortfolioParams,
  choices: PortfolioChoices,
  opts: { forExport?: boolean } = {},
): Promise<PortfolioData> {
  const extra = extraSql(p);
  const ac = articleScope(p);
  const acPicked = articleScope(p, { stages: p.stages });
  // The Scholars list is first / senior authorship, whatever the scope.
  const acScholars = { ...articleScope(p), pos: "either" as const };
  const showScholars = !p.cwid && (opts.forExport || p.view === "scholars");

  // One scholar's or one area's papers: their own index beats driving from the year window.
  const byYear = !p.cwid && p.areas.length === 0;
  // The Scholars list's groupings share one query over its first / senior scope.
  const scholarGroups = [...(showScholars ? (["cwid"] as const) : []), ...(p.by === "area" ? (["areaPeople"] as const) : [])];
  const activityScope: ActivityScope = { from: p.from, to: p.to, units: p.units, insts: p.insts, areas: p.areas };
  const wcmScope: ActivityScope = { ...activityScope, units: [], insts: [] };
  const wcmTrialsWanted = p.units.length > 0 && (opts.forExport || p.act === "trials");
  const [counts, baselineMap, centers, scholarCounts, person, grants, trials, wcmGrants, wcmTrials] = await Promise.all([
    stageCounts(ac, extra, ["all", "year", "area", ...(p.by === "area" ? [] : [p.by])], byYear),
    p.units.length > 0
      ? stageCounts(articleScope(p, { units: [] }), extraSql(p, { insts: false }), ["all"], byYear).then((m) => m.get("all")!)
      : Promise.resolve(null),
    p.by === "center" ? centerSizes() : Promise.resolve(new Map<string, { members: number; departments: number }>()),
    scholarGroups.length > 0
      ? stageCounts(acScholars, extra, scholarGroups, byYear, p.stages.length > 0 ? p.stages : TRANSLATIONAL_STAGES)
      : Promise.resolve(new Map<"cwid" | "areaPeople", Map<string, StageCounts>>()),
    p.cwid && !opts.forExport ? loadScholars([p.cwid]) : Promise.resolve(new Map<string, PortfolioScholar>()),
    loadPortfolioGrants(activityScope),
    loadPortfolioTrials(activityScope),
    // All of WCM: the download's baseline row, and the trials' stage-mix baseline on a unit view.
    opts.forExport && p.units.length > 0 ? loadPortfolioGrants(wcmScope) : Promise.resolve(null),
    wcmTrialsWanted ? loadPortfolioTrials(wcmScope) : Promise.resolve(null),
  ]);
  const all = counts.get("all")!;
  const byYearMap = counts.get("year")!;
  const areaMap = counts.get("area")!;
  const tableMap = p.by === "area" ? null : counts.get(p.by)!;
  const byCwid = scholarCounts.get("cwid") ?? new Map<string, StageCounts>();
  // ponytail: with an area filter set, a row's count is within that filter while its link replaces it; rare, left as is.
  const areaPeople = scholarCounts.get("areaPeople") ?? new Map<string, StageCounts>();

  const allCounts = all.get("all") ?? emptyCounts();
  const grantsByYear = tally(grants, (g) => g.years);
  const trialsByYear = stageTally(trials, (t) => t.years);
  const years = [];
  for (let y = p.from; y <= p.to; y++)
    years.push({
      year: y,
      counts: byYearMap.get(String(y)) ?? emptyCounts(),
      grants: grantsByYear.get(String(y)) ?? 0,
      trials: countsTotal(trialsByYear.get(String(y)) ?? emptyCounts()),
      trialCounts: trialsByYear.get(String(y)) ?? emptyCounts(),
    });
  const memberships =
    p.by === "div" || p.by === "center"
      ? await loadUnitMemberships(p.by, [...grants, ...trials].flatMap(peopleOf))
      : new Map<string, string[]>();
  const grantsByUnit = tally(grants, (g) => unitKeys(g, p.by, memberships));
  const trialsByUnit = stageTally(trials, (t) => unitKeys(t, p.by, memberships));
  const grantsByCwid = tally(grants, peopleOf);
  const trialsByCwid = tally(trials, peopleOf);

  // The unit table.
  const { facets, labels } = choices;
  const parentOf = new Map(facets.departments.flatMap((d) => d.divisions.map((v) => [v.value, d.label] as const)));
  const divCount = new Map(facets.departments.map((d) => [d.value, d.divisions.length]));
  const areaLabel = new Map(choices.areas.map((a) => [a.id, a.label]));
  // ponytail: rows are the units with publications in scope; a unit with only grants or trials is left out (rare).
  const source = p.by === "area" ? areaMap : (tableMap ?? new Map());
  const base = new URLSearchParams(portfolioQueryString({ ...p, page: 1 }));
  const table: UnitTableRow[] = [...source].map(([code, counts]) => {
    const href = new URLSearchParams(base);
    let label: string;
    let note = "";
    let noteHref: string | null = null;
    if (p.by === "area") {
      href.delete("area");
      href.append("area", code);
      label = areaLabel.get(code) ?? code;
      const n = countsTotal(areaPeople.get(code) ?? emptyCounts());
      note = `${n.toLocaleString()} scholar${n === 1 ? "" : "s"}`;
      const people = new URLSearchParams(href);
      people.delete("view");
      noteHref = people.toString();
    } else {
      const value = `${p.by}:${code}`;
      href.delete("unit");
      href.append("unit", value);
      label = labels.get(value) ?? code;
      if (p.by === "dept") {
        const n = divCount.get(value) ?? 0;
        note = n > 0 ? `${n} division${n === 1 ? "" : "s"}` : "";
      } else if (p.by === "div") {
        // The facet label is "Division (Department)"; the department goes on the second line.
        note = parentOf.get(value) ?? "";
        if (note) label = label.replace(` (${note})`, "");
      }
      else {
        const c = centers.get(code);
        if (c) note = `${c.members.toLocaleString()} members across ${c.departments} departments`;
      }
    }
    // Gaps are marked in the stage cells, not in the note.
    const gaps = p.by === "area" ? gapStages(counts) : [];
    return {
      key: code,
      counts,
      label,
      href: href.toString(),
      note,
      noteHref,
      gaps,
      grants: grantsByUnit.get(code) ?? 0,
      trials: countsTotal(trialsByUnit.get(code) ?? emptyCounts()),
      trialCounts: trialsByUnit.get(code) ?? emptyCounts(),
    };
  });
  const shownTable = p.by === "area" && p.gaps ? table.filter((r) => r.gaps.length > 0) : table;

  const sized = [...areaMap.values()].filter((c) => stagedTotal(c) >= MIN_AREA_SIZE);
  const areaOrder = [...areaMap]
    .sort((a, b) => countsTotal(b[1]) - countsTotal(a[1]) || a[0].localeCompare(b[0]))
    .map(([id]) => id);

  // The Scholars list (unless one scholar is in scope).
  const ranked = rankScholars(byCwid, p.stages);
  const pageCwids = opts.forExport
    ? ranked.length <= SCHOLAR_EXPORT_CAP
      ? ranked.map((r) => r.cwid)
      : []
    : ranked.slice((p.page - 1) * PORTFOLIO_PAGE_SIZE, p.page * PORTFOLIO_PAGE_SIZE).map((r) => r.cwid);
  const listPage = <T>(items: T[]) =>
    opts.forExport ? [] : items.slice((p.page - 1) * PORTFOLIO_PAGE_SIZE, p.page * PORTFOLIO_PAGE_SIZE);
  const grantPage = p.view === "grants" ? listPage(grants) : [];
  // The Trials list follows the stage pick, as the Publications list does.
  const listedTrials = p.stages.length > 0 ? trials.filter((x) => x.stage !== null && p.stages.includes(x.stage)) : trials;
  const trialPage = p.view === "trials" ? listPage(listedTrials) : [];
  const [people, works, personWorks, activities, listPeople] = await Promise.all([
    loadScholars(pageCwids),
    opts.forExport ? Promise.resolve(new Map<string, RecentWork[]>()) : recentWorks(p, pageCwids, 3),
    p.cwid && !opts.forExport ? recentWorks(p, [p.cwid], 3) : Promise.resolve(new Map<string, RecentWork[]>()),
    opts.forExport || p.view !== "activities" || p.cwid ? Promise.resolve([]) : activityPage(p, acPicked, extra),
    loadScholars([...new Set([...grantPage, ...trialPage].flatMap(peopleOf))]),
  ]);
  const withNames = <T extends { people: { cwid: string }[] }>(rows: T[]) =>
    rows.map((r) => ({ ...r, names: new Map(r.people.map((x) => [x.cwid, listPeople.get(x.cwid)?.name ?? x.cwid])) }));
  const rankedPage = ranked.filter((r) => pageCwids.includes(r.cwid));
  const personRow = p.cwid ? person.get(p.cwid) : undefined;

  return {
    all: allCounts,
    grants: grants.length,
    trials: trials.length,
    byYear: years,
    baseline: baselineMap ? (baselineMap.get("all") ?? emptyCounts()) : allCounts,
    baselineActivities: opts.forExport ? { grants: (wcmGrants ?? grants).length, trials: (wcmTrials ?? trials).length } : null,
    trialStages: { all: stageCountsOfItems(trials), baseline: stageCountsOfItems(wcmTrials ?? trials) },
    table: sortTableRows(shownTable, p.by, p.stages, p.act === "trials" ? (r) => r.trialCounts : undefined),
    areaCoverage: { sized: sized.length, spanning: sized.filter((c) => gapStages(c).length === 0).length },
    areaOrder,
    scholars: {
      total: ranked.length,
      rows: rankedPage.flatMap((r) => {
        const s = people.get(r.cwid);
        return s
          ? [
              {
                ...s,
                n: r.n,
                counts: r.counts,
                works: works.get(r.cwid) ?? [],
                grants: grantsByCwid.get(r.cwid) ?? 0,
                trials: trialsByCwid.get(r.cwid) ?? 0,
              },
            ]
          : [];
      }),
    },
    person: personRow ? { ...personRow, works: personWorks.get(personRow.cwid) ?? [] } : null,
    activities: {
      total: p.stages.length > 0 ? countsIn(allCounts, p.stages) : countsTotal(allCounts),
      pmids: activities,
    },
    grantList: { total: grants.length, rows: withNames(grantPage) },
    trialList: { total: listedTrials.length, rows: withNames(trialPage) },
  };
}

/** One page of the Activities list's pmids, newest first. Walks publications
 *  down the `(year)` index and probes the scope per row (a correlated EXISTS,
 *  NO_SEMIJOIN so it isn't materialized), stopping once the page is full:
 *  ~3 ms instead of ~3 s for grouping the whole scope (staging). */
async function activityPage(p: PortfolioParams, ac: ArticleCountParams, extra: Prisma.Sql): Promise<string[]> {
  const { fromWhere } = scopeSql(ac, extra);
  const raw = await db.read.$queryRaw<{ pmid: string }[]>`
    SELECT q.pmid FROM publication q
     WHERE q.year BETWEEN ${p.from} AND ${p.to}
       AND EXISTS (SELECT /*+ NO_SEMIJOIN() */ 1 ${fromWhere} AND pa.pmid = q.pmid)
     ORDER BY q.year DESC, q.pmid DESC
     LIMIT ${PORTFOLIO_PAGE_SIZE} OFFSET ${(p.page - 1) * PORTFOLIO_PAGE_SIZE}`;
  return raw.map((r) => r.pmid);
}

/** Report 8's params for the Activities rows (`loadArticleList`): the stage
 *  pick plus the area / scholar clauses and the page's pmids. */
export function activityListScope(
  p: PortfolioParams,
  pmids: string[],
): { params: ArticleCountParams; extra: Prisma.Sql } {
  return {
    params: articleScope(p, { stages: p.stages }),
    extra: Prisma.sql`${extraSql(p)} AND p.pmid IN (${Prisma.join(pmids.length > 0 ? pmids : [""])})`,
  };
}

// ---------------------------------------------------------------------------
// Download.
// ---------------------------------------------------------------------------

export const COUNTING_RULE =
  "Research articles only: reviews, editorials, letters, book chapters and errata are left out. Each publication counts once, however many matching authors it has. Only ReCiter-confirmed authorships of active scholars count; department, division (including hand-added division members) and center membership are the scholar's current values, the rule report 8 uses. A research area is a publication's ReciterAI area score of 0.3 or more, as on the research area pages.";


export const GAP_RULE = `A research area has a gap at a stage that holds under ${GAP_SHARE}% of its publications with a stage. Only areas with at least ${MIN_AREA_SIZE} publications with a stage are checked.`;

export const SCHOLAR_RULE = `The Scholars list counts publications where the scholar is first or senior author and lists only scholars with at least ${MIN_SCHOLAR_ACTIVITIES}, ordered by count.`;

export function describePortfolioCriteria(
  p: PortfolioParams,
  choices: PortfolioChoices,
  generatedAt: Date,
): [string, string][] {
  const areas = p.areas.length > 0 ? p.areas.map((id) => choices.areas.find((a) => a.id === id)?.label ?? id).join("; ") : "All";
  return [
    ["Report", "26. Translational portfolio"],
    ["Generated", generatedAt.toISOString()],
    ...personFilterCriteria({ types: [], unitValues: p.units }, choices.labels, (r) => formatRoleCategory(r) ?? ""),
    ["Years", `${p.from}–${p.to} (calendar year of publication)`],
    ["Research area", areas],
    ["Primary institution", p.insts.length > 0 ? p.insts.map(institutionDisplayName).join("; ") : "All"],
    ...(p.gaps && p.by === "area" ? ([["Research areas listed", "Only areas with a gap"]] as [string, string][]) : []),
    ["Gap rule", GAP_RULE],
    ["Translational stage", p.stages.length > 0 ? p.stages.map(translationalStageDisplay).join("; ") : "All"],
    ["Scholar", p.cwid ?? "All (first or senior author when one scholar is chosen)"],
    ["Record type", "Research articles, grants and clinical trials. Grants have no stage yet, so the stage filter does not apply to them."],
    ["Stages shown on the page", p.act === "trials" ? "Clinical trials" : "Publications"],
    ["Counting rule", COUNTING_RULE],
    ["Stage rule", `${STAGE_RULE} How many have a stage is shown separately, as Stage assigned.`],
    ["Scholars rule", SCHOLAR_RULE],
    ["Grant rule", GRANT_RULE],
    ["Trial rule", TRIAL_RULE],
    ["Trial stage rule", TRIAL_STAGE_RULE],
    ...(p.areas.length > 0 ? ([["Grants and trials under an area", ACTIVITY_AREA_RULE]] as [string, string][]) : []),
  ];
}

const bucketHeads = () => STAGE_BUCKETS.map((k) => (k === "none" ? NO_STAGE_LABEL : translationalStageDisplay(k)));
/** Trials by stage, after the trial count: a separate series, never in the publication shares. */
const trialHeads = () => STAGE_BUCKETS.map((k) => `Trials: ${k === "none" ? NO_STAGE_LABEL : k.replace("-", "–")}`);
/** The page's figures beside the counts: Stage assigned, then each stage's
 *  share of the staged publications (whole percents, as the page rounds them). */
const shareHeads = () => ["Stage assigned (%)", ...TRANSLATIONAL_STAGES.map((k) => `${k.replace("-", "–")} share of staged (%)`)];
const shareCells = (c: StageCounts) => {
  const s = stagedShares(c);
  return [Math.round(stageAssignedShare(c)), ...TRANSLATIONAL_STAGES.map((k) => s[k])];
};

export async function buildPortfolioWorkbook(
  p: PortfolioParams,
  choices: PortfolioChoices,
  data: PortfolioData,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const counts = (c: StageCounts) => STAGE_BUCKETS.map((k) => c[k]);

  const years = wb.addWorksheet("By year");
  years.addRow(["Year", "Publications", ...bucketHeads(), ...shareHeads(), "Grants", "Clinical trials", ...trialHeads()]);
  boldRow(years, 1);
  for (const r of data.byYear)
    years.addRow([r.year, countsTotal(r.counts), ...counts(r.counts), ...shareCells(r.counts), r.grants, r.trials, ...counts(r.trialCounts)]);
  // A grant or trial active in several years counts once in the total.
  years.addRow(["Total", countsTotal(data.all), ...counts(data.all), ...shareCells(data.all), data.grants, data.trials, ...counts(data.trialStages.all)]);
  boldRow(years, years.rowCount);

  const table = wb.addWorksheet(UNIT_TABS[p.by].label);
  table.addRow([UNIT_TABS[p.by].head, "Note", "Gaps", "Publications", ...bucketHeads(), ...shareHeads(), "Grants", "Clinical trials", ...trialHeads()]);
  boldRow(table, 1);
  table.addRow([
    "All of Weill Cornell Medicine",
    "Baseline",
    "",
    countsTotal(data.baseline),
    ...counts(data.baseline),
    ...shareCells(data.baseline),
    data.baselineActivities?.grants ?? "",
    data.baselineActivities?.trials ?? "",
    ...counts(data.trialStages.baseline),
  ]);
  for (const r of data.table)
    table.addRow([
      r.label,
      r.note,
      r.gaps.map((s) => s.replace("-", "–")).join(", "),
      countsTotal(r.counts),
      ...counts(r.counts),
      ...shareCells(r.counts),
      r.grants,
      r.trials,
      ...counts(r.trialCounts),
    ]);
  table.getColumn(1).width = 44;
  table.getColumn(2).width = 40;

  const people = wb.addWorksheet("Scholars");
  if (p.cwid) {
    people.addRow(["One scholar is in scope; the Scholars list does not apply."]);
  } else if (data.scholars.total > SCHOLAR_EXPORT_CAP) {
    // Policy: a scholar list over the cap is not exported at all, never cut.
    people.addRow([
      `Omitted: ${data.scholars.total.toLocaleString()} scholars is more than the ${SCHOLAR_EXPORT_CAP} a download may list. Narrow the filters to include them.`,
    ]);
  } else {
    people.addRow(["Name", "CWID", "Title", "Department", "Count", ...TRANSLATIONAL_STAGES.map(translationalStageDisplay), "Grants", "Clinical trials"]);
    boldRow(people, 1);
    for (const r of data.scholars.rows)
      people.addRow([r.name, r.cwid, r.title, r.department, r.n, ...TRANSLATIONAL_STAGES.map((s) => r.counts[s]), r.grants, r.trials]);
  }
  people.getColumn(1).width = 34;

  addCriteriaSheet(wb, describePortfolioCriteria(p, choices, generatedAt));
  return workbookBuffer(wb);
}
