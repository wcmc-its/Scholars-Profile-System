/**
 * Report 26 for ONE scholar: the dedicated page
 * `/edit/scholar/[cwid]/translational-portfolio` and its `.xlsx`
 * (`GET /api/edit/reports/translational-portfolio-scholar`). Plan
 * 2026-11-27-translational-portfolio-redesign-plan.md, PR 2; canvas "Person".
 *
 * Access (`resolveScholarPortfolioAccess`): report 26 is on
 * (`isTranslationalPortfolioReportEnabled`) AND `authorizeCvExport` allows the
 * viewer this scholar (self, superuser, granted proxy, owner or curator of one
 * of the scholar's units, the read-only observer). Then the editor's existence
 * and #536 hidden-class guards, and an active scholar (report 8's scope counts
 * no one else, so a suppressed or external scholar would read as no papers). Anyone else, and any unknown CWID, gets the
 * same 404, so the page never says whether a CWID exists.
 *
 * Scope: report 8's (`scopeSql`) for this scholar: their ReCiter-confirmed
 * authorships, calendar year of publication, an optional research area (the
 * report's rule: a ReciterAI area score of `TOPIC_ACTIVITY_SCORE_FLOOR` or
 * more). Authorship: first- or senior-author papers by default (`is_first OR
 * is_last`); `authorship=all` adds the middle-author ones. The role always
 * comes from `is_first` / `is_last`, never from `position` (0 there means
 * "rank unknown").
 *
 * Grants and clinical trials: the report's rules
 * (`lib/edit/translational-portfolio-activities.ts`) for this scholar, under
 * the page's years and research areas, listed. Trials carry their trial phase's
 * stage; grants have none yet.
 *
 * Counts only: one person's few dozen papers make a percentage swing on one
 * misassigned stage, and the page compares this scholar with nobody.
 *
 * URL: `from` / `to`, `area` (repeated), `authorship=all`, `stage` (one of the
 * T stages or `none`, the list's filter), `page`. `unit` and `inst` ride along
 * untouched for the link back to the report. Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { TOPIC_ACTIVITY_SCORE_FLOOR } from "@/lib/api/topic-activity";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  NO_STAGE_LABEL,
  scopeSql,
  STAGE_NOT_LOW,
  type ArticleCountParams,
} from "@/lib/edit/article-count-report";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeCvExport } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import {
  ACTIVITY_AREA_RULE,
  GRANT_RULE,
  loadPortfolioGrants,
  loadPortfolioTrials,
  TRIAL_RULE,
  type PortfolioGrant,
  type PortfolioTrial,
} from "@/lib/edit/translational-portfolio-activities";
import { resolveEditIdentity } from "@/lib/edit/request";
import {
  COUNTING_RULE,
  isTranslationalPortfolioReportEnabled,
  parsePortfolioParams,
  PORTFOLIO_PAGE_SIZE,
  portfolioQueryString,
  type PortfolioParams,
} from "@/lib/edit/translational-portfolio-report";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { Prisma } from "@/lib/generated/prisma/client";
import { formatPublishedName } from "@/lib/postnominal";
import {
  emptyCounts,
  isTranslationalStage,
  STAGE_RULE,
  TRIAL_STAGE_RULE,
  TRANSLATIONAL_STAGES,
  translationalStageDisplay,
  type StageCounts,
  type TranslationalStage,
} from "@/lib/translational-stage";

/** A research area is listed (rail and section) from this many papers in scope. */
export const MIN_SCHOLAR_AREA_PAPERS = 3;
/** Above this many papers in the busiest year, the year chart draws stacked
 *  bars instead of one square per paper (the canvas comment thread's rule). */
export const WAFFLE_MAX_PER_YEAR = 60;

export const AUTHORSHIP_RULE_DEFAULT = "First- or senior-author publications only.";
export const AUTHORSHIP_RULE_ALL = "Every confirmed authorship: first, senior and middle author.";

const CWID_RE = /^[A-Za-z0-9]{2,32}$/;
export type ListStage = TranslationalStage | "none";

/** The page's own scope: years and research areas. A report link seeds them
 *  from the report's; after that they are the page's alone. */
export type ScholarScope = { from: number; to: number; areas: string[] };

