/**
 * Report 26 — "Translational portfolio": where WCM publications sit on the
 * translational spectrum (T0 → T3–4), how that changed over the years, by
 * department / division / center / research area, and who does the work.
 * Step 1 of the build spec (Projects/Scholars-Profile-System/translational-portfolio-spec.md):
 * PUBLICATIONS ONLY. Grants and trials carry no stage yet, so no record-type
 * control, no by-record-type card and no funding-to-publications grid.
 *
 * Scope: report 8's own (`scopeSql`, `lib/edit/article-count-report.ts`) —
 * ReCiter-confirmed authorships of active scholars, the unit rule
 * (`personFilterSql`: department / division incl. a manual division's
 * hand-added members / current center members), calendar year of
 * publication. So a year's stage split here equals report 8's for the same
 * unit and years. On top: a research area (`publication_topic`, the topic
 * pages' 0.3 score floor) and a scholar (that person's first- or
 * senior-author papers).
 *
 * Stage rule: `displayStage` — a T stage, confidence not "low". Everything
 * else is "No stage", computed as the remainder, so every breakdown adds up.
 *
 * People are described, never ranked by share: the Scholars list counts each
 * scholar's first- or senior-author publications (`is_first` / `is_last`, the
 * people ranking's `firstOrLast`), lists only those with at least
 * `MIN_SCHOLAR_ACTIVITIES`, and sorts by count.
 *
 * URL (all optional; a bad value falls back, never a 400): `unit` (the shared
 * who-filter vocabulary, `parsePersonFilter`), `from` / `to`, `area` (topic
 * id), `stage` (repeated), `cwid` (scope to one scholar), `q` (name / CWID
 * lookup), `by` (table tab), `view` (`activities` | `scholars`), `page`.
 *
 * Gate: report 8's audience (`canViewArticleCountReport`), and only while
 * REPORT_TRANSLATIONAL_PORTFOLIO and SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET are
 * both "on". Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
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
  unitLabels,
  utcToday,
} from "@/lib/edit/person-filter";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import { Prisma } from "@/lib/generated/prisma/client";
import { formatRoleCategory } from "@/lib/role-display";
import {
  isTranslationalStage,
  TRANSLATIONAL_STAGES,
  translationalStageDisplay,
  type TranslationalStage,
} from "@/lib/translational-stage";

/** A research area's stage under this share is called out as a gap… */
export const GAP_SHARE = 3;
/** …but only for an area with at least this many publications (noise). */
export const MIN_AREA_SIZE = 50;
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

export type PortfolioView = "activities" | "scholars";

export type PortfolioParams = {
  /** Encoded unit values (`dept:` / `div:` / `center:` + CODE). */
  units: string[];
  from: number;
  to: number;
  area: string | null;
  stages: TranslationalStage[];
  cwid: string | null;
  q: string;
  by: UnitTab;
  view: PortfolioView;
  page: number;
};

/** The first publication year with stages: ReciterAI staged almost nothing
 *  earlier (49 publications across 2016–2019, staging 2026-11-27), so a
 *  window starting before it reads as a shift that is only missing data. */
export const FIRST_STAGED_YEAR = 2020;

/** The default window: `FIRST_STAGED_YEAR` through the last complete year. */
export function defaultYears(now = new Date()): { from: number; to: number } {
  const y = now.getUTCFullYear();
  return { from: FIRST_STAGED_YEAR, to: Math.max(FIRST_STAGED_YEAR, y - 1) };
}

