/**
 * Report 27's fourth view, "Connections": colleagues who cite one scholar's
 * work, or whose work the scholar cites, and who have never co-authored with
 * them (plan step 5). Reads `publication_citation` (filled by
 * `etl/citation-links`: both ends are Scholars publications, self-citations
 * left out) and the authorship tables; writes nothing. Behind the report's
 * flag and access rule (`DOWNSTREAM_REACH_REPORT`,
 * `canViewDownstreamReachReport`).
 *
 * THE PAIRING RULE (plan decision 7; `foldConnections` and the SQL below are
 * the whole of it). A connection is an ordered pair (cited scholar A, citing
 * scholar B), A != B, made of paper pairs (cited paper X, citing paper Y),
 * one per `publication_citation` row, where:
 *   - A is a confirmed first or senior author of X, and B of Y (the People
 *     view's first-or-senior rule, `peoplePositions` with no `pos` filter);
 *   - A and B are both active, and share no publication (no paper on which
 *     both are confirmed authors, in any position or year);
 *   - and there are at least `MIN_CONNECTION_PAPERS` distinct citing papers Y.
 * X and Y need not have a translational stage, and their stages need not
 * differ: each paper's stage, and each colleague's stage mix, are shown as
 * context only. The count shown is the number of distinct citing papers Y,
 * and the pairs list it opens has one row per Y (with the cited papers X it
 * cites beside it), so the count is the list's length.
 *
 * Why stage is not in the rule (decision 7, 2026-11-28). The first rule asked
 * for X and Y to have displayed stages that differ. Measured on staging on
 * 2026-11-28, only 33,339 of 205,126 publications have a displayed stage, and
 * that rule produced 1 qualifying pair in all of staging; without the stage
 * clause there are 1,956 pairs for 739 cited scholars. Stage can return as a
 * filter once coverage improves.
 *
 * The view needs one scholar S (the `person` filter). "Cite S's work" lists
 * pairs with A = S (direction `cited`); "S cites" lists pairs with B = S
 * (`cites`). The report's years, stage and research area apply to the cited
 * paper X, exactly as on the other views (`citedPaperSql`), so the report's
 * default stage filter (T0 and T1) narrows X unless the viewer widens it; Y
 * is never filtered by stage or year. Its person-type and unit filters apply
 * to the cited scholar A, as the author of X. The citing-type filter and the
 * own-work toggle are about clinical and policy documents, not about Scholars
 * papers citing each other, so they do not apply here; `pos`, `pmid` and
 * `doc` do not apply either, and `parseReachParams` drops them on this view so
 * no chip names them.
 *
 * Access. The viewer must be able to open report 27, and a unit-scoped viewer
 * may open the view only for a scholar inside their units, as the People view
 * would list them (`scholarSql`). The colleagues listed come from anywhere:
 * the viewer's units are not applied to the other end (plan decision 8,
 * 2026-11-28).
 *
 * Query cost. `publication_citation` holds about 0.7 to 2 million rows, so
 * every query here is driven from the one selected scholar's first- or
 * senior-author papers (a few hundred at most) under `STRAIGHT_JOIN`:
 *   1. their authorships by `publication_author (cwid, is_confirmed)`, then
 *      each paper by primary key;
 *   2. `publication_citation` by its primary key `(cited_pmid, citing_pmid)`
 *      for `cited`, or its index `(citing_pmid, cited_pmid)` for `cites`: a
 *      pmid predicate always, never a scan of the link table;
 *   3. the paper at the other end by primary key, and its first- or senior
 *      authors by `publication_author (pmid)`;
 *   4. the no-shared-publication test once per request, over the candidate
 *      scholars that passed the minimum (`coauthorsSql`): the selected
 *      scholar's own authorships, then each paper's co-authors by pmid, cut to
 *      the candidates. It is an anti-join done once per candidate scholar,
 *      never per link.
 * No `EXISTS` or `IN (subquery)` tests authorship anywhere here: on staging
 * the optimizer turned those into a full scan of `publication_author`
 * (`loadScopeTotal`'s comment). No new index: each step above is a lookup on
 * an index that already exists.
 *
 * Server-only (`@/lib/db`).
 */
import type ExcelJS from "exceljs";

