/**
 * Two doors into report 27 ("Downstream reach"): a block on a scholar's
 * Bibliometrics tab and a tile on report 26 (Translational portfolio). Neither
 * has a number of its own. Each number is counted by report 27's loader under
 * the params its link carries, so it is the length of the list the link opens
 * (the plan's rule: no number without its list).
 *
 * How that is kept true:
 *   - the params are built, written as a query string (`reachQueryString`) and
 *     parsed back (`parseReachParams`); the count runs under what came back.
 *     A filter the URL cannot carry (`expressible`) means no block or tile;
 *   - the viewer's scope is pinned exactly as the report pins it
 *     (`resolveReachParams`), so a count never covers a scholar the report
 *     would not list for this viewer;
 *   - nothing is shown unless the viewer can open the report
 *     (`canViewDownstreamReachReport`: the flag, and something to see).
 *
 * Server-only (`@/lib/db`, through the report's loader).
 */
import { connectionLinks, loadReachConnections } from "@/lib/edit/downstream-reach-connections";
import {
  canViewDownstreamReachReport,
  loadReach,
  loadReachCounts,
  loadScopeTotal,
  papersByType,
  parseReachParams,
  REACH_TYPE_LABEL,
  REACH_TYPES,
  reachLinks,
  reachQueryString,
  resolveReachParams,
  type ReachParams,
  type ReachType,
} from "@/lib/edit/downstream-reach-report";
import type { PortfolioParams } from "@/lib/edit/translational-portfolio-report";

type SessionLike = Parameters<typeof canViewDownstreamReachReport>[0];

/** Report 27 by its number, the permanent link: the page redirects to the
 *  report's current address and keeps the query string. */
export const REACH_REPORT_PATH = "/edit/reports/27";
const reachHref = (qs: string) => `${REACH_REPORT_PATH}?${qs}`;

/** The params as the report will read them off the link, or null when the
 *  link cannot carry them (a value the report's parser drops). */
function expressible(want: ReachParams): ReachParams | null {
  const qs = reachQueryString(want);
  const got = parseReachParams(new URLSearchParams(qs));
  return reachQueryString(got) === qs ? got : null;
}

/** The report's own defaults for everything a door does not set. */
const base = (): ReachParams => parseReachParams(new URLSearchParams());

// ---------------------------------------------------------------------------
// The Bibliometrics tab's block
// ---------------------------------------------------------------------------

export type ScholarReachLine = {
  type: ReachType;
  /** "Clinical studies", "Registered trials"…. */
  label: string;
  /** The scholar's publications cited by at least one document of this type. */
  papers: number;
  /** Report 27's Publications view listing exactly those publications. */
  href: string;
};

export type ScholarReach = {
  /** One line per citing type, in the report's order; a zero is a line too. */
  lines: ScholarReachLine[];
  /** What the block counts, in the words the tab shows. */
  note: string;
  /** "Colleagues citing this work who have never co-authored with this
   *  scholar" (`loadScholarConnections`);
   *  absent when the viewer gets no such line. */
  connections?: ScholarConnections;
};

export type ScholarConnections = {
  /** Rows of the Connections view's "Cite S's work" list. */
  colleagues: number;
  /** Report 27's Connections view for this scholar, which lists them. */
  href: string;
};

/** The block's scope, stated: it is what every link in it carries. */
export const SCHOLAR_REACH_NOTE =
  "Counts every publication this scholar is a confirmed author of: any publication type, translational stage, author position and year. A publication counts when at least one document of that kind cites it. Clinical studies and registered trials by the publication's own authors are not counted. Each number opens its list in the Downstream reach report.";

/** The scope of the block: one scholar, every stage, any author position, all
 *  years, the authors' own work left out (the report's default). */
export function scholarReachParams(cwid: string): ReachParams | null {
  return expressible({ ...base(), people: [cwid], stages: [], from: null, to: null });
}

/**
 * The block for one scholar as this viewer may see it: all four lines, so
 * "nothing cites this work" (four zeros, each still a link to its empty list,
 * as the report's own tiles are) reads differently from "not shown to you".
 * null only when the flag is off, the viewer cannot open report 27, or the
 * report would list no publication of this scholar for a viewer limited to
 * their units (the scholar is outside them).
 */
export async function loadScholarReach(cwid: string, session: SessionLike): Promise<ScholarReach | null> {
  if (!(await canViewDownstreamReachReport(session))) return null;
  const want = scholarReachParams(cwid);
  if (!want) return null;
  const params = await resolveReachParams(want, session);
  const papers = papersByType(await loadReachCounts(params));
  const links = reachLinks(params);
  if (params.scope !== null && REACH_TYPES.every((t) => papers[t] === 0) && (await loadScopeTotal(params)) === 0) {
    return null;
  }
  const lines = REACH_TYPES.map((t) => ({
    type: t,
    label: REACH_TYPE_LABEL[t],
    papers: papers[t],
    href: reachHref(links.type(t)),
  }));
  return { lines, note: SCHOLAR_REACH_NOTE };
}