export type ScholarPortfolioParams = ScholarScope & {
  /** `authorship=all`: middle-author papers too. */
  middle: boolean;
  /** The paper list's stage filter; null = every paper. */
  stage: ListStage | null;
  page: number;
  /** The report's own query string (`r`), canonical, for the link back. Kept
   *  apart from the page's scope so a filter picked here never leaks into the
   *  report, or on to the next scholar opened from it. */
  back: string;
};

/** The report filters a link from before `r` carried beside the page's own. */
const REPORT_KEYS = ["unit", "inst", "from", "to", "area"] as const;
const pick = (sp: URLSearchParams, keys: readonly string[]) =>
  new URLSearchParams([...sp].filter(([k]) => keys.includes(k)));

/** The report's state as a canonical query string: parsed and re-serialized,
 *  so `r` can only ever hold report filters. Never one scholar. */
function reportBack(rp: PortfolioParams): string {
  return portfolioQueryString({ ...rp, cwid: null });
}

export function parseScholarPortfolioParams(sp: URLSearchParams): ScholarPortfolioParams {
  const st = sp.get("stage");
  const page = Number.parseInt(sp.get("page") ?? "", 10);
  // The page's scope reads `from` / `to` / `area` with the report's parser.
  const own = parsePortfolioParams(sp);
  const r = sp.get("r");
  return {
    from: own.from,
    to: own.to,
    areas: own.areas,
    middle: sp.get("authorship") === "all",
    stage: st === "none" ? "none" : isTranslationalStage(st) ? st : null,
    page: Number.isFinite(page) ? Math.min(10_000, Math.max(1, page)) : 1,
    // No `r` (a link from before it): the report under the report filters this
    // URL carries, never the page's own list filters (`stage`, `page`).
    back: reportBack(parsePortfolioParams(r !== null ? new URLSearchParams(r) : pick(sp, REPORT_KEYS))),
  };
}

/** The report's params the link back opens (its unit names the link). */
export function backParams(p: ScholarPortfolioParams): PortfolioParams {
  return parsePortfolioParams(new URLSearchParams(p.back));
}

export function scholarPortfolioQueryString(p: ScholarPortfolioParams): string {
  const q = new URLSearchParams();
  q.set("from", String(p.from));
  q.set("to", String(p.to));
  for (const a of p.areas) q.append("area", a);
  if (p.middle) q.set("authorship", "all");
  if (p.stage) q.set("stage", p.stage);
  if (p.page > 1) q.set("page", String(p.page));
  q.set("r", p.back);
  return q.toString();
}

export const scholarPortfolioPath = (cwid: string) =>
  `/edit/scholar/${encodeURIComponent(cwid)}/translational-portfolio`;

/** A scholar's page opened from the report: its scope seeded from the
 *  report's years and areas, and the report's whole state kept for the way back. */
export function scholarPortfolioHref(cwid: string, report: PortfolioParams): string {
  return `${scholarPortfolioPath(cwid)}?${scholarPortfolioQueryString({
    from: report.from,
    to: report.to,
    areas: report.areas,
    middle: false,
    stage: null,
    page: 1,
    back: reportBack(report),
  })}`;
}

/** The report as it was when this scholar's page was opened. */
export function reportHrefFor(reportBase: string, p: ScholarPortfolioParams): string {
  return `${reportBase}?${p.back}`;
}

/** Report 26 with `?cwid=` (an old link, or the Bibliometrics tab's before
 *  this page): the scholar's page under the same filters, else null. */
export function portfolioCwidRedirect(sp: URLSearchParams): string | null {
  const p = parsePortfolioParams(sp);
  return p.cwid ? scholarPortfolioHref(p.cwid, p) : null;
}

// ---------------------------------------------------------------------------
// Access.
// ---------------------------------------------------------------------------

export type PortfolioScholarHead = {
  cwid: string;
  /** As the public profile's h1 renders it (`formatPublishedName`). */
  name: string;
  /** For the headshot's initials. */
  preferredName: string;
  title: string | null;
  department: string | null;
  slug: string | null;
};

export type ScholarPortfolioAccess =
  | { kind: "login" }
  | { kind: "denied" }
  | { kind: "ok"; session: EditSession; scholar: PortfolioScholarHead };

/** Who may open one scholar's portfolio (module comment). `path` is only for
 *  the denial log line. */