import { db } from "@/lib/db";
import {
  citedPaperSql,
  reachPubSql,
  reachQueryString,
  stageKeyOf,
  type ConnectionDir,
  type ReachParams,
} from "@/lib/edit/downstream-reach-report";
import { personFilterSql } from "@/lib/edit/person-filter";
import { policyScopeSql, viewerScopeSql } from "@/lib/edit/policy-citations-report";
import { boldRow } from "@/lib/edit/report-xlsx";
import { Prisma } from "@/lib/generated/prisma/client";
import { institutionDisplayName } from "@/lib/institutions";
import { formatRoleCategory } from "@/lib/role-display";
import { displayStage, type TranslationalStage } from "@/lib/translational-stage";

/**
 * A pair of scholars is listed only with at least this many distinct citing
 * papers (plan step 5: "at least 3 citing papers"). One or two citations
 * between people who never wrote together is too thin to call a connection;
 * three is also the People view's minimum (`MIN_REACH_PAPERS`).
 */
export const MIN_CONNECTION_PAPERS = 3;

export const CONNECTIONS_RULE = `A connection is a colleague who cites the scholar's work, or whose work the scholar cites, and who has never been a co-author with them. Each pair of papers is a citation between two Scholars publications where each scholar is first or senior author of their own paper. The papers need not have a translational stage; each colleague's papers by stage are shown for context. Both scholars are active and share no publication in any author position or year. A colleague is listed with at least ${MIN_CONNECTION_PAPERS} citing papers, and the count is the number of distinct citing papers.`;

export const CONNECTIONS_FILTER_NOTE =
  "The report's years, stage and research area apply to the cited paper only (so the default stage filter, T0 and T1, limits the cited papers unless you widen it); the citing paper is not filtered by stage or year. The report's person type and unit apply to the cited scholar. The citing-type filter and the own-work setting do not apply to this view, and the position, paper and citing-document filters are cleared on it. The colleagues listed may be in any unit, also for a viewer limited to some units.";

// ---------------------------------------------------------------------------
// The fold: the pairing rule over link rows
// ---------------------------------------------------------------------------

/** One `publication_citation` row joined to an authorship at each end, as
 *  the link query returns it: X is cited, Y cites it, `other` is the scholar
 *  at the end that is not the selected one. */
export type ConnectionLink = {
  x: string;
  xYear: number | null;
  xStage: string | null;
  xConfidence: string | null;
  y: string;
  yYear: number | null;
  yStage: string | null;
  yConfidence: string | null;
  other: string;
};

/** `stage` is the displayed stage (`displayStage`), or null: context only. */
export type ConnectionPaper = { pmid: string; year: number | null; stage: TranslationalStage | null };

/** One row of a pairs list: a citing paper and the cited papers it cites. */
export type ConnectionPair = { citing: ConnectionPaper; cited: ConnectionPaper[] };

export type ConnectionGroup = {
  cwid: string;
  /** One per distinct citing paper, newest first: what the count counts. */
  pairs: ConnectionPair[];
};

const newestFirst = (a: ConnectionPaper, b: ConnectionPaper) =>
  (b.year ?? 0) - (a.year ?? 0) || b.pmid.localeCompare(a.pmid, undefined, { numeric: true });

/**
 * The pairing rule over link rows for one scholar (`self`), in one direction.
 * Keeps a paper pair whatever the two papers' stages (decision 7), when the
 * other end is someone else; groups by the other scholar, one pair per
 * distinct citing paper; keeps a group with at least `MIN_CONNECTION_PAPERS`
 * of them. The SQL already leaves out the selected scholar at the other end;
 * this is where the rule is stated once, and what the tests hold it to. The
 * no-shared-publication test is applied after (`dropCoauthors`), since it
 * removes whole scholars.
 */
export function foldConnections(links: readonly ConnectionLink[], self: string): ConnectionGroup[] {
  const byOther = new Map<
    string,
    Map<string, { citing: ConnectionPaper; cited: Map<string, ConnectionPaper> }>
  >();
  for (const l of links) {
    if (l.other === self || l.x === l.y) continue;
    const xStage = displayStage(l.xStage, l.xConfidence);
    const yStage = displayStage(l.yStage, l.yConfidence);
    const ys = byOther.get(l.other) ?? new Map();
    byOther.set(l.other, ys);
    const pair = ys.get(l.y) ?? {
      citing: { pmid: l.y, year: l.yYear, stage: yStage },
      cited: new Map(),
    };
    ys.set(l.y, pair);
    pair.cited.set(l.x, { pmid: l.x, year: l.xYear, stage: xStage });
  }
  return [...byOther]
    .filter(([, ys]) => ys.size >= MIN_CONNECTION_PAPERS)
    .map(([cwid, ys]) => ({
      cwid,
      pairs: [...ys.values()]
        .map((p) => ({ citing: p.citing, cited: [...p.cited.values()].sort(newestFirst) }))
        .sort((a, b) => newestFirst(a.citing, b.citing)),
    }));
}

