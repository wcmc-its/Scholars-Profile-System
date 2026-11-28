/**
 * Report 27 — "Downstream reach": how publications, especially basic (T0) and
 * early-translation (T1) ones, were taken up downstream. "Downstream" is five
 * citing types, all stored in `citing_document`: clinical studies (level
 * `clinical`), registered trials (`trial`), guidelines and policy (levels
 * `authority`, `guideline`, `consensus`), systematic reviews (`review`) and
 * patents (`patent`); `REACH_LEVELS` is the one place that says so. Reads what
 * the citation imports maintain; writes nothing. Behind
 * `DOWNSTREAM_REACH_REPORT`.
 *
 * Built on report 24 (`policy-citations-report.ts`): the same who-filter, the
 * same access rule and the same scope handling. `scope` is never read from the
 * URL: the parser leaves it `[]` (match nothing) and `resolveReachParams` sets
 * it from the session, on the page and in the download route alike.
 *
 * THE RULE this report is built on: a count is shown only where the reader can
 * open the list of exactly the records it counts. So every count here is
 * defined as the length of a listing this module can produce:
 *   - a tile, a tab and a People cell count rows of the Publications view
 *     under a stated query string (`reachQueryString`);
 *   - a Citing documents row counts the Publications view filtered to that
 *     document (`doc`);
 *   - a Publications cell counts citing documents, and opens the publication
 *     modal only when the modal lists exactly those (`modalListsExactly`) and
 *     will open for that paper at all (`loadModalHidden`);
 *     otherwise it opens the Citing documents view filtered to that paper
 *     (`pmid`) and type, which pages to the end.
 *
 * What is counted, per paper and type (one "citing document" each):
 *   - clinical: one per article (`citing_document.id`), as
 *     `publication.clinical_cite_count` has it;
 *   - trial, patent: one per `dedup_key` (a patent family is one invention);
 *   - policy: one per level and `dedup_key`, the sum of report 24's counts at
 *     its three levels;
 *   - review: one per `dedup_key`, report 24's review count.
 *
 * Own work is what the rollups leave out and nothing else: a `clinical` link
 * flagged `ownWork`, or a `trial` link flagged `ownTrial` (`ownLinkSql`). A
 * flag on a link at any other level is not own work: the policy, review and
 * patent rollups count every link.
 *
 * Where the counts come from. With the authors' own work left out (the
 * default) every per-paper count is a rollup column on `publication`
 * (`clinical_cite_count`, `trial_count`, the four ranked-level counts,
 * `patent_family_count`), so no query for the Publications or People view
 * reads the link table. Two things cannot use the rollups and say so here:
 *   - "Include the authors' own work" (`own=in`): the rollups do not count own
 *     work, so the per-paper counts are a live aggregate over the links of the
 *     publications in scope (`loadReachCounts`). It runs ONCE per request: the
 *     People view is folded from its rows in Node, and the Citing documents
 *     view does not need it.
 *   - The Citing documents view: one row per citing document has no rollup, so
 *     it reads the links of the publications in scope, by the link table's
 *     primary key (`pmid` first), once per request (`loadReachDocs`).
 * Both start from `ok` (`okSql`), the publications in scope with the
 * authorship test done once per publication, and never from the links. No
 * query starts from `publication_citing_document` or `citing_document` except
 * the two keyed lookups for a `doc` filter.
 *
 * Every query that tests authorship is driven from `publication` under
 * `STRAIGHT_JOIN` (the scope total included, `loadScopeTotal`), so it is as
 * selective as the publication filters are. The Citing documents view is not
 * computed for a selection wider than `REACH_DOCS_PAPER_CEILING` cited papers
 * (`docsTooWide`): the tab and the download's sheet then say so, and show no
 * count of citing documents.
 *
 * Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { parsePatentId } from "@/etl/patent-citations/shape";
import { loadPublicationSuppressions, resolveDarkPmids } from "@/lib/api/manual-layer";
import { TOPIC_ACTIVITY_SCORE_FLOOR } from "@/lib/api/topic-activity";
import type { EditSession } from "@/lib/auth/superuser";
import { POLICY_REVIEWS_CAP, policyCitationBadgesOn } from "@/lib/citations/policy-rollup";
import {
  clinicalCitationsModalOn,
  patentCitationsModalOn,
  TRIAL_PATENT_CAP,
  trialCitationsModalOn,
} from "@/lib/citations/trials-patents";
import { db } from "@/lib/db";
import { NO_STAGE_LABEL, STAGE_NOT_LOW } from "@/lib/edit/article-count-report";
import { parseRep } from "@/lib/edit/patent-citations-report";
import {
  citationParamReader,
  DEFAULT_FROM,
  facetChips,
  fiscalLabel,
  LEVEL_ONE,
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
  type Level,
  type PolicyChip,
  type Position,
  type PubDetails,
  type WhoParams,
} from "@/lib/edit/policy-citations-report";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import { Prisma } from "@/lib/generated/prisma/client";
import { institutionDisplayName } from "@/lib/institutions";
import { formatRoleCategory } from "@/lib/role-display";
import {
  displayStage,
  TRANSLATIONAL_STAGES,
  translationalStageDisplay,
  type TranslationalStage,
} from "@/lib/translational-stage";
import { htmlToPlainText } from "@/lib/utils";

/** DOWNSTREAM_REACH_REPORT — off: the report is absent from the index, its
 *  page and download route 404, and no query runs. */
export function isDownstreamReachReportEnabled(): boolean {
  return process.env.DOWNSTREAM_REACH_REPORT === "on";
}

// ---------------------------------------------------------------------------
// Citing types and stages
// ---------------------------------------------------------------------------

/** Decision 10 of the plan (2026-11-28): systematic reviews are a type of
 *  their own, so "Guidelines and policy" counts what the publication modal's
 *  tab of that name counts, which leaves reviews out. */
export const REACH_TYPES = ["clinical", "trial", "policy", "review", "patent"] as const;
export type ReachType = (typeof REACH_TYPES)[number];
export type ReachCounts = Record<ReachType, number>;

export const REACH_TYPE_LABEL: Record<ReachType, string> = {
  clinical: "Clinical studies",
  trial: "Registered trials",
  policy: "Guidelines and policy",
  review: "Systematic reviews",
  patent: "Patents",
};
export const REACH_TYPE_ONE: Record<ReachType, string> = {
  clinical: "Clinical study",
  trial: "Registered trial",
  policy: "Guideline or policy document",
  review: "Systematic review",
  patent: "Patent",
};
/** A tile's and a People column's wording: "papers …". */
export const REACH_TYPE_CITED: Record<ReachType, string> = {
  clinical: "cited by clinical studies",
  trial: "cited by registered trials",
  policy: "cited in guidelines or policy",
  review: "cited in systematic reviews",
  patent: "cited in patents",
};

/** The `citing_document.level` values behind each type: the one list every
 *  reader takes them from (tiles, columns, the rollup and live counts, own
 *  work, the Citing documents view, the modal test, the download, and the two
 *  doors in `downstream-reach-entry.ts`). Between them `policy` and `review`
 *  cover report 24's four ranked levels (`POLICY_LEVELS`). */
export const REACH_LEVELS = {
  clinical: ["clinical"],
  trial: ["trial"],
  policy: ["authority", "guideline", "consensus"],
  review: ["review"],
  patent: ["patent"],
} as const satisfies Record<ReachType, readonly string[]>;
const levelsOf = (t: ReachType): readonly string[] => REACH_LEVELS[t];
const ALL_LEVELS = REACH_TYPES.flatMap(levelsOf);

export function reachTypeOfLevel(level: string): ReachType | null {
  return REACH_TYPES.find((t) => levelsOf(t).includes(level)) ?? null;
}

/** Which section of the publication modal lists a type. */
export const MODAL_SECTION: Record<ReachType, "trials" | "policy"> = {
  clinical: "trials",
  trial: "trials",
  policy: "policy",
  // The modal lists reviews in the same section, under their own heading.
  review: "policy",
  patent: "trials",
};