export function parsePortfolioParams(sp: URLSearchParams): PortfolioParams {
  const d = defaultYears();
  const int = (k: string, dflt: number, lo: number, hi: number) => {
    const n = Number.parseInt(sp.get(k) ?? "", 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const from = int("from", d.from, 1900, 2100);
  const to = Math.max(from, int("to", d.to, 1900, 2100));
  const area = sp.get("area")?.trim() ?? "";
  const cwid = sp.get("cwid")?.trim() ?? "";
  const by = sp.get("by");
  return {
    units: parsePersonFilter(sp).unitValues.filter((u) => !u.startsWith("inst:")),
    from,
    to,
    area: /^[A-Za-z0-9_-]{1,128}$/.test(area) ? area : null,
    stages: TRANSLATIONAL_STAGES.filter((s) => sp.getAll("stage").includes(s)),
    cwid: /^[A-Za-z0-9]{2,32}$/.test(cwid) ? cwid : null,
    q: (sp.get("q") ?? "").trim().slice(0, 100),
    by: by && by in UNIT_TABS ? (by as UnitTab) : "dept",
    view: sp.get("view") === "scholars" ? "scholars" : "activities",
    page: int("page", 1, 1, 10_000),
  };
}

/** The canonical query string: every selection, so a view round-trips. */
export function portfolioQueryString(p: PortfolioParams): string {
  const q = new URLSearchParams();
  for (const u of p.units) q.append("unit", u);
  q.set("from", String(p.from));
  q.set("to", String(p.to));
  if (p.area) q.set("area", p.area);
  for (const s of p.stages) q.append("stage", s);
  if (p.cwid) q.set("cwid", p.cwid);
  if (p.q) q.set("q", p.q);
  if (p.by !== "dept") q.set("by", p.by);
  if (p.view !== "activities") q.set("view", p.view);
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

export type StageBucket = TranslationalStage | "none";
export const STAGE_BUCKETS: readonly StageBucket[] = [...TRANSLATIONAL_STAGES, "none"];
export type StageCounts = Record<StageBucket, number>;

export const emptyCounts = (): StageCounts => ({ T0: 0, T1: 0, T2: 0, "T3-4": 0, none: 0 });
export const countsTotal = (c: StageCounts) => STAGE_BUCKETS.reduce((s, k) => s + c[k], 0);
export const countsIn = (c: StageCounts, stages: readonly TranslationalStage[]) =>
  stages.reduce((s, k) => s + c[k], 0);
export const stagedTotal = (c: StageCounts) => countsIn(c, TRANSLATIONAL_STAGES);

/** Exact shares (0–100) per bucket; all zero for an empty set. */
export function exactShares(c: StageCounts): StageCounts {
  const t = countsTotal(c);
  const out = emptyCounts();
  if (t > 0) for (const k of STAGE_BUCKETS) out[k] = (c[k] / t) * 100;
  return out;
}

/** Whole-percent shares that add up to exactly 100 (largest remainder), so
 *  every row, column and chart the page draws sums to 100% with No stage. All
 *  zero for an empty set. */
export function roundedShares(c: StageCounts): StageCounts {
  const ex = exactShares(c);
  const out = emptyCounts();
  if (countsTotal(c) === 0) return out;
  let left = 100;
  for (const k of STAGE_BUCKETS) {
    out[k] = Math.floor(ex[k]);
    left -= out[k];
  }
  const order = [...STAGE_BUCKETS].sort((a, b) => ex[b] - Math.floor(ex[b]) - (ex[a] - Math.floor(ex[a])));
  for (let i = 0; i < left; i++) out[order[i]] += 1;
  return out;
}

/** The T stages an area is thin at: exact share under `GAP_SHARE`, for an
 *  area of at least `MIN_AREA_SIZE` publications (else none). */
export function gapStages(c: StageCounts): TranslationalStage[] {
  if (countsTotal(c) < MIN_AREA_SIZE) return [];
  const ex = exactShares(c);
  return TRANSLATIONAL_STAGES.filter((s) => ex[s] < GAP_SHARE);
}

export type TableRow = { key: string; counts: StageCounts };

/** The unit table's order: with stages picked, by share in the pick; on
 *  Research areas with nothing picked, the sized areas by thinnest stage
 *  first, then the small ones by volume; else by volume. */
export function sortTableRows<T extends TableRow>(rows: T[], tab: UnitTab, stages: readonly TranslationalStage[]): T[] {
  const vol = (a: T, b: T) => countsTotal(b.counts) - countsTotal(a.counts) || a.key.localeCompare(b.key);
  if (stages.length > 0) {
    const share = (r: T) => countsIn(exactShares(r.counts), stages);
    return [...rows].sort((a, b) => share(b) - share(a) || vol(a, b));
  }
  if (tab === "area") {
    const sized = (r: T) => countsTotal(r.counts) >= MIN_AREA_SIZE;
    const thin = (r: T) => Math.min(...TRANSLATIONAL_STAGES.map((s) => exactShares(r.counts)[s]));
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
    atypes: [],
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

/** The area and scholar clauses on top of report 8's scope. */
function extraSql(p: PortfolioParams): Prisma.Sql {
  return Prisma.sql`${
    p.area
      ? Prisma.sql`AND p.pmid IN (SELECT pt_a.pmid FROM publication_topic pt_a WHERE pt_a.parent_topic_id = ${p.area} AND pt_a.score >= ${TOPIC_ACTIVITY_SCORE_FLOOR})`
      : Prisma.empty
  } ${p.cwid ? Prisma.sql`AND pa.cwid = ${p.cwid}` : Prisma.empty}`;
}

/** The scoped (publication, author, year, department, stage) rows as a derived
 *  table `x` — the one set every count below groups. */
function scopedRows(ac: ArticleCountParams, extra: Prisma.Sql): Prisma.Sql {
  const { fromWhere } = scopeSql(ac, extra);
  return Prisma.sql`(SELECT DISTINCT pa.pmid, pa.cwid, p.year AS y, s.dept_code AS dc, ${stageCase()} AS st ${fromWhere}) x`;
}

type Grouping = "all" | "year" | "cwid" | UnitTab;

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
    case "area":
      return {
        key: Prisma.sql`pt.parent_topic_id`,
        join: Prisma.sql`JOIN publication_topic pt ON pt.pmid = x.pmid AND pt.score >= ${TOPIC_ACTIVITY_SCORE_FLOOR}`,
      };
  }
}

/** Distinct publications per group, split by displayed stage. An article has
 *  one stage, so a group's buckets are disjoint and sum to its count. */
async function stageCountsBy(ac: ArticleCountParams, extra: Prisma.Sql, g: Grouping): Promise<Map<string, StageCounts>> {
  const { key, join } = groupSql(g);
  const raw = await db.read.$queryRaw<{ g: string | number | null; st: string | null; n: bigint | number }[]>`
    SELECT ${key} AS g, x.st, COUNT(DISTINCT x.pmid) AS n
      FROM ${scopedRows(ac, extra)}
      ${join}
     GROUP BY g, x.st`;
  const out = new Map<string, StageCounts>();
  for (const r of raw) {
    if (r.g === null) continue;
    const k = String(r.g);
    const c = out.get(k) ?? emptyCounts();
    c[isTranslationalStage(r.st) ? r.st : "none"] += Number(r.n);
    out.set(k, c);
  }
  return out;
}

/** Distinct scholars per research area (the table's second line). */
async function scholarsByArea(ac: ArticleCountParams, extra: Prisma.Sql): Promise<Map<string, number>> {
  const { key, join } = groupSql("area");
  const raw = await db.read.$queryRaw<{ g: string; n: bigint | number }[]>`
    SELECT ${key} AS g, COUNT(DISTINCT x.cwid) AS n FROM ${scopedRows(ac, extra)} ${join} GROUP BY g`;
  return new Map(raw.map((r) => [r.g, Number(r.n)]));
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
      FROM ${scopedRows(ac, Prisma.sql`${extraSql(p)} AND pa.cwid IN (${Prisma.join(cwids)})`)}
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
  gaps: TranslationalStage[];
};

export type PortfolioData = {
  /** Every stage bucket in scope (the stage pick does not narrow it). */
  all: StageCounts;
  byYear: { year: number; counts: StageCounts }[];
  /** All of WCM for the same years / area / scholar (the table's baseline). */
  baseline: StageCounts;
  table: UnitTableRow[];
  /** Areas of at least `MIN_AREA_SIZE` publications, and those with no gap. */
  areaCoverage: { sized: number; spanning: number };
  scholars: { total: number; rows: (PortfolioScholar & { n: number; counts: StageCounts; works: RecentWork[] })[] };
  /** The scoped scholar (`cwid`), with their recent staged papers. */
  person: (PortfolioScholar & { works: RecentWork[] }) | null;
  /** The lookup's matches (`q`), up to 8. */
  lookup: PortfolioScholar[];
  /** The Activities list's page of pmids, newest first, and its total. */
  activities: { total: number; pmids: string[] };
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

/** Scholars matching the lookup text: exact CWID, or a name containing it. */
async function lookupScholars(q: string): Promise<PortfolioScholar[]> {
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

  const [all, byYearMap, baselineMap, tableMap, areaMap, areaPeople, centers, byCwid, lookup, person] =
    await Promise.all([
      stageCountsBy(ac, extra, "all"),
      stageCountsBy(ac, extra, "year"),
      p.units.length > 0 ? stageCountsBy(articleScope(p, { units: [] }), extra, "all") : Promise.resolve(null),
      p.by === "area" ? Promise.resolve(null) : stageCountsBy(ac, extra, p.by),
      stageCountsBy(ac, extra, "area"),
      p.by === "area" ? scholarsByArea(ac, extra) : Promise.resolve(new Map<string, number>()),
      p.by === "center" ? centerSizes() : Promise.resolve(new Map<string, { members: number; departments: number }>()),
      showScholars ? stageCountsBy(acScholars, extra, "cwid") : Promise.resolve(new Map<string, StageCounts>()),
      opts.forExport ? Promise.resolve([]) : lookupScholars(p.q),
      p.cwid && !opts.forExport ? loadScholars([p.cwid]) : Promise.resolve(new Map<string, PortfolioScholar>()),
    ]);

  const allCounts = all.get("all") ?? emptyCounts();
  const byYear = [];
  for (let y = p.from; y <= p.to; y++) byYear.push({ year: y, counts: byYearMap.get(String(y)) ?? emptyCounts() });

  // The unit table.
  const { facets, labels } = choices;
  const parentOf = new Map(facets.departments.flatMap((d) => d.divisions.map((v) => [v.value, d.label] as const)));
  const divCount = new Map(facets.departments.map((d) => [d.value, d.divisions.length]));
  const areaLabel = new Map(choices.areas.map((a) => [a.id, a.label]));
  const source = p.by === "area" ? areaMap : (tableMap ?? new Map());
  const base = new URLSearchParams(portfolioQueryString({ ...p, page: 1 }));
  const table: UnitTableRow[] = [...source].map(([code, counts]) => {
    const href = new URLSearchParams(base);
    let label: string;
    let note = "";
    if (p.by === "area") {
      href.set("area", code);
      label = areaLabel.get(code) ?? code;
      const n = areaPeople.get(code) ?? 0;
      note = `${n.toLocaleString()} scholar${n === 1 ? "" : "s"}`;
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
    const gaps = p.by === "area" ? gapStages(counts) : [];
    if (gaps.length > 0) note = `Gap at ${stagesLabel(gaps).replace(/ \+ /g, " and ")}${note ? ` · ${note}` : ""}`;
    return { key: code, counts, label, href: href.toString(), note, gaps };
  });

  const sized = [...areaMap.values()].filter((c) => countsTotal(c) >= MIN_AREA_SIZE);

  // The Scholars list (unless one scholar is in scope).
  const ranked = rankScholars(byCwid, p.stages);
  const pageCwids = opts.forExport
    ? ranked.length <= SCHOLAR_EXPORT_CAP
      ? ranked.map((r) => r.cwid)
      : []
    : ranked.slice((p.page - 1) * PORTFOLIO_PAGE_SIZE, p.page * PORTFOLIO_PAGE_SIZE).map((r) => r.cwid);
  const [people, works, personWorks, activities] = await Promise.all([
    loadScholars(pageCwids),
    opts.forExport ? Promise.resolve(new Map<string, RecentWork[]>()) : recentWorks(p, pageCwids, 2),
    p.cwid && !opts.forExport ? recentWorks(p, [p.cwid], 3) : Promise.resolve(new Map<string, RecentWork[]>()),
    opts.forExport || p.view !== "activities" ? Promise.resolve([]) : activityPage(p, acPicked, extra),
  ]);
  const rankedPage = ranked.filter((r) => pageCwids.includes(r.cwid));
  const personRow = p.cwid ? person.get(p.cwid) : undefined;

  return {
    all: allCounts,
    byYear,
    baseline: baselineMap ? (baselineMap.get("all") ?? emptyCounts()) : allCounts,
    table: sortTableRows(table, p.by, p.stages),
    areaCoverage: { sized: sized.length, spanning: sized.filter((c) => gapStages(c).length === 0).length },
    scholars: {
      total: ranked.length,
      rows: rankedPage.flatMap((r) => {
        const s = people.get(r.cwid);
        return s ? [{ ...s, n: r.n, counts: r.counts, works: works.get(r.cwid) ?? [] }] : [];
      }),
    },
    person: personRow ? { ...personRow, works: personWorks.get(personRow.cwid) ?? [] } : null,
    lookup,
    activities: {
      total: p.stages.length > 0 ? countsIn(allCounts, p.stages) : countsTotal(allCounts),
      pmids: activities,
    },
  };
}

/** One page of the Activities list's pmids, newest first. */
async function activityPage(p: PortfolioParams, ac: ArticleCountParams, extra: Prisma.Sql): Promise<string[]> {
  const raw = await db.read.$queryRaw<{ pmid: string }[]>`
    SELECT x.pmid, MAX(x.y) AS y FROM ${scopedRows(ac, extra)}
     GROUP BY x.pmid
     ORDER BY y DESC, x.pmid DESC
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
  "Each publication counts once, however many matching authors it has. Only ReCiter-confirmed authorships of active scholars count; department, division (including hand-added division members) and center membership are the scholar's current values, the rule report 8 uses. A research area is a publication's ReciterAI area score of 0.3 or more, as on the research area pages.";

export const STAGE_RULE =
  "ReCiterAI assigns a translational stage from the abstract or summary. A stage counts only when the model was not unsure; low-confidence records and those outside the spectrum are under No stage, so every row adds up to 100%.";

export const SCHOLAR_RULE = `The Scholars list counts publications where the scholar is first or senior author and lists only scholars with at least ${MIN_SCHOLAR_ACTIVITIES}, ordered by count.`;

export function describePortfolioCriteria(
  p: PortfolioParams,
  choices: PortfolioChoices,
  generatedAt: Date,
): [string, string][] {
  const area = p.area ? (choices.areas.find((a) => a.id === p.area)?.label ?? p.area) : "All";
  return [
    ["Report", "26. Translational portfolio"],
    ["Generated", generatedAt.toISOString()],
    ...personFilterCriteria({ types: [], unitValues: p.units }, choices.labels, (r) => formatRoleCategory(r) ?? ""),
    ["Years", `${p.from}–${p.to} (calendar year of publication)`],
    ["Research area", area],
    ["Translational stage", p.stages.length > 0 ? p.stages.map(translationalStageDisplay).join("; ") : "All"],
    ["Scholar", p.cwid ?? "All (first or senior author when one scholar is chosen)"],
    ["Record type", "Publications"],
    ["Counting rule", COUNTING_RULE],
    ["Stage rule", STAGE_RULE],
    ["Scholars rule", SCHOLAR_RULE],
  ];
}

const bucketHeads = () => STAGE_BUCKETS.map((k) => (k === "none" ? NO_STAGE_LABEL : translationalStageDisplay(k)));

export async function buildPortfolioWorkbook(
  p: PortfolioParams,
  choices: PortfolioChoices,
  data: PortfolioData,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const counts = (c: StageCounts) => STAGE_BUCKETS.map((k) => c[k]);

  const years = wb.addWorksheet("By year");
  years.addRow(["Year", "Publications", ...bucketHeads()]);
  boldRow(years, 1);
  for (const r of data.byYear) years.addRow([r.year, countsTotal(r.counts), ...counts(r.counts)]);
  years.addRow(["Total", countsTotal(data.all), ...counts(data.all)]);
  boldRow(years, years.rowCount);

  const table = wb.addWorksheet(UNIT_TABS[p.by].label);
  table.addRow([UNIT_TABS[p.by].head, "Note", "Publications", ...bucketHeads()]);
  boldRow(table, 1);
  table.addRow(["All of Weill Cornell Medicine", "Baseline", countsTotal(data.baseline), ...counts(data.baseline)]);
  for (const r of data.table) table.addRow([r.label, r.note, countsTotal(r.counts), ...counts(r.counts)]);
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
    people.addRow(["Name", "CWID", "Title", "Department", "Count", ...TRANSLATIONAL_STAGES.map(translationalStageDisplay)]);
    boldRow(people, 1);
    for (const r of data.scholars.rows)
      people.addRow([r.name, r.cwid, r.title, r.department, r.n, ...TRANSLATIONAL_STAGES.map((s) => r.counts[s])]);
  }
  people.getColumn(1).width = 34;

  addCriteriaSheet(wb, describePortfolioCriteria(p, choices, generatedAt));
  return workbookBuffer(wb);
}