export async function resolveScholarPortfolioAccess(
  cwid: string,
  path: string,
): Promise<ScholarPortfolioAccess> {
  if (!isTranslationalPortfolioReportEnabled() || !CWID_RE.test(cwid)) return { kind: "denied" };
  const id = await resolveEditIdentity();
  if (!id) return { kind: "login" };
  const { session, realCwid, impersonatedCwid } = id;
  const authz = await authorizeCvExport({
    session,
    realCwid,
    impersonatedCwid,
    entityId: cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: cwid, path, reason: authz.reason });
    return { kind: "denied" };
  }
  const s = await db.read.scholar.findUnique({
    where: { cwid },
    select: {
      preferredName: true,
      postnominal: true,
      roleCategory: true,
      deletedAt: true,
      status: true,
      primaryTitle: true,
      primaryDepartment: true,
      slug: true,
    },
  });
  // Report 8's scope counts active scholars only (`s.status = 'active'`): a
  // suppressed or external scholar's page would read as "no papers", so it is
  // the same 404.
  if (!s || s.deletedAt !== null || s.status !== "active") return { kind: "denied" };
  if (!session.isSuperuser && !isPubliclyDisplayed(s.roleCategory)) return { kind: "denied" };
  return {
    kind: "ok",
    session,
    scholar: {
      cwid,
      name: formatPublishedName(s.preferredName, s.postnominal, s.roleCategory),
      preferredName: s.preferredName,
      title: s.primaryTitle,
      department: s.primaryDepartment,
      slug: s.slug,
    },
  };
}

// ---------------------------------------------------------------------------
// Data.
// ---------------------------------------------------------------------------

export type AuthorRole = "First" | "Senior" | "Middle";

export type ScholarPaper = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  role: AuthorRole;
  stage: TranslationalStage | null;
  /** Research area ids at or over the score floor. */
  areas: string[];
};

export type ScholarArea = {
  id: string;
  label: string;
  description: string | null;
  n: number;
  counts: StageCounts;
};

export type ScholarPortfolio = {
  /** Every paper in scope (years, areas, authorship), newest first. */
  papers: ScholarPaper[];
  /** The rail's areas: over the scope without the area filter, at least
   *  `MIN_SCHOLAR_AREA_PAPERS` papers, plus any area the URL checks. */
  areaChoices: { id: string; label: string; n: number }[];
  /** The section's areas: over the scope, at least `MIN_SCHOLAR_AREA_PAPERS`;
   *  with an area filter, only the checked areas, so each count is exactly
   *  the list its link opens (the filter is OR: a checked area's papers are
   *  all in scope, while another area's count would be an overlap no link
   *  can open). */
  areas: ScholarArea[];
  /** This scholar's grant projects and trials in the page's years and areas, newest first. */
  grants: PortfolioGrant[];
  trials: PortfolioTrial[];
};

/** This scholar's roles on a grant or trial, strongest first, each once. */
export function rolesOf(item: { people: { cwid: string; role: string }[] }, cwid: string): string[] {
  return [...new Set(item.people.filter((x) => x.cwid === cwid).map((x) => x.role))];
}

/** Report 8's params for this scholar: no unit (a scholar's papers are
 *  theirs, whatever unit the report was on), and the authorship rule. */
export function scholarScope(
  p: Pick<ScholarPortfolioParams, "from" | "to" | "middle">,
): ArticleCountParams {
  return {
    types: [],
    units: [],
    atypes: [],
    stages: [],
    jif: 0,
    pos: p.middle ? "any" : "either",
    basis: "cy",
    from: p.from,
    to: p.to,
    added: null,
    list: null,
    listData: null,
  };
}

/** The SQL form of `displayStage`, as report 26 counts it. */
const stageCase = () =>
  Prisma.sql`CASE WHEN p.translational_stage IN (${Prisma.join([...TRANSLATIONAL_STAGES])}) AND ${STAGE_NOT_LOW} THEN p.translational_stage END`;

/** One row per paper: the role is the strongest of the scholar's authorship
 *  flags on it (first, then senior, else middle). */
export function scholarPapersSql(
  cwid: string,
  p: Pick<ScholarPortfolioParams, "from" | "to" | "middle">,
): Prisma.Sql {
  const { fromWhere } = scopeSql(scholarScope(p), Prisma.sql`AND pa.cwid = ${cwid}`);
  return Prisma.sql`SELECT p.pmid, p.title, p.journal, p.year AS y,
           MAX(pa.is_first) AS f, MAX(pa.is_last) AS l, ${stageCase()} AS st
      ${fromWhere}
     GROUP BY p.pmid
     ORDER BY y DESC, p.pmid DESC`;
}

const flag = (v: unknown) => v === true || Number(v) === 1;