/** The stage filter's values: the four displayed stages and "No stage". */
export const STAGE_KEYS = [...TRANSLATIONAL_STAGES, "none"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
/** What the stage filter starts at (decision 4 of the plan). */
export const DEFAULT_STAGES: readonly StageKey[] = ["T0", "T1"];
/** The rail's hidden `stage` value: the form was submitted, so no stage ticked
 *  means every stage, not the default. */
export const STAGE_ANY = "any";

const sameStages = (a: readonly StageKey[], b: readonly StageKey[]): boolean =>
  a.length === b.length && a.every((s) => b.includes(s));

export const stageKeyLabel = (k: StageKey): string => (k === "none" ? NO_STAGE_LABEL : translationalStageDisplay(k));

/** A paper's stage key under the display rule: a stage counts only under
 *  `displayStage`; everything else is "none". */
export function stageKeyOf(stage: string | null | undefined, confidence: string | null | undefined): StageKey {
  return displayStage(stage, confidence) ?? "none";
}

/** The ticked types; none ticked = all five. */
export function tickedTypes(p: Pick<ReachParams, "ctypes">): readonly ReachType[] {
  return p.ctypes.length > 0 ? p.ctypes : REACH_TYPES;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** The People view lists a scholar with at least this many qualifying papers
 *  (the portfolio report's rule, `MIN_SCHOLAR_ACTIVITIES`). */
export const MIN_REACH_PAPERS = 3;
/** Rows per page, on every tab. */
export const REACH_PAGE_SIZE = 50;
/** The download's Publications sheet carries at most this many rows. */
export const REACH_LIST_CAP = 5000;
/** The download's Citing documents sheet carries at most this many rows. */
export const REACH_DOCS_CAP = 20_000;
/**
 * The Citing documents view is listed only while the selection covers at most
 * this many cited papers (the Publications tab's count: papers in scope cited
 * by a ticked type). Above it the grouped query (`docGroupsSql`) is not run:
 * the tab and the download's sheet say the selection is too wide, and no count
 * of citing documents is shown, since a number is only shown with its list.
 *
 * Why. The view groups every link of the cited papers into one row per citing
 * document, and that cost grows with the links read, whatever the indexes.
 * Measured on staging (about 205,000 publications, 1.3 million citing links):
 *   - the default selection (T0 and T1 from 2020; 3,732 cited papers): about
 *     0.9 s;
 *   - every stage and every year (111,360 cited papers): 17 to 35 s, and the
 *     connection was closed before an answer came back, so the page errored;
 *   - the same grouping cut down to clinical documents alone, with no own-work
 *     test: still 6 to 10 s. So this is the cost of grouping about a million
 *     links, not a missing index.
 * 20,000 is a starting value between the two measured ends, not a tuned one.
 * The check is free: the cited papers are already loaded for the Publications
 * tab (`loadReachCounts`). A view filtered to one paper (`pmid`) or one person
 * is far below it.
 *
 * Upgrade path: a precomputed table of each citing document's paper count
 * (one row per document and cited paper, or the count per document under the
 * default own-work rule), maintained by the citation imports, so the listing
 * reads rows instead of grouping links. With it the ceiling can go.
 */
export const REACH_DOCS_PAPER_CEILING = 20_000;
/** Whether a selection covering this many cited papers is too wide to list
 *  its citing documents. */
export const docsTooWide = (citedPapers: number): boolean => citedPapers > REACH_DOCS_PAPER_CEILING;
/** What the tab and the sheet both tell the reader to do about it. */
export const REACH_DOCS_NARROW_HINT = "Narrow it by unit, years, stage, research area or person.";

/** Citing-document filters one URL can carry (each narrows the papers further). */
export const MAX_DOC_FILTERS = 5;

/** The Publications order (spec B3): the Total, one per type (the column
 *  headers sort by these too), then by publication year. */
export const REACH_SORT_LABEL = {
  cited: "Most citing documents",
  clinical: "Most clinical studies",
  trial: "Most registered trials",
  policy: "Most guidelines and policy",
  review: "Most systematic reviews",
  patent: "Most patents",
  year: "Newest",
  oldest: "Oldest",
} as const;
export type ReachSort = keyof typeof REACH_SORT_LABEL;
/** The sorts a column header sets: a count, highest first unless `asc`. */
export const isCountSort = (s: ReachSort): s is "cited" | ReachType => s !== "year" && s !== "oldest";

export const REACH_DOC_SORT_LABEL = {
  papers: "Most papers cited",
  recent: "Most recent first",
} as const;
export type ReachDocSort = keyof typeof REACH_DOC_SORT_LABEL;

export type ReachView = "publications" | "documents" | "people" | "connections";
export const REACH_VIEWS: readonly ReachView[] = ["publications", "documents", "people", "connections"];

/** Which list of the Connections view a pairs list (`with`) belongs to:
 *  `cited` = colleagues whose papers cite the scholar's work ("Cite S's
 *  work"); `cites` = colleagues whose work the scholar's papers cite ("S
 *  cites"). See `downstream-reach-connections.ts`. */
export const CONNECTION_DIRS = ["cited", "cites"] as const;
export type ConnectionDir = (typeof CONNECTION_DIRS)[number];

/** A `doc` filter, resolved: which citing document (or invention, or deduped
 *  document) the id stands for. */
export type ReachDocRef = { id: number; level: string; type: ReachType; dedupKey: string; title: string };

export type ReachParams = WhoParams & {
  /** `stage`; empty = every stage. */
  stages: StageKey[];
  /** `ctype`; empty = all five. An old link's `ctype=policy` alone now means
   *  guidelines and policy without systematic reviews (decision 10). */
  ctypes: ReachType[];
  /** `own=in`: count the authors' own work too. Off by default. */
  includeOwn: boolean;
  /** `area`: a research area (topic id); null = any. */
  area: string | null;
  /** `pmid`: one paper only (a Publications cell's link into Citing documents). */
  pmid: string | null;
  /** `doc`: papers cited by each of these citing documents (their ids). */
  docs: number[];
  /** `show=all`: the Publications view lists every publication in scope, cited
   *  or not (the list behind the "of M" in the first tile). */
  showAll: boolean;
  view: ReachView;
  sort: ReachSort;
  /** `order=asc`: a count sort, lowest first (a header's second click). */
  asc: boolean;
  /** The Citing documents tab's order (`dsort`). */
  docSort: ReachDocSort;
  /** The current tab's search (`q`); "" = none. */
  q: string;
  /** 1-based (`page`). */
  page: number;
  /** `docs`, resolved (`resolveReachParams`). null = not resolved: a `doc`
   *  filter then matches nothing. Never from the URL. */
  docRefs: ReachDocRef[] | null;
  /** `with`: the Connections view's pairs list for the scholar in `person`
   *  and this colleague (a CWID); null = the two lists. Carried only on the
   *  Connections view. */
  with: string | null;
  /** `dir`: which of the two lists `with` is from. Default `cited`. */
  dir: ConnectionDir;
};

/** View state, not filters: a URL with nothing else is bare. */
const VIEW_KEYS = new Set(["view", "sort", "order", "dsort", "q", "page", "show", "with", "dir"]);

/**
 * Every param is optional; a stray value is dropped. Defaults that do not
 * depend on the rest of the URL, so a link that carries only a person or a
 * unit still gets them: stages T0 and T1 unless a `stage` is given (`any` for
 * every stage), all five citing types, own work left out unless `own=in`.
 * The publication years start at `DEFAULT_FROM` on a bare URL only, as on
 * report 24.
 *
 * `own` is the rail's hidden-plus-checkbox pair: the form always sends `in`,
 * and the ticked "Leave out the authors' own work" box adds `out`, which wins.
 */
export function parseReachParams(sp: URLSearchParams): ReachParams {
  const bare = ![...sp.keys()].some((k) => !VIEW_KEYS.has(k));
  const { among, one, range, types, units, people, positions, basis, q, page } = citationParamReader(sp);
  const [from, to] = range("from", "to");
  const stages = among("stage", STAGE_KEYS);
  const own = sp.getAll("own");
  const area = sp.get("area")?.trim() ?? "";
  const pmid = sp.get("pmid")?.trim() ?? "";
  const withCwid = sp.get("with")?.trim() ?? "";
  const docs = [...new Set(sp.getAll("doc").map((v) => (/^[1-9]\d{0,9}$/.test(v) ? Number(v) : 0)))]
    .filter((n) => n > 0)
    .slice(0, MAX_DOC_FILTERS);
  const view = one("view", REACH_VIEWS, "publications");
  // The Connections view applies no position, paper or citing-document
  // filter (`downstream-reach-connections.ts`), so it does not carry them: a
  // tab click from another view drops them, and no chip or Criteria row names
  // a filter the lists were not taken under.
  const connections = view === "connections";
  const ctypes = among("ctype", REACH_TYPES);
  // A type's sort needs its column: a type not ticked sorts by the Total.
  const sortGiven = one("sort", Object.keys(REACH_SORT_LABEL) as ReachSort[], "cited");
  const sort =
    (REACH_TYPES as readonly string[]).includes(sortGiven) && ctypes.length > 0 && !ctypes.includes(sortGiven as ReachType)
      ? "cited"
      : sortGiven;
  return {
    types,
    units,
    people,
    positions: connections ? [] : positions,
    basis,
    from: bare ? DEFAULT_FROM : from,
    to,
    stages: stages.length > 0 ? stages : sp.getAll("stage").includes(STAGE_ANY) ? [] : [...DEFAULT_STAGES],
    ctypes,
    includeOwn: own.includes("in") && !own.includes("out"),
    area: /^[A-Za-z0-9_-]{1,128}$/.test(area) ? area : null,
    pmid: !connections && /^\d{1,16}$/.test(pmid) ? pmid : null,
    docs: connections ? [] : docs,
    showAll: sp.get("show") === "all",
    view,
    sort,
    asc: sp.get("order") === "asc" && isCountSort(sort) && sort === sortGiven,
    docSort: one("dsort", Object.keys(REACH_DOC_SORT_LABEL) as ReachDocSort[], "papers"),
    q,
    page,
    scope: [],
    docRefs: null,
    // The person filter's CWID rule.
    with: /^[A-Za-z0-9]{2,16}$/.test(withCwid) ? withCwid : null,
    dir: one("dir", CONNECTION_DIRS, "cited"),
  };
}

/** The canonical query string: the download link, the chips, the tabs, the
 *  tiles and every count's link build on it. Always carries `basis` and
 *  `stage`, so it is never bare. `page` rides only when asked for: any other
 *  change starts at page 1. */
export function reachQueryString(p: ReachParams, over: Partial<ReachParams> = {}): string {
  const x = { ...p, page: 1, ...over };
  const q = new URLSearchParams();
  for (const t of x.types) q.append("type", t);
  for (const u of x.units) q.append("unit", u);
  for (const c of x.people) q.append("person", c);
  for (const v of x.positions) q.append("pos", v);
  if (x.stages.length === 0) q.set("stage", STAGE_ANY);
  for (const s of x.stages) q.append("stage", s);
  for (const t of x.ctypes) q.append("ctype", t);
  if (x.includeOwn) q.set("own", "in");
  if (x.area) q.set("area", x.area);
  q.set("basis", x.basis);
  for (const k of ["from", "to"] as const) if (x[k] !== null) q.set(k, String(x[k]));
  if (x.pmid) q.set("pmid", x.pmid);
  for (const d of x.docs) q.append("doc", String(d));
  if (x.showAll) q.set("show", "all");
  if (x.view !== "publications") q.set("view", x.view);
  // A pairs list exists only on the Connections view: any other view drops it.
  if (x.view === "connections" && x.with) {
    q.set("with", x.with);
    if (x.dir !== "cited") q.set("dir", x.dir);
  }
  if (x.sort !== "cited") q.set("sort", x.sort);
  if (x.asc && isCountSort(x.sort)) q.set("order", "asc");
  if (x.docSort !== "papers") q.set("dsort", x.docSort);
  if (x.q) q.set("q", x.q);
  if (x.page > 1) q.set("page", String(x.page));
  return q.toString();
}

/** Nothing set beyond what a bare URL gets (the "Reset to defaults" test). */
export function isReachDefault(p: ReachParams): boolean {
  const filters = (x: ReachParams) =>
    reachQueryString(x, { view: "publications", sort: "cited", asc: false, docSort: "papers", q: "", showAll: false });
  return filters(p) === filters(parseReachParams(new URLSearchParams()));
}

/**
 * The query string behind every number on the page: the list of exactly the
 * records that number counts. The body builds each link from these and the
 * tests load each one and compare its length with the count
 * (`downstream-reach-report.test.ts`). A link into a list drops the search and
 * `show=all`, neither of which any count is taken under.
 */
export function reachLinks(p: ReachParams) {
  const qs = (over: Partial<ReachParams>) => reachQueryString(p, { q: "", showAll: false, ...over });
  return {
    /** The first tile's N, and the Publications tab: papers cited by a ticked type. */
    cited: () => qs({ view: "publications" }),
    /** The first tile's M: every publication in scope. */
    scope: () => qs({ view: "publications", showAll: true }),
    /** A type's tile: papers cited by that type. */
    type: (t: ReachType) => qs({ view: "publications", ctypes: [t] }),
    /** A Publications cell, when the modal cannot list it: that paper's citing
     *  documents of one type; with no type (the Total), of every ticked type. */
    paperDocs: (pmid: string, t: ReachType | null) => qs({ view: "documents", pmid, ...(t ? { ctypes: [t] } : {}) }),
    /** A Citing documents row: the listed papers it cites. null when the URL
     *  can carry no more `doc` filters; the count is then not shown. */
    docPapers: (docId: number) =>
      p.docs.includes(docId) || p.docs.length < MAX_DOC_FILTERS
        ? qs({ view: "publications", docs: [...new Set([...p.docs, docId])] })
        : null,
    /** A People cell: that person's first- or senior-author papers, cited by
     *  the ticked types or by one. */
    person: (cwid: string, t: ReachType | null) =>
      qs({ view: "publications", people: [cwid], positions: peoplePositions(p) ?? [], ...(t ? { ctypes: [t] } : {}) }),
    /** A tab. The Connections tab opens its two lists, not a pairs list, and
     *  widens the report's default T0 and T1 to every stage: few papers have a
     *  stage, so under the default the lists are empty for nearly everyone
     *  (staging, 2026-11-28: 0 connections for each of the five most-cited
     *  scholars). A stage pick of the user's own is kept. */
    view: (v: ReachView) =>
      qs({
        view: v,
        with: null,
        ...(v === "connections" && sameStages(p.stages, DEFAULT_STAGES) ? { stages: [] } : {}),
      }),
  };
}

/** The author positions the People view counts: first or senior (last), and
 *  within the `pos` filter when one is set. null = the filter leaves neither. */
export function peoplePositions(p: Pick<ReachParams, "positions">): Position[] | null {
  const firstOrSenior: Position[] = ["first", "last"];
  if (p.positions.length === 0) return firstOrSenior;
  const both = firstOrSenior.filter((k) => p.positions.includes(k));
  return both.length > 0 ? both : null;
}

// ---------------------------------------------------------------------------
// Access: report 24's rule, behind the flag.
// ---------------------------------------------------------------------------

type SessionLike = Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward">;

/** The gate, for the page and the index: the flag on, and something to see.
 *  With the flag off nothing is read. */
export async function canViewDownstreamReachReport(session: SessionLike): Promise<boolean> {
  if (!isDownstreamReachReportEnabled()) return false;
  const scope = await loadPolicyCitationScope(session);
  return scope === null || scope.length > 0;
}

/** The citing documents a `doc` filter names, by id (a public fact about the
 *  document, so there is nothing to scope). An id that is not a citing
 *  document of a known type is left out, and the filter then matches nothing. */
export async function loadReachDocRefs(ids: readonly number[]): Promise<ReachDocRef[]> {
  if (ids.length === 0) return [];
  const raw = await db.read.$queryRaw<{ id: number; level: string; dedup_key: string; title: string }[]>`
    SELECT d.id, d.level, d.dedup_key, d.title
      FROM citing_document d
     WHERE d.id IN (${Prisma.join([...ids])})`;
  const byId = new Map(raw.map((r) => [Number(r.id), r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    const type = r ? reachTypeOfLevel(r.level) : null;
    return r && type ? [{ id, level: r.level, type, dedupKey: r.dedup_key, title: r.title }] : [];
  });
}

/** What the page and the download both do after parsing: pin the scope and
 *  resolve the `doc` filters. */
export async function resolveReachParams(p: ReachParams, session: SessionLike): Promise<ReachParams> {
  const [scope, docRefs] = await Promise.all([loadPolicyCitationScope(session), loadReachDocRefs(p.docs)]);
  return { ...p, scope, docRefs };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** The link flag that marks own work, per level. No other level has one: a
 *  flag left on a link whose document was since retyped (a clinical article
 *  that PubMed now types as a guideline keeps `ownWork`) is not own work,
 *  because the rollup for its new level counts it. */
export const OWN_FLAG: Record<string, "ownWork" | "ownTrial"> = { clinical: "ownWork", trial: "ownTrial" };

export const ownFlagSql = (l: string, flag: "ownWork" | "ownTrial"): Prisma.Sql =>
  Prisma.sql`COALESCE(JSON_CONTAINS(${Prisma.raw(l)}.evidence, 'true', ${Prisma.raw(`'$.${flag}'`)}), 0) = 1`;

/** A link that is the authors' own work, exactly as the rollups test it
 *  (`CLINICAL_COUNT_SQL`, and `trial_count` in etl/policy-citations): a
 *  clinical article sharing a confirmed author with the paper, or a trial one
 *  of the paper's authors is an investigator on. The level leads each test, so
 *  the JSON is read only on links that can carry the flag. */
const ownLinkSql = (l: string, d: string): Prisma.Sql =>
  Prisma.sql`(${Prisma.join(
    Object.entries(OWN_FLAG).map(
      ([level, flag]) => Prisma.sql`(${Prisma.raw(d)}.level = '${Prisma.raw(level)}' AND ${ownFlagSql(l, flag)})`,
    ),
    " OR ",
  )})`;

/** Which links count, on the link alias `l` and its document `d`: all of
 *  them, or all but own work. */
const countedLinkSql = (p: Pick<ReachParams, "includeOwn">, l = "l", d = "d"): Prisma.Sql =>
  p.includeOwn ? Prisma.empty : Prisma.sql`AND NOT ${ownLinkSql(l, d)}`;

/** `MIN()` of this over a citing document's rows names the one that stands
 *  for it, in report 25's layout (`REP_SQL`, read by `parseRep`): granted
 *  before application, then earliest year, then lowest id. Only a patent has
 *  a kind, so `details` is read for patents alone. */
const DOC_REP_SQL = Prisma.sql`CONCAT(IF(d.level = 'patent' AND JSON_UNQUOTE(JSON_EXTRACT(d.details, '$.kind')) = 'application', '1', '0'), LPAD(COALESCE(d.year, 9999), 4, '0'), LPAD(d.id, 10, '0'))`;

/** What one "citing document" is, within a level (`d` = `citing_document`):
 *  the article for a clinical study, the `dedup_key` for everything else. */
const UNIT_SQL = Prisma.sql`IF(d.level = 'clinical', CAST(d.id AS CHAR), d.dedup_key)`;

/** The SQL form of `stageKeyOf(…) !== "none"`, on `p`; never NULL. */
const stagedSql = (): Prisma.Sql =>
  Prisma.sql`COALESCE(p.translational_stage IN (${Prisma.join([...TRANSLATIONAL_STAGES])}) AND ${STAGE_NOT_LOW}, 0)`;

/** The stage filter, on `p`. Every key ticked is no filter at all. */
function stageSql(stages: readonly StageKey[]): Prisma.Sql {
  if (stages.length === 0 || STAGE_KEYS.every((k) => stages.includes(k))) return Prisma.empty;
  const shown = stages.filter((s): s is TranslationalStage => s !== "none");
  const parts: Prisma.Sql[] = [];
  if (shown.length > 0) {
    parts.push(Prisma.sql`(p.translational_stage IN (${Prisma.join(shown)}) AND ${STAGE_NOT_LOW})`);
  }
  if (stages.includes("none")) parts.push(Prisma.sql`${stagedSql()} = 0`);
  return Prisma.sql`AND (${Prisma.join(parts, " OR ")})`;
}

/** One `doc` filter, on `p`: the papers that citing document cites, under the
 *  own-work rule (`ownLinkSql`). A clinical study is found by the links' index on its id; any
 *  other document by its level (indexed) and `dedup_key`. */
function docFilterSql(p: Pick<ReachParams, "includeOwn">, ref: ReachDocRef): Prisma.Sql {
  // The level is known here, so the own-work test is that level's flag, or
  // nothing for a level that has none.
  const flag = OWN_FLAG[ref.level];
  const counted = p.includeOwn || !flag ? Prisma.empty : Prisma.sql`AND NOT (${ownFlagSql("l2", flag)})`;
  return ref.level === "clinical"
    ? Prisma.sql`AND p.pmid IN (SELECT l2.pmid FROM publication_citing_document l2
                    WHERE l2.citing_document_id = ${ref.id} ${counted})`
    : Prisma.sql`AND p.pmid IN (SELECT l2.pmid FROM citing_document d2
                     JOIN publication_citing_document l2 ON l2.citing_document_id = d2.id
                    WHERE d2.level = ${ref.level} AND d2.dedup_key = ${ref.dedupKey} ${counted})`;
}

/** The paper's own filters, as conditions on `p` (`publication`): years,
 *  stage and research area. What the Connections view applies to the cited
 *  paper (`downstream-reach-connections.ts`). */
export function citedPaperSql(p: Pick<ReachParams, "basis" | "from" | "to" | "stages" | "area">): Prisma.Sql {
  return Prisma.sql`${pubYearSql(p)}
       ${stageSql(p.stages)}
       ${
         p.area
           ? Prisma.sql`AND p.pmid IN (SELECT pt_a.pmid FROM publication_topic pt_a WHERE pt_a.parent_topic_id = ${p.area} AND pt_a.score >= ${TOPIC_ACTIVITY_SCORE_FLOOR})`
           : Prisma.empty
       }`;
}

/** Which publications are in scope, as conditions on `p` (`publication`):
 *  years, stage, research area, one paper, and the citing-document filters.
 *  The authorship half of the scope is `policyScopeSql`. */
export function reachPubSql(p: ReachParams): Prisma.Sql {
  const docs =
    p.docs.length === 0
      ? Prisma.empty
      : p.docRefs === null || p.docRefs.length !== p.docs.length
        ? Prisma.sql`AND 1 = 0`
        : Prisma.join(p.docRefs.map((ref) => docFilterSql(p, ref)), " ");
  return Prisma.sql`${citedPaperSql(p)}
       ${p.pmid ? Prisma.sql`AND p.pmid = ${p.pmid}` : Prisma.empty}
       ${docs}`;
}

/** Whether every count can be read off the rollup columns: only while own
 *  work is left out, since that is what the rollups count. */
export const usesRollups = (p: Pick<ReachParams, "includeOwn">): boolean => !p.includeOwn;

/** The rollup column on `publication` for each ranked level (report 24's). */
const RANKED_ROLLUP: Record<"authority" | "guideline" | "consensus" | "review", string> = {
  authority: "p.authority_count",
  guideline: "p.guideline_count",
  consensus: "p.consensus_count",
  review: "p.review_count",
};
/** The sum of the ranked-level rollups behind a type, from `REACH_LEVELS`. */
const rankedRollup = (levels: readonly (keyof typeof RANKED_ROLLUP)[]): Prisma.Sql =>
  Prisma.raw(levels.length === 1 ? RANKED_ROLLUP[levels[0]] : `(${levels.map((l) => RANKED_ROLLUP[l]).join(" + ")})`);

const ROLLUP_COL: Record<ReachType, Prisma.Sql> = {
  clinical: Prisma.sql`p.clinical_cite_count`,
  trial: Prisma.sql`p.trial_count`,
  policy: rankedRollup(REACH_LEVELS.policy),
  review: rankedRollup(REACH_LEVELS.review),
  patent: Prisma.sql`p.patent_family_count`,
};

/** One per level and `dedup_key` among a type's ranked levels: the sum of
 *  their rollups. */
const rankedLive = (levels: readonly string[]): Prisma.Sql =>
  Prisma.sql`COUNT(DISTINCT CASE WHEN d.level IN (${Prisma.join([...levels])}) THEN CONCAT(d.level, '|', d.dedup_key) END)`;

/** Citing documents of one type among the joined links, as the rollups count
 *  them (see the module comment). */
const LIVE_COUNT: Record<ReachType, Prisma.Sql> = {
  clinical: Prisma.sql`COUNT(DISTINCT CASE WHEN d.level = 'clinical' THEN d.id END)`,
  trial: Prisma.sql`COUNT(DISTINCT CASE WHEN d.level = 'trial' THEN d.dedup_key END)`,
  policy: rankedLive(REACH_LEVELS.policy),
  review: rankedLive(REACH_LEVELS.review),
  patent: Prisma.sql`COUNT(DISTINCT CASE WHEN d.level = 'patent' THEN d.dedup_key END)`,
};

/**
 * `ok`: the publications in scope, one row each. The authorship test runs
 * here, once per publication (`GROUP BY` folds a paper with several matching
 * authors), so a query that goes on to read links never tests it per link.
 * `STRAIGHT_JOIN` pins the order as written: the publications, then each
 * one's authorships by index. `cited` narrows to papers the rollups say are
 * cited; `cols` adds columns of `p`, aggregated.
 */
function okSql(p: ReachParams, opts: { cited?: Prisma.Sql; cols?: Prisma.Sql } = {}): Prisma.Sql {
  return Prisma.sql`(SELECT STRAIGHT_JOIN p.pmid${opts.cols ?? Prisma.empty}
              FROM publication p
              JOIN publication_author pa ON pa.pmid = p.pmid
              JOIN scholar s ON s.cwid = pa.cwid
             WHERE ${opts.cited ? Prisma.sql`${opts.cited} AND` : Prisma.empty} ${policyScopeSql(p)}
               ${reachPubSql(p)}
             GROUP BY p.pmid) ok`;
}

/** "Cited by at least one document of these types". */
const citedSql = (col: Record<ReachType, Prisma.Sql>, types: readonly ReachType[]): Prisma.Sql =>
  Prisma.sql`(${Prisma.join(types.map((t) => Prisma.sql`${col[t]} > 0`), " OR ")})`;

type Num = bigint | number;
const num = (v: Num | null): number | null => (v === null ? null : Number(v));
type CountCols = Record<`n_${ReachType}`, Num>;
const toCounts = (r: CountCols): ReachCounts =>
  Object.fromEntries(REACH_TYPES.map((t) => [t, Number(r[`n_${t}`])])) as ReachCounts;
const NO_COUNTS: ReachCounts = Object.fromEntries(REACH_TYPES.map((t) => [t, 0])) as ReachCounts;
const NO_COUNT_COLS: CountCols = Object.fromEntries(REACH_TYPES.map((t) => [`n_${t}`, 0])) as CountCols;

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export type ReachPubCounts = ReachCounts & {
  pmid: string;
  year: number | null;
  /** The displayed stage, or "none". */
  stage: StageKey;
};

/**
 * One row per publication in scope cited by at least one document of ANY of
 * the five types, with its five counts, unsorted: fetched once, and the tiles,
 * the tab count and the listed rows are all folded from it in Node (as report
 * 24 does), so a tile and the list it opens cannot disagree.
 *
 * Rollups (own work left out): `publication p`, the counts are its columns,
 * and the link table is not read. `STRAIGHT_JOIN` pins the order as written:
 * the publications, then each one's authorships by index; `GROUP BY` folds a
 * paper with several matching authors back to one row.
 *
 * Live (own work included): the aggregate over the links of `ok`, read by
 * primary key. The join is the "cited" test: a paper with no link at a known
 * level makes no row. This is the only place the aggregate is evaluated; the
 * other loaders take its rows (`loadReachPeople`) or do not need it
 * (`docGroupsSql`).
 */
export async function loadReachCounts(p: ReachParams): Promise<ReachPubCounts[]> {
  type Row = CountCols & { pmid: string; year: Num | null; stage: string | null; confidence: string | null };
  const raw = usesRollups(p)
    ? await db.read.$queryRaw<Row[]>`
    SELECT STRAIGHT_JOIN p.pmid AS pmid, MAX(p.year) AS year, MAX(p.translational_stage) AS stage,
           MAX(p.translational_stage_confidence) AS confidence,
           ${Prisma.join(REACH_TYPES.map((t) => Prisma.sql`MAX(${ROLLUP_COL[t]}) AS ${Prisma.raw(`n_${t}`)}`), ", ")}
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${citedSql(ROLLUP_COL, REACH_TYPES)}
       AND ${policyScopeSql(p)}
       ${reachPubSql(p)}
     GROUP BY p.pmid`
    : await db.read.$queryRaw<Row[]>`
    SELECT STRAIGHT_JOIN ok.pmid AS pmid, MAX(ok.year) AS year, MAX(ok.stage) AS stage,
           MAX(ok.confidence) AS confidence,
           ${Prisma.join(REACH_TYPES.map((t) => Prisma.sql`${LIVE_COUNT[t]} AS ${Prisma.raw(`n_${t}`)}`), ", ")}
      FROM ${okSql(p, {
        cols: Prisma.sql`, MAX(p.year) AS year, MAX(p.translational_stage) AS stage, MAX(p.translational_stage_confidence) AS confidence`,
      })}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE d.level IN (${Prisma.join(ALL_LEVELS)})
     GROUP BY ok.pmid`;
  return raw.map((r) => ({
    pmid: r.pmid,
    year: num(r.year),
    stage: stageKeyOf(r.stage, r.confidence),
    ...toCounts(r),
  }));
}

/** The rows cited by a document of one of these types: what the Publications
 *  view lists, and what a tile counts. */
export function listedFor<T extends ReachCounts>(rows: readonly T[], types: readonly ReachType[]): T[] {
  return rows.filter((r) => types.some((t) => r[t] > 0));
}

/** Papers cited by each type, whatever is ticked: the five type tiles. Each
 *  equals `listedFor(rows, [type]).length`, the list its link opens. */
export function papersByType(rows: readonly ReachCounts[]): ReachCounts {
  return Object.fromEntries(REACH_TYPES.map((t) => [t, listedFor(rows, [t]).length])) as ReachCounts;
}

/** A row's Total: its citing documents of the ticked types (spec B2). No
 *  document is stored under two types (#3608), so the sum double counts
 *  nothing; it equals the Citing documents view for the paper and those types. */
export const reachTotal = (r: ReachCounts, types: readonly ReachType[]): number =>
  types.reduce((n, t) => n + r[t], 0);

/** A count sort orders by that count (`asc`: lowest first); ties break by the
 *  Total, highest first, then the newest. "Newest" and "Oldest" order by year,
 *  then the Total. Then the PMID, so the order is stable. `types` are the
 *  ticked ones: the Total adds up those columns only. */
export function sortReachPublications<T extends ReachPubCounts>(
  rows: readonly T[],
  sort: ReachSort,
  types: readonly ReachType[],
  asc = false,
): T[] {
  const total = (r: T) => reachTotal(r, types);
  const byTotal = (a: T, b: T) => total(b) - total(a);
  const newest = (a: T, b: T) => (b.year ?? 0) - (a.year ?? 0);
  const keys: ((a: T, b: T) => number)[] =
    sort === "year"
      ? [newest, byTotal]
      : sort === "oldest"
        ? [(a, b) => (a.year ?? 9999) - (b.year ?? 9999), byTotal]
        : [
            (a, b) => {
              const d = sort === "cited" ? byTotal(a, b) : b[sort] - a[sort];
              return asc ? -d : d;
            },
            byTotal,
            newest,
          ];
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const d = k(a, b);
      if (d) return d;
    }
    return a.pmid.localeCompare(b.pmid);
  });
}

/** Every publication in scope, cited or not: the "of M" in the first tile.
 *  The same scope as `loadScopePage`, which lists them.
 *
 *  `STRAIGHT_JOIN` pins the order as written, as in `okSql`: the publications
 *  under their own filters, then each one's authorships by index. It changes
 *  the plan and not the result. Left to itself MySQL drove this from a full
 *  scan of `publication_author` (measured on staging: `pa` type ALL, 299,227
 *  rows; 3.0 to 5.2 s for T0 and T1 with no year filter, 4.3 to 6.9 s for
 *  every stage), while the counts query beside it, driven from `publication`,
 *  answered the default view in under a second. Do not rewrite the authorship
 *  test as `EXISTS` or `IN (subquery)`: the optimizer turns either into a
 *  semi-join that scans `publication_author` first again (6 to 13 s). */
export async function loadScopeTotal(p: ReachParams): Promise<number> {
  const raw = await db.read.$queryRaw<{ n: Num }[]>`
    SELECT STRAIGHT_JOIN COUNT(DISTINCT p.pmid) AS n
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${policyScopeSql(p)}
       ${reachPubSql(p)}`;
  return Number(raw[0]?.n ?? 0);
}

/** One page of every publication in scope, newest first (`show=all`). Paged in
 *  SQL: this list can be several times the cited one. Counts are attached by
 *  the caller from `loadReachCounts`; a paper not in it has none. */
export async function loadScopePage(
  p: ReachParams,
  limit: number,
  offset: number,
): Promise<Pick<ReachPubCounts, "pmid" | "year" | "stage">[]> {
  const raw = await db.read.$queryRaw<
    { pmid: string; year: Num | null; stage: string | null; confidence: string | null }[]
  >`
    SELECT STRAIGHT_JOIN p.pmid AS pmid, MAX(p.year) AS year, MAX(p.translational_stage) AS stage,
           MAX(p.translational_stage_confidence) AS confidence
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${policyScopeSql(p)}
       ${reachPubSql(p)}
     GROUP BY p.pmid
     ORDER BY year DESC, p.pmid DESC
     LIMIT ${limit} OFFSET ${offset}`;
  return raw.map((r) => ({ pmid: r.pmid, year: num(r.year), stage: stageKeyOf(r.stage, r.confidence) }));
}

export type ReachPubRow = ReachPubCounts & PubDetails;

/** The rows of one page, or one sheet, with each publication's own columns
 *  and the authors the viewer may see (`loadPublicationDetails`, report 24's). */
export async function withReachPublicationDetails(
  p: ReachParams,
  rows: readonly ReachPubCounts[],
): Promise<ReachPubRow[]> {
  const pubs = await loadPublicationDetails(
    p,
    rows.map((r) => r.pmid),
  );
  return rows.map((r) => ({ ...r, ...(pubs.get(r.pmid) ?? { title: "", journal: null, doi: null, authors: [] }) }));
}

// ---------------------------------------------------------------------------
// Does the publication modal list exactly what a cell counts?
// ---------------------------------------------------------------------------

/** One paper's citing documents as the publication modal lists them: every
 *  link, own work included, and its lists' own units. */
export type ModalCounts = {
  /** Clinical articles (the modal pages these to the end). */
  clinical: number;
  /** Trial records (the modal sends the first `TRIAL_PATENT_CAP`). */
  trial: number;
  /** Inventions (the same cap). */
  patent: number;
  /** Guideline and policy documents, one per `dedup_key` at the policy
   *  levels: what the modal's "Guidelines and policy" tab counts. */
  policy: number;
  /** Systematic reviews, one per `dedup_key` (the modal lists the first
   *  `POLICY_REVIEWS_CAP`, under "Systematic reviews" in the same section). */
  review: number;
  /** One per `dedup_key` across every ranked level. The modal lists a
   *  `dedup_key` once, under whichever level it meets first, so when this is
   *  less than `policy + review` a document stands at both and neither group
   *  is known to list exactly its count. */
  ranked: number;
};

/** Which of the modal's groups are switched on, per type. */
export function modalGroupsOn(): Record<ReachType, boolean> {
  return {
    clinical: clinicalCitationsModalOn(),
    trial: trialCitationsModalOn(),
    policy: policyCitationBadgesOn(),
    review: policyCitationBadgesOn(),
    patent: patentCitationsModalOn(),
  };
}

/**
 * Whether the publication modal's section lists exactly the `shown` citing
 * documents of this type, to its end: the group is on, the modal's list is
 * not cut at its cap, and it holds nothing the count left out (the authors'
 * own work, which the modal lists and labels). When false, the cell links to
 * the Citing documents view filtered to the paper instead.
 */
export function modalListsExactly(
  type: ReachType,
  shown: number,
  modal: ModalCounts | undefined,
  on: Record<ReachType, boolean>,
): boolean {
  if (!modal || !on[type] || shown <= 0 || modal[type] !== shown) return false;
  if (type === "trial" || type === "patent") return modal[type] <= TRIAL_PATENT_CAP;
  if (type === "policy" || type === "review") {
    if (modal.ranked !== modal.policy + modal.review) return false;
    return type === "policy" || modal.review <= POLICY_REVIEWS_CAP;
  }
  return true;
}

/** `ModalCounts` for the rows on one page, per PMID, and only for
 *  publications the viewer may see (`scopedPubsSql`). Fifty papers' links by
 *  primary key. */
export async function loadModalCounts(p: ReachParams, pmids: readonly string[]): Promise<Map<string, ModalCounts>> {
  const out = new Map<string, ModalCounts>();
  if (pmids.length === 0) return out;
  const raw = await db.read.$queryRaw<
    { pmid: string; clinical: Num; trial: Num; patent: Num; policy: Num; review: Num; ranked: Num }[]
  >`
    SELECT ok.pmid,
           COUNT(DISTINCT CASE WHEN d.level = 'clinical' THEN d.id END) AS clinical,
           COUNT(DISTINCT CASE WHEN d.level = 'trial' THEN d.id END) AS trial,
           COUNT(DISTINCT CASE WHEN d.level = 'patent' THEN d.dedup_key END) AS patent,
           COUNT(DISTINCT CASE WHEN d.level IN (${Prisma.join([...REACH_LEVELS.policy])}) THEN d.dedup_key END) AS policy,
           COUNT(DISTINCT CASE WHEN d.level IN (${Prisma.join([...REACH_LEVELS.review])}) THEN d.dedup_key END) AS review,
           COUNT(DISTINCT CASE WHEN d.level IN (${Prisma.join([...REACH_LEVELS.policy, ...REACH_LEVELS.review])}) THEN d.dedup_key END) AS ranked
      FROM ${scopedPubsSql(p, pmids)}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE d.level IN (${Prisma.join(ALL_LEVELS)})
     GROUP BY ok.pmid`;
  for (const r of raw) {
    out.set(r.pmid, {
      clinical: Number(r.clinical),
      trial: Number(r.trial),
      patent: Number(r.patent),
      policy: Number(r.policy),
      review: Number(r.review),
      ranked: Number(r.ranked),
    });
  }
  return out;
}

/** The papers on a page the publication modal will not open: a publication
 *  taken down, or one whose every confirmed WCM author hid it. The public
 *  read answers these as unknown (`getPublicationDetail`), so their titles do
 *  not open the modal and their counts link to the Citing documents view. */
export async function loadModalHidden(pmids: readonly string[]): Promise<Set<string>> {
  if (pmids.length === 0) return new Set();
  return resolveDarkPmids(pmids, await loadPublicationSuppressions(pmids, db.read), db.read);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type ReachPersonRow = ReachCounts & {
  cwid: string;
  name: string;
  orgUnit: string | null;
  personType: string;
  institution: string;
  /** Their first- or senior-author papers in scope cited by a ticked type. */
  papers: number;
};

type PersonCols = {
  cwid: string;
  preferred_name: string;
  primary_department: string | null;
  role_category: string | null;
  primary_org_code: string | null;
};
const PERSON_COLS = Prisma.sql`s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code`;

/**
 * One row per scholar with at least `MIN_REACH_PAPERS` first- or
 * senior-author papers in scope cited by a ticked type, most papers first
 * (the portfolio report's person rules: counts only, no shares).
 *
 * `(pmid, cwid)` is unique among confirmed authorships, so counting rows is
 * counting papers. Each count is the length of the Publications view under
 * the same params narrowed to that person and `peoplePositions` (and, for a
 * type's column, to that type): the same scope clause builds both.
 *
 * Rollups (own work left out): counted in SQL off the rollup columns.
 *
 * Live (own work included): folded in Node from `counts`, the rows
 * `loadReachCounts` already fetched for this request, and one query for the
 * first- and senior-author authorships of the papers in scope that have a
 * link at all (a keyed probe; the links are not aggregated a second time).
 * `counts` is loaded here when the caller has none.
 */
export async function loadReachPeople(
  p: ReachParams,
  counts?: readonly ReachPubCounts[],
): Promise<ReachPersonRow[]> {
  const positions = peoplePositions(p);
  if (positions === null) return [];
  const types = tickedTypes(p);
  let raw: (PersonCols & CountCols & { papers: Num })[];
  if (usesRollups(p)) {
    raw = await db.read.$queryRaw<typeof raw>`
    SELECT STRAIGHT_JOIN ${PERSON_COLS},
           COUNT(*) AS papers,
           ${Prisma.join(
             REACH_TYPES.map(
               (t) => Prisma.sql`COUNT(CASE WHEN ${ROLLUP_COL[t]} > 0 THEN 1 END) AS ${Prisma.raw(`n_${t}`)}`,
             ),
             ", ",
           )}
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE ${citedSql(ROLLUP_COL, types)}
       AND ${policyScopeSql({ ...p, positions })}
       ${reachPubSql(p)}
     GROUP BY ${PERSON_COLS}
    HAVING COUNT(*) >= ${MIN_REACH_PAPERS}`;
  } else {
    const [listed, authorships] = await Promise.all([
      counts ?? loadReachCounts(p),
      db.read.$queryRaw<(PersonCols & { pmid: string })[]>`
    SELECT STRAIGHT_JOIN ${PERSON_COLS}, p.pmid AS pmid
      FROM publication p
      JOIN publication_author pa ON pa.pmid = p.pmid
      JOIN scholar s ON s.cwid = pa.cwid
     WHERE EXISTS (SELECT 1 FROM publication_citing_document l WHERE l.pmid = p.pmid)
       AND ${policyScopeSql({ ...p, positions })}
       ${reachPubSql(p)}`,
    ]);
    const byPmid = new Map(listedFor(listed, types).map((r) => [r.pmid, r]));
    const rows = new Map<string, PersonCols & CountCols & { papers: number }>();
    for (const a of authorships) {
      const c = byPmid.get(a.pmid);
      if (!c) continue;
      const r = rows.get(a.cwid) ?? { ...a, papers: 0, ...NO_COUNT_COLS };
      rows.set(a.cwid, r);
      r.papers += 1;
      for (const t of REACH_TYPES) if (c[t] > 0) r[`n_${t}`] = Number(r[`n_${t}`]) + 1;
    }
    raw = [...rows.values()].filter((r) => r.papers >= MIN_REACH_PAPERS);
  }
  return raw
    .map((r) => ({
      cwid: r.cwid,
      name: r.preferred_name,
      orgUnit: r.primary_department,
      personType: formatRoleCategory(r.role_category) ?? "",
      institution: r.primary_org_code ? institutionDisplayName(r.primary_org_code) : "",
      papers: Number(r.papers),
      ...toCounts(r),
    }))
    .sort((a, b) => b.papers - a.papers || a.name.localeCompare(b.name) || a.cwid.localeCompare(b.cwid));
}

// ---------------------------------------------------------------------------
// Citing documents
// ---------------------------------------------------------------------------

export type ReachDocCounts = {
  /** The document that stands for the row, and what a `doc` filter carries. */
  docId: number;
  level: string;
  type: ReachType;
  /** Its year: published, registered, or granted. */
  year: number | null;
  /** A patent row that is a published application, not a grant. */
  application: boolean;
  /** The listed papers in scope it cites. */
  papers: number;
};

/** `g`: one row per citing document of a ticked type citing a listed paper.
 *  `ok` is the papers in scope, one row each; their links are read by primary
 *  key. A document's `papers` is the length of the Publications view with that
 *  document added to `doc`.
 *
 *  With own work left out, `ok` is cut to the papers the rollups say a ticked
 *  type cites, so an uncited paper costs no link read. With own work counted
 *  the rollups cannot say, and need not: every link counts, so a paper in
 *  scope with a link at a ticked level is a listed paper, and the level test
 *  below is the whole "cited" test. Neither case evaluates the live counts. */
function docGroupsSql(p: ReachParams): Prisma.Sql {
  const types = tickedTypes(p);
  const levels = types.flatMap(levelsOf);
  return Prisma.sql`SELECT STRAIGHT_JOIN d.level AS level, ${UNIT_SQL} AS unit, COUNT(DISTINCT l.pmid) AS papers,
           MIN(${DOC_REP_SQL}) AS rep
      FROM ${okSql(p, usesRollups(p) ? { cited: citedSql(ROLLUP_COL, types) } : {})}
      JOIN publication_citing_document l ON l.pmid = ok.pmid
      JOIN citing_document d ON d.id = l.citing_document_id
     WHERE d.level IN (${Prisma.join(levels)})
       ${countedLinkSql(p)}
     GROUP BY d.level, unit`;
}

/** How many citing documents the view lists, on its own: only for a page past
 *  the end, which has no row to carry the total (`loadReachDocs`). */
export async function loadReachDocTotal(p: ReachParams): Promise<number> {
  const raw = await db.read.$queryRaw<{ n: Num }[]>`SELECT COUNT(*) AS n FROM (${docGroupsSql(p)}) g`;
  return Number(raw[0]?.n ?? 0);
}

/** One page (or one sheet) of the citing documents in the chosen order, and
 *  how many there are in all, from ONE evaluation of the grouping: each row
 *  carries the total (`COUNT(*) OVER ()`, taken before the `LIMIT`). Paged in
 *  SQL: the list can run to hundreds of thousands of clinical articles.
 *  Characters 2 to 5 of `rep` are the year ("9999" for none, which sorts
 *  last).
 *
 *  Not guarded here: a caller checks `docsTooWide` against the cited papers
 *  first, as `loadReach` does, and does not call this above the ceiling. */
export async function loadReachDocs(
  p: ReachParams,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: ReachDocCounts[] }> {
  const year = Prisma.sql`NULLIF(SUBSTRING(g.rep, 2, 4), '9999') DESC`;
  const order =
    p.docSort === "recent"
      ? Prisma.sql`${year}, g.papers DESC, g.rep`
      : Prisma.sql`g.papers DESC, ${year}, g.rep`;
  const raw = await db.read.$queryRaw<{ level: string; unit: string; papers: Num; rep: string; total: Num }[]>`
    SELECT g.level, g.unit, g.papers, g.rep, COUNT(*) OVER () AS total
      FROM (${docGroupsSql(p)}) g
     ORDER BY ${order}
     LIMIT ${limit} OFFSET ${offset}`;
  const rows = raw.flatMap((r) => {
    const type = reachTypeOfLevel(r.level);
    if (!type) return [];
    const rep = parseRep(String(r.rep));
    return [{ docId: rep.id, level: r.level, type, year: rep.year, application: rep.application, papers: Number(r.papers) }];
  });
  // No row, no total: nothing matches, or the page is past the end.
  const total = raw.length > 0 ? Number(raw[0].total) : offset > 0 ? await loadReachDocTotal(p) : 0;
  return { total, rows };
}

export type ReachDocRow = ReachDocCounts & {
  title: string;
  url: string;
  /** "Clinical guideline", "Registered trial", "Patent application"…. */
  kind: string;
  /** The journal, issuing body, registry id or patent number. */
  source: string | null;
};

/** What a row's type line says. */
export function docKind(d: Pick<ReachDocCounts, "type" | "level" | "application">): string {
  if (d.type === "policy" || d.type === "review") return LEVEL_ONE[d.level as Level] ?? REACH_TYPE_ONE[d.type];
  if (d.type === "patent" && d.application) return "Patent application";
  return REACH_TYPE_ONE[d.type];
}

/** The rows' own facts, for ids a scoped listing produced: nothing here
 *  depends on who the viewer is. In chunks, for the download. */
export async function withReachDocDetails(rows: readonly ReachDocCounts[]): Promise<ReachDocRow[]> {
  const facts = new Map<number, { title: string; url: string; source: string | null }>();
  for (let i = 0; i < rows.length; i += 5000) {
    const raw = await db.read.$queryRaw<
      {
        id: number;
        title: string;
        url: string;
        level: string;
        external_id: string;
        journal: string | null;
        journal_abbrev: string | null;
        issuing_body: string | null;
      }[]
    >`
      SELECT d.id, d.title, d.url, d.level, d.external_id, d.journal, d.journal_abbrev, d.issuing_body
        FROM citing_document d
       WHERE d.id IN (${Prisma.join(rows.slice(i, i + 5000).map((r) => r.docId))})`;
    for (const r of raw) {
      facts.set(Number(r.id), {
        title: r.title,
        url: r.url,
        source:
          r.level === "patent"
            ? (parsePatentId(r.external_id)?.display ?? r.external_id.toUpperCase())
            : r.level === "trial"
              ? r.external_id
              : (r.issuing_body ?? r.journal_abbrev ?? r.journal),
      });
    }
  }
  return rows.map((r) => ({ ...r, kind: docKind(r), ...(facts.get(r.docId) ?? { title: "", url: "", source: null }) }));
}

// ---------------------------------------------------------------------------
// The one loader the page and the download share
// ---------------------------------------------------------------------------

export type ReachData = {
  /** Every publication in scope, cited or not. */
  scopeTotal: number;
  /** Papers cited by each type, whatever is ticked. */
  typePapers: ReachCounts;
  /** Papers cited by a ticked type: what the Publications view lists. */
  pubTotal: number;
  /** What the pager runs over: `pubTotal`, less what the search drops; or
   *  `scopeTotal` under `show=all`. */
  pubMatched: number;
  /** `limit` of them from `offset`, counts only (no row details). */
  pubs: ReachPubCounts[];
  /** Citing documents listed; null when the view was not asked for, or was
   *  withheld (`docsWithheld`): no list, so no count. */
  docTotal: number | null;
  docs: ReachDocCounts[];
  /** Set when the Citing documents view was asked for and not computed because
   *  the selection is too wide (`docsTooWide`): the cited papers it covers,
   *  which is `pubTotal`. null otherwise. */
  docsWithheld: number | null;
  /** Every listed person (the search applied); null when not asked for. */
  people: ReachPersonRow[] | null;
  /** Every listed person, whatever the search: what the People tab counts,
   *  since its link drops the search. null when not asked for. */
  peopleTotal: number | null;
};

/**
 * Counts and listings, with no row details: the caller loads those for the
 * rows it shows. The page asks for its own tab (`views: [p.view]`); the
 * download for all three. `q` searches the tab it was typed on: publications
 * by title, PMID or author; people by name or CWID.
 *
 * The Citing documents and People listings each cost a query of their own, so
 * a view that is not asked for is not loaded, and its tab then carries no
 * count (a number is only shown with its list).
 *
 * The Citing documents listing waits for the counts: above
 * `REACH_DOCS_PAPER_CEILING` cited papers its query is not run at all
 * (`docsWithheld`).
 */
export async function loadReach(
  p: ReachParams,
  opts: { views: readonly ReachView[]; limit: number; offset?: number; docLimit?: number },
): Promise<ReachData> {
  const offset = opts.offset ?? 0;
  const want = (v: ReachView) => opts.views.includes(v);
  const types = tickedTypes(p);
  const everything = p.showAll && want("publications");
  // Fetched once: the People view, with own work counted, is folded from it,
  // and the Citing documents view is run only if these are few enough.
  const loadingCounts = loadReachCounts(p);
  const loadingDocs = !want("documents")
    ? null
    : loadingCounts.then((rows) =>
        docsTooWide(listedFor(rows, types).length)
          ? null
          : loadReachDocs(p, opts.docLimit ?? opts.limit, opts.docLimit ? 0 : offset),
      );
  const [counts, scopeTotal, hits, scopePage, docPage, people] = await Promise.all([
    loadingCounts,
    loadScopeTotal(p),
    p.q && p.view === "publications" && !p.showAll
      ? searchPublications(p, p.q, usesRollups(p) ? citedSql(ROLLUP_COL, types) : Prisma.sql`1 = 1`)
      : null,
    everything ? loadScopePage(p, opts.limit, offset) : null,
    loadingDocs,
    !want("people")
      ? null
      : usesRollups(p)
        ? loadReachPeople(p)
        : loadingCounts.then((rows) => loadReachPeople(p, rows)),
  ]);
  const listed = sortReachPublications(listedFor(counts, types), p.sort, types, p.asc);
  const matched = hits ? listed.filter((r) => hits.has(r.pmid)) : listed;
  const byPmid = new Map(counts.map((r) => [r.pmid, r]));
  const needle = p.view === "people" ? p.q.toLowerCase() : "";
  return {
    scopeTotal,
    typePapers: papersByType(counts),
    pubTotal: listed.length,
    pubMatched: scopePage ? scopeTotal : matched.length,
    pubs: scopePage
      ? scopePage.map((r) => ({ ...NO_COUNTS, ...byPmid.get(r.pmid), ...r }))
      : want("publications")
        ? matched.slice(offset, offset + opts.limit)
        : [],
    docTotal: docPage?.total ?? null,
    docs: docPage?.rows ?? [],
    docsWithheld: want("documents") && docPage === null ? listed.length : null,
    people:
      people === null
        ? null
        : people.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.cwid.toLowerCase() === needle),
    peopleTotal: people?.length ?? null,
  };
}

// ---------------------------------------------------------------------------
// Chips, criteria, workbook
// ---------------------------------------------------------------------------

/** The research areas the rail offers. */
export async function loadReachAreas(): Promise<{ id: string; label: string }[]> {
  return db.read.topic.findMany({ select: { id: true, label: true }, orderBy: { label: "asc" } });
}

/** The active filters as chips; the viewer's scope first, and not removable. */
export function reachChips(
  p: ReachParams,
  unitLabel: ReadonlyMap<string, string> = new Map(),
  personName: ReadonlyMap<string, string> = new Map(),
  areaLabel: ReadonlyMap<string, string> = new Map(),
): PolicyChip[] {
  const qs = (next: Partial<ReachParams>) => reachQueryString(p, next);
  const chips = whoChips(p, qs, unitLabel, personName);
  chips.push(
    ...(p.stages.length > 0
      ? facetChips("Stage", p.stages, stageKeyLabel, (keep) => qs({ stages: p.stages.filter(keep) }))
      : []),
    ...facetChips("Citing type", p.ctypes, (t) => REACH_TYPE_LABEL[t], (keep) => qs({ ctypes: p.ctypes.filter(keep) })),
  );
  if (p.includeOwn) {
    chips.push({ group: "Authors' own work", value: "Included", removeQuery: qs({ includeOwn: false }) });
  }
  if (p.area) {
    chips.push({ group: "Research area", value: areaLabel.get(p.area) ?? p.area, removeQuery: qs({ area: null }) });
  }
  const published = yearSpan(p.from, p.to, fiscalLabel(p));
  if (published) chips.push({ group: "Published", value: published, removeQuery: qs({ from: null, to: null }) });
  if (p.pmid) chips.push({ group: "Paper", value: `PMID ${p.pmid}`, removeQuery: qs({ pmid: null }) });
  for (const id of p.docs) {
    const ref = p.docRefs?.find((r) => r.id === id);
    chips.push({
      group: "Cited by",
      value: ref ? htmlToPlainText(ref.title, 80) : "Unknown citing document",
      removeQuery: qs({ docs: p.docs.filter((d) => d !== id) }),
    });
  }
  if (p.showAll) {
    chips.push({ group: "Listing", value: "Every publication in scope", removeQuery: qs({ showAll: false }) });
  }
  return chips;
}

export const REACH_COUNTING_RULE =
  "A publication is cited downstream when at least one citing document of a checked type cites it. A clinical study counts once per article; a registered trial, a guideline or policy document, a systematic review and a patent count once however many records or journals carry them, and related patents (one patent family) are one invention. Only ReCiter-confirmed authorships of active scholars count; person type, department, division, institution and center membership are the scholar's current values.";

/** What the two ranked types hold (decision 10): the sentence the About text
 *  and the Criteria sheet share. */
export const REACH_REVIEW_RULE =
  "Guidelines and policy counts health-authority documents, clinical guidelines and consensus statements. Systematic reviews are counted on their own: PubMed articles typed Systematic Review or Meta-Analysis (by publication type), as the policy import classifies them; one PubMed also types as a guideline or consensus statement counts under Guidelines and policy instead.";

export const REACH_OWN_WORK_RULE =
  "The authors' own work is a clinical article that shares a confirmed WCM author with the paper it cites, or a registered trial one of the paper's authors is an investigator on.";

export const REACH_STAGE_RULE =
  "ReCiterAI assigns a translational stage from the abstract or summary, and nobody reviews the stages by hand. A stage counts only when the model was not unsure; everything else is under No stage. A later stage is not a better one.";

export const REACH_PEOPLE_RULE = `The People view counts publications where the scholar is first or senior author and lists only scholars with at least ${MIN_REACH_PAPERS}, ordered by count.`;

export const REACH_SOURCES =
  "Sources: NIH iCite's clinical flag with article details from PubMed (clinical studies), ClinicalTrials.gov (registered trials), NCBI Bookshelf and PubMed (guidelines and policy), PubMed (systematic reviews), and Reliance on Science (Marx and Fuegi), CC BY-NC 4.0, with patent details from USPTO PatentsView (patents, US only). A patent citing a paper does not mean the paper's authors hold the patent.";

const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");

/** The Criteria sheet, verbatim: every filter, "All" when unset. */
export function describeReachCriteria(
  p: ReachParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
  areaLabel: ReadonlyMap<string, string> = new Map(),
): [string, string][] {
  return [
    ["Report", "27. Downstream reach"],
    ["Generated", generatedAt.toISOString()],
    ...whoCriteria(p, labels),
    ...pubYearCriteria(p),
    ["Translational stage of the cited paper", list(p.stages.map(stageKeyLabel))],
    ["Citing type", list(p.ctypes.map((t) => REACH_TYPE_LABEL[t]))],
    ["Authors' own work", p.includeOwn ? "Counted" : "Left out"],
    ["Research area", p.area ? (areaLabel.get(p.area) ?? p.area) : "All"],
    ["Paper (PMID)", p.pmid ?? "All"],
    [
      "Cited by (citing document)",
      list(p.docs.map((id) => p.docRefs?.find((r) => r.id === id)?.title ?? `Unknown citing document ${id}`)),
    ],
    [
      "Order",
      `${REACH_SORT_LABEL[p.sort]}${p.asc && isCountSort(p.sort) ? ", lowest first" : ""} (publications); ${REACH_DOC_SORT_LABEL[p.docSort].toLowerCase()} (citing documents)`,
    ],
    ...(p.q ? ([[p.view === "people" ? "Search (people)" : "Search (publications)", p.q]] as [string, string][]) : []),
    ["Counting rule", REACH_COUNTING_RULE],
    ["Citing types", REACH_REVIEW_RULE],
    ["Own work", REACH_OWN_WORK_RULE],
    ["Stage rule", REACH_STAGE_RULE],
    ["People rule", REACH_PEOPLE_RULE],
    ["Sources", REACH_SOURCES.replace(/^Sources: /, "")],
  ];
}

const plain = (s: string) => htmlToPlainText(s, Number.POSITIVE_INFINITY);
const sheetNote = (shown: number, total: number, what: string, cap: number) =>
  total > shown
    ? `Lists the first ${shown.toLocaleString()} of ${total.toLocaleString()} ${what} in the order above (the limit is ${cap.toLocaleString()}). Narrow the filters to list the rest.`
    : `Lists all ${total.toLocaleString()} ${what} (the limit is ${cap.toLocaleString()}).`;

/** The one line the Citing documents sheet, and its Criteria row, carry when
 *  the listing was withheld. */
export const docsWithheldNote = (citedPapers: number): string =>
  `Not listed: this selection is too wide to list citing documents. It covers ${citedPapers.toLocaleString()} cited publications (the Publications sheet), and citing documents are listed for at most ${REACH_DOCS_PAPER_CEILING.toLocaleString()}. ${REACH_DOCS_NARROW_HINT}`;

/**
 * The workbook: Publications, Citing documents, People, Criteria.
 *
 * Above `REACH_DOCS_PAPER_CEILING` the Citing documents sheet carries one note
 * and no rows (`docsWithheldNote`), and the Criteria sheet says the same.
 *
 * The People sheet lists EVERY matching person. This is report 24's decided,
 * named exception to the 50-scholar export cap (`SCHOLAR_EXPORT_CAP`,
 * `lib/api/export-scholars.ts`, which is left as it is), extended to this
 * report's People view by the report owner on 2026-11-26 (plan decision 3:
 * "a named exception on this route only; the shared cap is unchanged"). The
 * sheet carries name, CWID, org unit, person type, primary institution and
 * the counts, and no contact details.
 */
export async function buildReachWorkbook(
  p: ReachParams,
  data: {
    pubs: ReachPubRow[];
    pubTotal: number;
    docs: ReachDocRow[];
    docTotal: number;
    /** `ReachData.docsWithheld`: the sheet then carries a note and no rows. */
    docsWithheld?: number | null;
    people: ReachPersonRow[];
  },
  generatedAt: Date,
  labels?: ReadonlyMap<string, string>,
  areaLabel?: ReadonlyMap<string, string>,
  /** One more sheet, added after People, and its Criteria rows: the
   *  Connections sheet (`connectionsSheet`), when the download is taken from
   *  that view with one scholar. */
  extra?: { addSheet: (wb: ExcelJS.Workbook) => void; criteria: [string, string][] },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const types = tickedTypes(p);
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
    ["PMID", "Title", "Journal", "Year", "Stage", "WCM authors", "Total", ...types.map((t) => REACH_TYPE_LABEL[t]), "DOI"],
    [12, 70, 30, 8, 30, 40, 10, ...types.map(() => 14), 28],
  );
  for (const r of data.pubs) {
    pubs.addRow([
      r.pmid,
      plain(r.title),
      r.journal ? plain(r.journal) : r.journal,
      r.year,
      stageKeyLabel(r.stage),
      r.authors.map((a) => `${a.name} (${a.position} author)`).join("; "),
      reachTotal(r, types),
      ...types.map((t) => r[t]),
      r.doi,
    ]);
  }
  pubs.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  pubs.getColumn(6).alignment = { wrapText: true, vertical: "top" };

  const docs = sheet(
    "Citing documents",
    ["Citing document", "Type", "Journal, body or number", "Year", "WCM papers cited", "Link"],
    [70, 26, 36, 8, 14, 46],
  );
  const withheld = data.docsWithheld ?? null;
  if (withheld !== null) {
    // No rows and no count of them: one line saying why.
    docs.addRow([docsWithheldNote(withheld)]);
  } else {
    for (const d of data.docs) {
      docs.addRow([plain(d.title), d.kind, d.source ? plain(d.source) : d.source, d.year, d.papers, d.url]);
    }
  }
  docs.getColumn(1).alignment = { wrapText: true, vertical: "top" };

  const people = sheet(
    "People",
    [
      "Name",
      "CWID",
      "Org unit",
      "Person type",
      "Primary institution",
      "Papers cited downstream",
      ...types.map((t) => `Papers ${REACH_TYPE_CITED[t]}`),
    ],
    [28, 10, 30, 22, 28, 16, ...types.map(() => 16)],
  );
  for (const r of data.people) {
    people.addRow([r.name, r.cwid, r.orgUnit, r.personType, r.institution, r.papers, ...types.map((t) => r[t])]);
  }

  extra?.addSheet(wb);

  addCriteriaSheet(wb, [
    ...describeReachCriteria(p, generatedAt, labels, areaLabel),
    ["Publications sheet", sheetNote(data.pubs.length, data.pubTotal, "publications", REACH_LIST_CAP)],
    [
      "Citing documents sheet",
      withheld !== null
        ? docsWithheldNote(withheld)
        : `One row per citing document of the types above. ${sheetNote(data.docs.length, data.docTotal, "citing documents", REACH_DOCS_CAP)}`,
    ],
    [
      "People sheet",
      `Lists all ${data.people.length.toLocaleString()} people, with no contact details. This report follows report 24's exemption from the 50-person limit on scholar exports (extended to this report 2026-11-26).`,
    ],
    ...(extra?.criteria ?? []),
  ]);

  return workbookBuffer(wb);
}