/** The no-shared-publication rule: drop every scholar who co-authored with
 *  the selected one. */
export function dropCoauthors(
  groups: readonly ConnectionGroup[],
  coauthors: ReadonlySet<string>,
): ConnectionGroup[] {
  return groups.filter((g) => !coauthors.has(g.cwid));
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const raw = Prisma.raw;
/** A confirmed first or senior authorship, on a `publication_author` alias. */
const firstOrSeniorSql = (a: string): Prisma.Sql =>
  Prisma.sql`${raw(a)}.is_confirmed = 1 AND (${raw(a)}.is_first = 1 OR ${raw(a)}.is_last = 1)`;
/** An active scholar, on a `scholar` alias (report 27's rule, `policyScopeSql`). */
const activeSql = (a: string): Prisma.Sql =>
  Prisma.sql`${raw(a)}.deleted_at IS NULL AND ${raw(a)}.status = 'active'`;

/**
 * The link rows for scholar `cwid` in one direction. X, the cited paper, is
 * always `p`, since the report's paper filters are written on `p`
 * (`citedPaperSql`); Y, the citing paper, is `y`. `pa_s` / `s` are the
 * selected scholar's authorship and row; `pa_o` / `o` the other end's.
 *
 * `cited` (A = the scholar): their papers, then the papers citing each one by
 * the link table's primary key (`c.cited_pmid = p.pmid`), then those papers'
 * first and senior authors. `cites` (B = the scholar): their papers, then the
 * papers each one cites by the `(citing_pmid, cited_pmid)` index
 * (`c.citing_pmid = y.pmid`), then those papers' first and senior authors.
 * The person-type and unit filters go on A: `s` for `cited`, `o` for `cites`.
 * The report's years, stage and research area go on X (`p`) alone; Y has no
 * stage or year condition (decision 7). A unit-scoped viewer's units are not
 * applied to `o`: the gate puts them on the selected scholar (`scholarSql`),
 * and the colleagues listed come from anywhere (decision 8).
 */
export function connectionLinksSql(p: ReachParams, cwid: string, dir: ConnectionDir): Prisma.Sql {
  const from =
    dir === "cited"
      ? Prisma.sql`FROM publication_author pa_s
      JOIN scholar s ON s.cwid = pa_s.cwid
      JOIN publication p ON p.pmid = pa_s.pmid
      JOIN publication_citation c ON c.cited_pmid = p.pmid
      JOIN publication y ON y.pmid = c.citing_pmid
      JOIN publication_author pa_o ON pa_o.pmid = y.pmid
      JOIN scholar o ON o.cwid = pa_o.cwid`
      : Prisma.sql`FROM publication_author pa_s
      JOIN scholar s ON s.cwid = pa_s.cwid
      JOIN publication y ON y.pmid = pa_s.pmid
      JOIN publication_citation c ON c.citing_pmid = y.pmid
      JOIN publication p ON p.pmid = c.cited_pmid
      JOIN publication_author pa_o ON pa_o.pmid = p.pmid
      JOIN scholar o ON o.cwid = pa_o.cwid`;
  const who = personFilterSql(
    { types: p.types, unitValues: p.units },
    { scholar: dir === "cited" ? "s" : "o", centerMembership: "cm" },
  );
  return Prisma.sql`SELECT STRAIGHT_JOIN p.pmid AS x_pmid, p.year AS x_year,
           p.translational_stage AS x_stage, p.translational_stage_confidence AS x_confidence,
           y.pmid AS y_pmid, y.year AS y_year,
           y.translational_stage AS y_stage, y.translational_stage_confidence AS y_confidence,
           pa_o.cwid AS other
      ${from}
     WHERE pa_s.cwid = ${cwid} AND ${firstOrSeniorSql("pa_s")} AND ${activeSql("s")}
       ${citedPaperSql(p)}
       AND ${firstOrSeniorSql("pa_o")} AND pa_o.cwid <> ${cwid} AND ${activeSql("o")}
       ${who}`;
}

/** Which of `candidates` share a publication with scholar `cwid` (both
 *  confirmed authors, any position, any year): the scholar's authorships,
 *  then each paper's co-authors by pmid, cut to the candidates. Run once per
 *  request over every candidate of both lists. */
export function coauthorsSql(cwid: string, candidates: readonly string[]): Prisma.Sql {
  return Prisma.sql`SELECT STRAIGHT_JOIN pa_o.cwid AS cwid
      FROM publication_author pa_s
      JOIN publication_author pa_o ON pa_o.pmid = pa_s.pmid
     WHERE pa_s.cwid = ${cwid} AND pa_s.is_confirmed = 1
       AND pa_o.is_confirmed = 1 AND pa_o.cwid IN (${Prisma.join([...candidates])})
     GROUP BY pa_o.cwid`;
}

/** The selected scholar, if active and inside the viewer's units: the gate. */
function scholarSql(p: Pick<ReachParams, "scope">, cwid: string): Prisma.Sql {
  return Prisma.sql`SELECT s.cwid, s.preferred_name
      FROM scholar s
     WHERE s.cwid = ${cwid} AND ${activeSql("s")}
       ${viewerScopeSql(p)}`;
}

type Num = bigint | number;
const num = (v: Num | null): number | null => (v === null ? null : Number(v));

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

export type ConnectionRow = {
  cwid: string;
  name: string;
  orgUnit: string | null;
  personType: string;
  institution: string;
  /** Distinct citing papers: `pairs.length`. */
  papers: number;
  pairs: ConnectionPair[];
};

export type ReachConnections =
  /** No single scholar in `person`: the view asks for one. */
  | { status: "pick" }
  /** The scholar is not active, or is outside the viewer's units. */
  | { status: "unavailable"; cwid: string }
  | {
      status: "ok";
      scholar: { cwid: string; name: string };
      /** "Cite S's work": colleagues whose papers cite the scholar's. */
      cited: ConnectionRow[];
      /** "S cites": colleagues whose papers the scholar's cite. */
      cites: ConnectionRow[];
    };

/** The one scholar the view is for, or null. */
export const connectionsScholar = (p: Pick<ReachParams, "people">): string | null =>
  p.people.length === 1 ? p.people[0] : null;

async function loadLinks(
  p: ReachParams,
  cwid: string,
  dir: ConnectionDir,
): Promise<ConnectionLink[]> {
  const rows = await db.read.$queryRaw<
    {
      x_pmid: string;
      x_year: Num | null;
      x_stage: string | null;
      x_confidence: string | null;
      y_pmid: string;
      y_year: Num | null;
      y_stage: string | null;
      y_confidence: string | null;
      other: string;
    }[]
  >`${connectionLinksSql(p, cwid, dir)}`;
  return rows.map((r) => ({
    x: r.x_pmid,
    xYear: num(r.x_year),
    xStage: r.x_stage,
    xConfidence: r.x_confidence,
    y: r.y_pmid,
    yYear: num(r.y_year),
    yStage: r.y_stage,
    yConfidence: r.y_confidence,
    other: r.other,
  }));
}

/**
 * Both lists for the scholar in `person`, every row (the caller pages them),
 * each sorted by citing papers, then name. `p.scope` must be resolved
 * (`resolveReachParams`); a viewer with no units gets "unavailable".
 * `dirs` loads one list only (the other comes back empty): the Bibliometrics
 * line counts "Cite S's work" alone. A list's rows do not depend on the other
 * list, since the co-author test removes whole scholars.
 */
export async function loadReachConnections(
  p: ReachParams,
  dirs: readonly ConnectionDir[] = ["cited", "cites"],
): Promise<ReachConnections> {
  const cwid = connectionsScholar(p);
  if (cwid === null) return { status: "pick" };
  if (p.scope !== null && p.scope.length === 0) return { status: "unavailable", cwid };
  const found = await db.read.$queryRaw<
    { cwid: string; preferred_name: string }[]
  >`${scholarSql(p, cwid)}`;
  if (found.length === 0) return { status: "unavailable", cwid };

  const load = (dir: ConnectionDir) =>
    dirs.includes(dir) ? loadLinks(p, cwid, dir) : Promise.resolve([]);
  const [citedLinks, citesLinks] = await Promise.all([load("cited"), load("cites")]);
  const folded = {
    cited: foldConnections(citedLinks, cwid),
    cites: foldConnections(citesLinks, cwid),
  };
  const candidates = [...new Set([...folded.cited, ...folded.cites].map((g) => g.cwid))];
  const coauthors =
    candidates.length === 0
      ? new Set<string>()
      : new Set(
          (await db.read.$queryRaw<{ cwid: string }[]>`${coauthorsSql(cwid, candidates)}`).map(
            (r) => r.cwid,
          ),
        );
  const kept = {
    cited: dropCoauthors(folded.cited, coauthors),
    cites: dropCoauthors(folded.cites, coauthors),
  };
  const listed = [...new Set([...kept.cited, ...kept.cites].map((g) => g.cwid))];
  const people =
    listed.length === 0
      ? []
      : await db.read.$queryRaw<
          {
            cwid: string;
            preferred_name: string;
            primary_department: string | null;
            role_category: string | null;
            primary_org_code: string | null;
          }[]
        >`
    SELECT s.cwid, s.preferred_name, s.primary_department, s.role_category, s.primary_org_code
      FROM scholar s
     WHERE s.cwid IN (${Prisma.join(listed)})`;
  const byCwid = new Map(people.map((r) => [r.cwid, r]));
  const rows = (groups: ConnectionGroup[]): ConnectionRow[] =>
    groups
      .map((g) => {
        const s = byCwid.get(g.cwid);
        return {
          cwid: g.cwid,
          name: s?.preferred_name ?? g.cwid,
          orgUnit: s?.primary_department ?? null,
          personType: formatRoleCategory(s?.role_category ?? null) ?? "",
          institution: s?.primary_org_code ? institutionDisplayName(s.primary_org_code) : "",
          papers: g.pairs.length,
          pairs: g.pairs,
        };
      })
      .sort(
        (a, b) =>
          b.papers - a.papers || a.name.localeCompare(b.name) || a.cwid.localeCompare(b.cwid),
      );
  return {
    status: "ok",
    scholar: { cwid, name: found[0].preferred_name },
    cited: rows(kept.cited),
    cites: rows(kept.cites),
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * The report 27 params behind one stage-mix count: the colleague's first- or
 * senior-author papers at that stage in the report's years, every one of them
 * (`show=all`), in the Publications view. Their own portfolio, so the
 * report's unit, person-type and research-area filters are not carried.
 */
export function stageMixParams(
  p: ReachParams,
  cwid: string,
  stage: TranslationalStage,
): ReachParams {
  return {
    ...p,
    view: "publications",
    people: [cwid],
    positions: ["first", "last"],
    stages: [stage],
    types: [],
    units: [],
    area: null,
    pmid: null,
    docs: [],
    docRefs: [],
    ctypes: [],
    includeOwn: false,
    showAll: true,
    sort: "cited",
    docSort: "papers",
    q: "",
    page: 1,
    with: null,
    dir: "cited",
  };
}

/** The query string behind every number in the view. */
export function connectionLinks(p: ReachParams) {
  const qs = (over: Partial<ReachParams>) =>
    reachQueryString(p, { q: "", showAll: false, ...over });
  return {
    /** The two lists. */
    lists: () => qs({ view: "connections", with: null }),
    /** A row's count: the pairs list for that colleague, in that direction. */
    pairs: (cwid: string, dir: ConnectionDir) => qs({ view: "connections", with: cwid, dir }),
    /** A stage-mix count: report 27's Publications view (`stageMixParams`). */
    stageMix: (cwid: string, stage: TranslationalStage) =>
      reachQueryString(stageMixParams(p, cwid, stage)),
  };
}

export type StageMix = Partial<Record<TranslationalStage, number>>;

/**
 * The stage mix of each colleague: their first- or senior-author papers per
 * displayed stage, each the length of the list `connectionLinks.stageMix`
 * opens (that view's `loadScopeTotal`, with the same scope clause: for a
 * unit-scoped viewer a colleague outside their units has no papers there, so
 * no mix is shown for them). One grouped query for the colleagues on a page,
 * driven from `scholar` by primary key, then each one's authorships by the
 * `cwid` index.
 */
export async function loadConnectionStageMix(
  p: ReachParams,
  cwids: readonly string[],
): Promise<Map<string, StageMix>> {
  const out = new Map<string, StageMix>();
  if (cwids.length === 0) return out;
  const mix = { ...stageMixParams(p, cwids[0], "T0"), people: [...cwids], stages: [] };
  const rows = await db.read.$queryRaw<
    { cwid: string; stage: string | null; confidence: string | null; n: Num }[]
  >`
    SELECT STRAIGHT_JOIN s.cwid AS cwid, p.translational_stage AS stage,
           p.translational_stage_confidence AS confidence, COUNT(DISTINCT p.pmid) AS n
      FROM scholar s
      JOIN publication_author pa ON pa.cwid = s.cwid
      JOIN publication p ON p.pmid = pa.pmid
     WHERE ${policyScopeSql(mix)}
       ${reachPubSql(mix)}
     GROUP BY s.cwid, p.translational_stage, p.translational_stage_confidence`;
  for (const r of rows) {
    const key = stageKeyOf(r.stage, r.confidence);
    if (key === "none") continue;
    const m = out.get(r.cwid) ?? {};
    out.set(r.cwid, m);
    m[key] = (m[key] ?? 0) + Number(r.n);
  }
  return out;
}

/** Titles and journals for the papers on one page of a pairs list. Public
 *  facts about a paper, so not scoped. */
export async function loadConnectionPapers(
  pmids: readonly string[],
): Promise<Map<string, { title: string; journal: string | null }>> {
  if (pmids.length === 0) return new Map();
  const rows = await db.read.$queryRaw<{ pmid: string; title: string; journal: string | null }[]>`
    SELECT p.pmid, p.title, p.journal
      FROM publication p
     WHERE p.pmid IN (${Prisma.join([...pmids])})`;
  return new Map(rows.map((r) => [r.pmid, { title: r.title, journal: r.journal }]));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const connectionsListLabel = (dir: ConnectionDir, name: string): string =>
  dir === "cited" ? `Cite ${name}'s work` : `${name} cites`;

/**
 * The Connections sheet and its Criteria rows, for `buildReachWorkbook`'s
 * `extra`: both directions, one row per pair of scholars, every row. A list
 * of scholars is a scholar export; this sheet falls under the same named
 * exception to the 50-scholar cap (`SCHOLAR_EXPORT_CAP`,
 * `lib/api/export-scholars.ts`) as report 27's People sheet (plan decision 3,
 * 2026-11-26, extended to this sheet by decision 9, 2026-11-28). The
 * exception covers the People and Connections sheets of report 27's download
 * route only. Name, CWID, org unit, person type, primary institution and the
 * counts, with the PMIDs behind each count; no contact details.
 */
export function connectionsSheet(c: Extract<ReachConnections, { status: "ok" }>): {
  addSheet: (wb: ExcelJS.Workbook) => void;
  criteria: [string, string][];
} {
  const name = c.scholar.name;
  return {
    addSheet: (wb) => {
      const ws = wb.addWorksheet("Connections");
      ws.addRow([
        "List",
        "Name",
        "CWID",
        "Org unit",
        "Person type",
        "Primary institution",
        "Citing papers",
        "Cited papers",
        "Citing PMIDs",
        "Cited PMIDs",
      ]);
      boldRow(ws, 1);
      ws.views = [{ state: "frozen", ySplit: 1 }];
      for (const [i, w] of [24, 28, 10, 30, 22, 28, 12, 12, 40, 40].entries())
        ws.getColumn(i + 1).width = w;
      for (const dir of ["cited", "cites"] as const) {
        for (const r of c[dir]) {
          const cited = [...new Set(r.pairs.flatMap((x) => x.cited.map((y) => y.pmid)))];
          ws.addRow([
            connectionsListLabel(dir, name),
            r.name,
            r.cwid,
            r.orgUnit,
            r.personType,
            r.institution,
            r.papers,
            cited.length,
            r.pairs.map((x) => x.citing.pmid).join("; "),
            cited.join("; "),
          ]);
        }
      }
    },
    criteria: [
      ["Connections scholar", `${name} (${c.scholar.cwid})`],
      ["Connections rule", CONNECTIONS_RULE],
      ["Connections filters", CONNECTIONS_FILTER_NOTE],
      [
        "Connections sheet",
        `Lists all ${c.cited.length.toLocaleString()} colleagues who cite ${name}'s work and all ${c.cites.length.toLocaleString()} whose work ${name} cites, one row per pair, with no contact details. Citing papers is the count shown on the page. Like the People sheet, this sheet is exempt from the 50-person limit on scholar exports (decided 2026-11-28).`,
      ],
    ],
  };
}