/** The Connections line's scope: the block's own (one scholar, every stage,
 *  all years), on the Connections view. */
export function scholarConnectionsParams(cwid: string): ReachParams | null {
  return expressible({ ...base(), people: [cwid], stages: [], from: null, to: null, view: "connections" });
}

/**
 * The block's line "Colleagues citing this work who have never co-authored
 * with this scholar: N" (every stage, all years), where N is the row count of the Connections view's "Cite S's work" list under the
 * params its link carries, loaded by that view's own loader. null when the
 * flag is off, the viewer cannot open report 27, or the view would not open
 * for this scholar for this viewer (inactive, or outside their units).
 *
 * Kept apart from `loadScholarReach` so the block's other lines do not wait
 * on it: the route runs the two side by side. The cost is the view's own: a
 * few indexed lookups from the scholar's first- and senior-author papers
 * (`downstream-reach-connections.ts`).
 */
export async function loadScholarConnections(
  cwid: string,
  session: SessionLike,
): Promise<ScholarConnections | null> {
  if (!(await canViewDownstreamReachReport(session))) return null;
  const want = scholarConnectionsParams(cwid);
  if (!want) return null;
  const params = await resolveReachParams(want, session);
  const c = await loadReachConnections(params, ["cited"]);
  if (c.status !== "ok") return null;
  return { colleagues: c.cited.length, href: reachHref(connectionLinks(params).lists()) };
}

// ---------------------------------------------------------------------------
// The portfolio report's tile
// ---------------------------------------------------------------------------

export type PortfolioReachTile = {
  /** T0 and T1 publications in the page's filters cited by a clinical study. */
  cited: number;
  /** Every T0 and T1 publication in the page's filters. */
  total: number;
  /** Report 27's Publications view listing the `cited` ones. */
  citedHref: string;
  /** Report 27's listing of every publication in scope: the `total` ones. */
  totalHref: string;
};

/**
 * Report 26's filters as report 27 params: the same units, years and research
 * area, stages T0 and T1, citing type clinical. Each portfolio filter has a
 * report 27 form:
 *   - `unit` (department, division, center): the same who-filter vocabulary;
 *   - `from` / `to`: calendar year of publication (`basis=cy`);
 *   - `area`: the same clause on `publication_topic`;
 *   - `cwid`: that scholar's first- or senior-author publications
 *     (`person` plus `pos=first&pos=last`);
 *   - record type: both reports count publications only.
 * The page's stage pick is not carried: the tile is about T0 and T1 whatever
 * is picked, as the page's own totals ignore the pick. null when the link
 * cannot carry a value (`expressible`).
 */
export function portfolioReachParams(p: PortfolioParams): ReachParams | null {
  // Report 27 takes one research area; several have no form there.
  if (p.areas.length > 1) return null;
  // ponytail: report 27 ORs `inst:` with its units, so an institution filter has no form there; carry it if anyone asks for the tile under one.
  if (p.insts.length > 0) return null;
  return expressible({
    ...base(),
    units: p.units,
    people: p.cwid ? [p.cwid] : [],
    positions: p.cwid ? ["first", "last"] : [],
    basis: "cy",
    from: p.from,
    to: p.to,
    area: p.areas[0] ?? null,
    stages: ["T0", "T1"],
    ctypes: ["clinical"],
  });
}

/**
 * The tile for the page's filters as this viewer may see it, or null: the
 * flag is off, the viewer cannot open report 27, a filter has no report 27
 * form, or report 27 would narrow the page's scope for this viewer.
 *
 * That last case: report 26 shows every unit to anyone who can open it, while
 * report 27 limits a unit administrator to their units. The two agree only
 * when every unit the page is filtered to is one of the viewer's own; with no
 * unit filter, or a unit outside them, the tile would count less than the page
 * around it, so it is not shown.
 */
export async function loadPortfolioReachTile(p: PortfolioParams, session: SessionLike): Promise<PortfolioReachTile | null> {
  if (!(await canViewDownstreamReachReport(session))) return null;
  const want = portfolioReachParams(p);
  if (!want) return null;
  const params = await resolveReachParams(want, session);
  const { scope } = params;
  if (scope !== null && !(p.units.length > 0 && p.units.every((u) => scope.includes(u)))) return null;
  const data = await loadReach(params, { views: [], limit: 0 });
  const links = reachLinks(params);
  return {
    cited: data.pubTotal,
    total: data.scopeTotal,
    citedHref: reachHref(links.cited()),
    totalHref: reachHref(links.scope()),
  };
}