export async function loadScholarPortfolio(
  cwid: string,
  p: ScholarPortfolioParams,
): Promise<ScholarPortfolio> {
  const activityScope = { from: p.from, to: p.to, units: [], insts: [], areas: p.areas, cwid };
  const [raw, grants, trials] = await Promise.all([
    db.read.$queryRaw<
    {
      pmid: string;
      title: string;
      journal: string | null;
      y: number;
      f: unknown;
      l: unknown;
      st: string | null;
    }[]
  >(scholarPapersSql(cwid, p)),
    loadPortfolioGrants(activityScope),
    loadPortfolioTrials(activityScope),
  ]);
  const pmids = raw.map((r) => r.pmid);
  // publication_topic has a row per (pmid, author, area): the report's rule is
  // any row of the paper at or over the floor, so dedupe to (pmid, area).
  const topicRows =
    pmids.length > 0
      ? await db.read.$queryRaw<{ pmid: string; g: string }[]>`
          SELECT DISTINCT pt.pmid, pt.parent_topic_id AS g FROM publication_topic pt
           WHERE pt.pmid IN (${Prisma.join(pmids)}) AND pt.score >= ${TOPIC_ACTIVITY_SCORE_FLOOR}`
      : [];
  const areasOf = new Map<string, string[]>();
  for (const r of topicRows) areasOf.set(r.pmid, [...(areasOf.get(r.pmid) ?? []), r.g]);

  const all: ScholarPaper[] = raw.map((r) => ({
    pmid: r.pmid,
    title: r.title,
    journal: r.journal,
    year: Number(r.y),
    role: flag(r.f) ? "First" : flag(r.l) ? "Senior" : "Middle",
    stage: isTranslationalStage(r.st) ? r.st : null,
    areas: areasOf.get(r.pmid) ?? [],
  }));
  const picked = new Set(p.areas);
  const papers = picked.size === 0 ? all : all.filter((x) => x.areas.some((a) => picked.has(a)));

  const tally = (list: ScholarPaper[]) => {
    const m = new Map<string, ScholarPaper[]>();
    for (const x of list) for (const a of x.areas) m.set(a, [...(m.get(a) ?? []), x]);
    return m;
  };
  const choiceTally = tally(all);
  const areaTally = tally(papers);
  const ids = [...new Set([...choiceTally.keys(), ...p.areas])];
  const topics =
    ids.length > 0
      ? await db.read.topic.findMany({
          where: { id: { in: ids } },
          select: { id: true, label: true, description: true },
        })
      : [];
  const topic = new Map(topics.map((t) => [t.id, t]));
  const byCount = <T extends { n: number; label: string }>(a: T, b: T) =>
    b.n - a.n || a.label.localeCompare(b.label);

  return {
    papers,
    areaChoices: ids
      .map((id) => ({ id, label: topic.get(id)?.label ?? id, n: choiceTally.get(id)?.length ?? 0 }))
      .filter((a) => a.n >= MIN_SCHOLAR_AREA_PAPERS || picked.has(a.id))
      .sort(byCount),
    areas: [...areaTally]
      .filter(([id, list]) => list.length >= MIN_SCHOLAR_AREA_PAPERS && (picked.size === 0 || picked.has(id)))
      .map(([id, list]) => ({
        id,
        label: topic.get(id)?.label ?? id,
        description: topic.get(id)?.description ?? null,
        n: list.length,
        counts: stageCountsOf(list),
      }))
      .sort(byCount),
    grants,
    trials,
  };
}

// ---------------------------------------------------------------------------
// Counts (pure).
// ---------------------------------------------------------------------------

export function stageCountsOf(papers: readonly ScholarPaper[]): StageCounts {
  const c = emptyCounts();
  for (const x of papers) c[x.stage ?? "none"] += 1;
  return c;
}

/** Every year of the window, zeros included. */
export function papersByYear(
  papers: readonly ScholarPaper[],
  from: number,
  to: number,
): { year: number; counts: StageCounts }[] {
  const out = [];
  for (let y = from; y <= to; y++)
    out.push({ year: y, counts: stageCountsOf(papers.filter((x) => x.year === y)) });
  return out;
}

/** Squares while the busiest year fits; stacked bars past `WAFFLE_MAX_PER_YEAR`. */
export function yearChartKind(byYear: readonly { counts: StageCounts }[]): "squares" | "bars" {
  const max = Math.max(0, ...byYear.map((r) => Object.values(r.counts).reduce((s, n) => s + n, 0)));
  return max > WAFFLE_MAX_PER_YEAR ? "bars" : "squares";
}

export function filterByStage(
  papers: readonly ScholarPaper[],
  stage: ListStage | null,
): ScholarPaper[] {
  return stage === null ? [...papers] : papers.filter((x) => (x.stage ?? "none") === stage);
}

/** "Runs T0 to T3–4", "T2 only", "No papers with a stage". */
export function stageSpan(c: StageCounts): string {
  const present = TRANSLATIONAL_STAGES.filter((k) => c[k] > 0).map((k) => k.replace("-", "–"));
  if (present.length === 0) return "No papers with a stage";
  return present.length === 1
    ? `${present[0]} only`
    : `Runs ${present[0]} to ${present[present.length - 1]}`;
}

export const SCHOLAR_PAGE_SIZE = PORTFOLIO_PAGE_SIZE;

// ---------------------------------------------------------------------------
// Download.
// ---------------------------------------------------------------------------

export function describeScholarPortfolioCriteria(
  p: ScholarPortfolioParams,
  scholar: PortfolioScholarHead,
  areaLabel: ReadonlyMap<string, string>,
  generatedAt: Date,
): [string, string][] {
  return [
    ["Report", "26. Translational portfolio, one scholar"],
    ["Generated", generatedAt.toISOString()],
    ["Scholar", `${scholar.name} (${scholar.cwid})`],
    ["Years", `${p.from}–${p.to} (calendar year of publication)`],
    [
      "Research area",
      p.areas.length > 0 ? p.areas.map((a) => areaLabel.get(a) ?? a).join("; ") : "All",
    ],
    ["Authorship", p.middle ? AUTHORSHIP_RULE_ALL : AUTHORSHIP_RULE_DEFAULT],
    [
      "Translational stage",
      p.stage === null
        ? "All"
        : p.stage === "none"
          ? `${NO_STAGE_LABEL} only`
          : translationalStageDisplay(p.stage),
    ],
    ["Counting rule", COUNTING_RULE],
    ["Stage rule", STAGE_RULE],
    ["Grant rule", GRANT_RULE],
    ["Trial rule", TRIAL_RULE],
    ["Trial stage rule", TRIAL_STAGE_RULE],
    ...(p.areas.length > 0 ? ([["Grants and trials under an area", ACTIVITY_AREA_RULE]] as [string, string][]) : []),
  ];
}

export async function buildScholarPortfolioWorkbook(
  p: ScholarPortfolioParams,
  scholar: PortfolioScholarHead,
  data: ScholarPortfolio,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Publications");
  ws.addRow(["PMID", "Title", "Journal", "Year", "Author role", "Translational stage"]);
  boldRow(ws, 1);
  for (const x of filterByStage(data.papers, p.stage))
    ws.addRow([
      x.pmid,
      x.title,
      x.journal ?? "",
      x.year,
      x.role,
      x.stage ? translationalStageDisplay(x.stage) : NO_STAGE_LABEL,
    ]);
  ws.getColumn(2).width = 80;
  ws.getColumn(3).width = 36;
  const gs = wb.addWorksheet("Grants");
  gs.addRow(["Title", "Funder", "Award number", "Role", "Start", "End", "Translational stage"]);
  boldRow(gs, 1);
  for (const g of data.grants)
    gs.addRow([g.title, g.funder, g.awardNumber ?? "", rolesOf(g, scholar.cwid).join(", "), g.start, g.end, "Not yet assigned"]);
  gs.getColumn(1).width = 80;
  const ts = wb.addWorksheet("Clinical trials");
  ts.addRow(["Title", "NCT number", "Protocol number", "Trial phase", "Status", "Start year", "End year", "Translational stage"]);
  boldRow(ts, 1);
  for (const x of data.trials)
    ts.addRow([x.title, x.nct ?? "", x.protocolNumber, x.trialPhase ?? "", x.status ?? "", x.startYear, x.endYear ?? "", x.stage ? translationalStageDisplay(x.stage) : NO_STAGE_LABEL]);
  ts.getColumn(1).width = 80;
  const areaLabel = new Map(data.areaChoices.map((a) => [a.id, a.label]));
  addCriteriaSheet(wb, describeScholarPortfolioCriteria(p, scholar, areaLabel, generatedAt));
  return workbookBuffer(wb);
}
