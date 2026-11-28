/** Report 27 (Downstream reach): the param parser and its defaults, the flag
 *  gate (index, page, download; no query with the flag off), where the counts
 *  come from (rollups by default, the links only when asked), the scope
 *  narrowing for a unit administrator in every query and through the download
 *  route, and THE RULE: for every tile, tab and column, the count equals the
 *  number of rows its link lists.
 *
 *  The rule is tested against an in-memory dataset. `$queryRaw` is answered by
 *  a small model of the tables (`answer`), which reads the params the loader
 *  was called with and returns what the database would; the loaders, the Node
 *  folding and the link builders (`reachLinks`) are the real ones. The SQL
 *  text itself is asserted separately; nothing here runs it.
 *
 *  Fixture people, units, papers, trials, guidelines and patents are invented. */
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  topics: vi.fn(),
  suppressions: vi.fn(),
  hiddenAuthors: vi.fn(),
  manageable: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      topic: { findMany: h.topics },
      suppression: { findMany: h.suppressions },
      publicationAuthor: { findMany: h.hiddenAuthors },
    },
    write: {},
  },
}));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: h.manageable }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({ roleCategories: [], departments: [], centers: [], institutions: [] })),
}));

import { GET } from "@/app/api/edit/reports/downstream-reach/route";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  buildReachWorkbook,
  canViewDownstreamReachReport,
  DEFAULT_STAGES,
  describeReachCriteria,
  isDownstreamReachReportEnabled,
  isReachDefault,
  listedFor,
  loadModalCounts,
  loadModalHidden,
  loadReach,
  loadReachCounts,
  loadReachDocs,
  loadReachDocTotal,
  loadReachPeople,
  loadScopePage,
  loadScopeTotal,
  MAX_DOC_FILTERS,
  MIN_REACH_PAPERS,
  modalGroupsOn,
  modalListsExactly,
  papersByType,
  parseReachParams,
  peoplePositions,
  REACH_LEVELS,
  REACH_REVIEW_RULE,
  REACH_SOURCES,
  REACH_TYPE_LABEL,
  REACH_TYPES,
  reachChips,
  reachLinks,
  reachPubSql,
  reachQueryString,
  reachTypeOfLevel,
  resolveReachParams,
  sortReachPublications,
  stageKeyOf,
  tickedTypes,
  usesRollups,
  withReachDocDetails,
  withReachPublicationDetails,
  type ModalCounts,
  type ReachCounts,
  type ReachData,
  type ReachParams,
  type ReachPersonRow,
  type ReachPubRow,
  type ReachType,
  type ReachView,
} from "@/lib/edit/downstream-reach-report";
import {
  loadPortfolioReachTile,
  loadScholarReach,
  portfolioReachParams,
  REACH_REPORT_PATH,
  SCHOLAR_REACH_NOTE,
  scholarReachParams,
} from "@/lib/edit/downstream-reach-entry";
import { POLICY_LEVELS, POLICY_REVIEWS_CAP } from "@/lib/citations/policy-rollup";
import { PATENT_SOURCES } from "@/lib/edit/patent-citations-report";
import { POLICY_CITATIONS_ACCESS_RULE } from "@/lib/edit/policy-citations-report";
import { REPORT_META_DEFAULTS } from "@/lib/edit/report-meta";
import { REPORTS } from "@/lib/edit/report-registry";
import { parsePortfolioParams } from "@/lib/edit/translational-portfolio-report";
import { Prisma } from "@/lib/generated/prisma/client";

const parse = (qs = "") => parseReachParams(new URLSearchParams(qs));
const SUPER = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false };
const ADMIN = { cwid: "adm0001", isSuperuser: false, isCommsSteward: false };
const units = (over: Record<string, { code: string }[]> = {}) => ({
  departments: [],
  divisions: [],
  centers: [],
  cores: [],
  institutions: [],
  total: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// The in-memory dataset
// ---------------------------------------------------------------------------

type Scholar = { cwid: string; name: string; dept: string; active: boolean };
type Doc = { id: number; level: string; dedupKey: string; year: number | null; title: string; application?: boolean };
type Pub = {
  pmid: string;
  year: number;
  stage: string | null;
  confidence: string | null;
  area?: string;
  authors: { cwid: string; position: "first" | "last" | "middle"; confirmed?: boolean }[];
  links: { doc: number; own?: boolean }[];
};

const SCHOLARS: Scholar[] = [
  { cwid: "aaa1001", name: "Ada Example", dept: "N1", active: true },
  { cwid: "bbb1002", name: "Ben Sample", dept: "N2", active: true },
  { cwid: "ccc1003", name: "Cy Former", dept: "N1", active: false },
  { cwid: "ddd1004", name: "Di Placeholder", dept: "N2", active: true },
];
const DOCS: Doc[] = [
  { id: 1, level: "clinical", dedupKey: "trial of an example 2022", year: 2022, title: "A trial of an example" },
  { id: 2, level: "clinical", dedupKey: "follow up of an example 2023", year: 2023, title: "A follow-up of an example" },
  { id: 3, level: "trial", dedupKey: "nct90000001", year: 2023, title: "Example registered study" },
  // One guideline printed in two journals: two rows, one `dedup_key`.
  { id: 4, level: "guideline", dedupKey: "example guideline 2024", year: 2024, title: "Example guideline" },
  { id: 5, level: "guideline", dedupKey: "example guideline 2024", year: 2024, title: "Example guideline" },
  { id: 6, level: "review", dedupKey: "example review 2023", year: 2023, title: "Example systematic review" },
  // One invention: a grant and its published application.
  { id: 7, level: "patent", dedupKey: "fam-1", year: 2024, title: "Example method" },
  { id: 8, level: "patent", dedupKey: "fam-1", year: 2022, title: "Example method", application: true },
  { id: 9, level: "patent", dedupKey: "fam-2", year: 2025, title: "Example composition" },
  { id: 10, level: "clinical", dedupKey: "third example 2024", year: 2024, title: "A third example" },
];
const PUBS: Pub[] = [
  // Clinical twice (one the authors' own), a trial, one invention in two documents.
  { pmid: "101", year: 2021, stage: "T0", confidence: "high", area: "area_a", authors: [{ cwid: "aaa1001", position: "first" }], links: [{ doc: 1 }, { doc: 2, own: true }, { doc: 3 }, { doc: 7 }, { doc: 8 }] },
  // A guideline in two journals and a review; a second author in another department.
  { pmid: "102", year: 2022, stage: "T1", confidence: "medium", authors: [{ cwid: "aaa1001", position: "last" }, { cwid: "bbb1002", position: "middle" }], links: [{ doc: 1 }, { doc: 4 }, { doc: 5 }, { doc: 6 }] },
  // Cited only by the authors' own article.
  { pmid: "103", year: 2022, stage: "T0", confidence: null, authors: [{ cwid: "aaa1001", position: "first" }], links: [{ doc: 2, own: true }] },
  // The authors' own trial, and a patent.
  { pmid: "104", year: 2023, stage: "T1", confidence: "high", area: "area_a", authors: [{ cwid: "aaa1001", position: "first" }], links: [{ doc: 3, own: true }, { doc: 9 }] },
  // A low-confidence stage: No stage.
  { pmid: "105", year: 2021, stage: "T0", confidence: "low", authors: [{ cwid: "aaa1001", position: "first" }], links: [{ doc: 1 }] },
  // A later stage, another department.
  { pmid: "106", year: 2023, stage: "T2", confidence: "high", authors: [{ cwid: "bbb1002", position: "first" }], links: [{ doc: 4 }, { doc: 10 }] },
  // Before the default years.
  { pmid: "107", year: 2019, stage: "T0", confidence: "high", authors: [{ cwid: "aaa1001", position: "first" }], links: [{ doc: 1 }] },
  // In scope, cited by nothing.
  { pmid: "108", year: 2022, stage: "T0", confidence: "high", authors: [{ cwid: "aaa1001", position: "first" }], links: [] },
  // A middle authorship only: in scope, never in the People view.
  { pmid: "109", year: 2022, stage: "T1", confidence: "high", authors: [{ cwid: "aaa1001", position: "middle" }], links: [{ doc: 1 }] },
  // Its only author is no longer active: out of scope.
  { pmid: "110", year: 2022, stage: "T0", confidence: "high", authors: [{ cwid: "ccc1003", position: "first" }], links: [{ doc: 1 }] },
  { pmid: "111", year: 2022, stage: "T1", confidence: "high", authors: [{ cwid: "aaa1001", position: "last" }], links: [{ doc: 6 }, { doc: 9 }] },
  // An unconfirmed authorship: out of scope.
  { pmid: "112", year: 2022, stage: "T0", confidence: "high", authors: [{ cwid: "ddd1004", position: "first", confirmed: false }], links: [{ doc: 1 }] },
  // Three first-author papers for a second person, two of them cited.
  { pmid: "113", year: 2022, stage: "T0", confidence: "high", authors: [{ cwid: "bbb1002", position: "first" }], links: [{ doc: 10 }] },
  { pmid: "114", year: 2024, stage: "T1", confidence: "high", authors: [{ cwid: "bbb1002", position: "last" }], links: [{ doc: 10 }, { doc: 3 }] },
];

const fx = { scholars: SCHOLARS, docs: DOCS, pubs: PUBS };
const doc = (id: number) => fx.docs.find((d) => d.id === id)!;
const unitKey = (d: Doc) => `${d.level}|${d.level === "clinical" ? d.id : d.dedupKey}`;
const repOf = (d: Doc) => `${d.application ? 1 : 0}${String(d.year ?? 9999).padStart(4, "0")}${String(d.id).padStart(10, "0")}`;

/** The params of the loader call being answered. */
let cur: ReachParams = parse();

/** Own work is a flagged link to a clinical article or a trial, as the rollups have it: a flag on a
 *  link at any other level (a clinical article since retyped as a guideline keeps its flag) is not. */
const isOwn = (l: Pub["links"][number]) => l.own === true && ["clinical", "trial"].includes(doc(l.doc).level);
const counted = (pub: Pub, p: ReachParams) => pub.links.filter((l) => p.includeOwn || !isOwn(l));
function countsOf(pub: Pub, p: ReachParams): ReachCounts {
  const keys = (t: ReachType) =>
    new Set(counted(pub, p).map((l) => doc(l.doc)).filter((d) => (REACH_LEVELS[t] as readonly string[]).includes(d.level)).map(unitKey)).size;
  return Object.fromEntries(REACH_TYPES.map((t) => [t, keys(t)])) as ReachCounts;
}
const inUnits = (s: Scholar, values: readonly string[]) => values.some((v) => v === `dept:${s.dept}`);
function matchingAuthors(pub: Pub, p: ReachParams, positions = p.positions, people = p.people) {
  return pub.authors.filter((a) => {
    const s = fx.scholars.find((x) => x.cwid === a.cwid);
    if (!s || !s.active || a.confirmed === false) return false;
    if (p.scope !== null && !inUnits(s, p.scope)) return false;
    if (p.units.length > 0 && !inUnits(s, p.units)) return false;
    if (people.length > 0 && !people.includes(a.cwid)) return false;
    return positions.length === 0 || positions.includes(a.position);
  });
}
function pubLevel(pub: Pub, p: ReachParams): boolean {
  if (p.from !== null && pub.year < p.from) return false;
  if (p.to !== null && pub.year > p.to) return false;
  if (p.stages.length > 0 && !p.stages.includes(stageKeyOf(pub.stage, pub.confidence))) return false;
  if (p.area && pub.area !== p.area) return false;
  if (p.pmid && pub.pmid !== p.pmid) return false;
  if (p.docs.length > 0) {
    if (!p.docRefs || p.docRefs.length !== p.docs.length) return false;
    for (const ref of p.docRefs) {
      const key = `${ref.level}|${ref.level === "clinical" ? ref.id : ref.dedupKey}`;
      if (!counted(pub, p).some((l) => unitKey(doc(l.doc)) === key)) return false;
    }
  }
  return true;
}
const inScope = (p: ReachParams, positions = p.positions) =>
  fx.pubs.filter((pub) => pubLevel(pub, p) && matchingAuthors(pub, p, positions).length > 0);
const citedBy = (c: ReachCounts, types: readonly ReachType[]) => types.some((t) => c[t] > 0);
const countCols = (c: ReachCounts) => Object.fromEntries(REACH_TYPES.map((t) => [`n_${t}`, c[t]]));
const zeros = (): ReachCounts => Object.fromEntries(REACH_TYPES.map((t) => [t, 0])) as ReachCounts;

/** The Citing documents listing, as `docGroupsSql` defines it. */
function docGroups(p: ReachParams) {
  const types = tickedTypes(p);
  const groups = new Map<string, { level: string; unit: string; pmids: Set<string>; rep: string }>();
  for (const pub of inScope(p).filter((x) => citedBy(countsOf(x, p), types))) {
    for (const l of counted(pub, p)) {
      const d = doc(l.doc);
      const type = reachTypeOfLevel(d.level);
      if (!type || !types.includes(type)) continue;
      const key = unitKey(d);
      const g = groups.get(key) ?? { level: d.level, unit: key.split("|")[1], pmids: new Set<string>(), rep: repOf(d) };
      groups.set(key, g);
      g.pmids.add(pub.pmid);
      if (repOf(d) < g.rep) g.rep = repOf(d);
    }
  }
  const year = (rep: string) => (rep.slice(1, 5) === "9999" ? -1 : Number(rep.slice(1, 5)));
  return [...groups.values()]
    .map((g) => ({ level: g.level, unit: g.unit, papers: g.pmids.size, rep: g.rep }))
    .sort((a, b) =>
      p.docSort === "recent"
        ? year(b.rep) - year(a.rep) || b.papers - a.papers || a.rep.localeCompare(b.rep)
        : b.papers - a.papers || year(b.rep) - year(a.rep) || a.rep.localeCompare(b.rep),
    );
}

/** What the database would return for one `$queryRaw`, under `cur`. */
function answer(text: string, values: unknown[]): unknown[] {
  const p = cur;
  const lastTwo = () => values.slice(-2).map(Number) as [number, number];
  if (text.includes("SELECT d.id, d.level, d.dedup_key, d.title FROM citing_document d WHERE d.id IN")) {
    return fx.docs.filter((d) => values.includes(d.id)).map((d) => ({ id: d.id, level: d.level, dedup_key: d.dedupKey, title: d.title }));
  }
  if (text.includes("d.external_id, d.journal")) {
    return fx.docs
      .filter((d) => values.includes(d.id))
      .map((d) => ({ id: d.id, title: d.title, url: `https://example.org/doc/${d.id}`, level: d.level, external_id: `x${d.id}`, journal: "Journal of Examples", journal_abbrev: null, issuing_body: null }));
  }
  if (text.includes("AS ranked")) {
    return inScope({ ...p, people: [], positions: [] })
      .filter((pub) => values.includes(pub.pmid))
      .map((pub) => {
        const docs = pub.links.map((l) => doc(l.doc));
        const distinct = (xs: (string | number)[]) => new Set(xs).size;
        return {
          pmid: pub.pmid,
          clinical: distinct(docs.filter((d) => d.level === "clinical").map((d) => d.id)),
          trial: distinct(docs.filter((d) => d.level === "trial").map((d) => d.id)),
          patent: distinct(docs.filter((d) => d.level === "patent").map((d) => d.dedupKey)),
          policy: distinct(docs.filter((d) => (REACH_LEVELS.policy as readonly string[]).includes(d.level)).map((d) => d.dedupKey)),
          review: distinct(docs.filter((d) => (REACH_LEVELS.review as readonly string[]).includes(d.level)).map((d) => d.dedupKey)),
          ranked: distinct(docs.filter((d) => POLICY_LEVELS.includes(d.level as never)).map((d) => d.dedupKey)),
        };
      });
  }
  if (text.includes("SELECT p.pmid, p.title, p.journal, p.doi, s.cwid")) {
    return fx.pubs
      .filter((pub) => values.includes(pub.pmid))
      .flatMap((pub) =>
        matchingAuthors(pub, { ...p, units: [], people: [], positions: [] }).map((a) => ({
          pmid: pub.pmid,
          title: `Paper ${pub.pmid}`,
          journal: "Journal of Examples",
          doi: null,
          cwid: a.cwid,
          preferred_name: fx.scholars.find((s) => s.cwid === a.cwid)!.name,
          is_first: a.position === "first",
          is_last: a.position === "last",
        })),
      );
  }
  // Own work counted: the People view's authorships, folded in Node with the counts.
  if (text.includes("s.primary_org_code, p.pmid AS pmid")) {
    const positions = peoplePositions(p)!;
    return inScope(p, positions)
      .filter((pub) => pub.links.length > 0)
      .flatMap((pub) =>
        matchingAuthors(pub, p, positions).map((a) => {
          const s = fx.scholars.find((x) => x.cwid === a.cwid)!;
          return { cwid: a.cwid, preferred_name: s.name, primary_department: `Department ${s.dept}`, role_category: null, primary_org_code: null, pmid: pub.pmid };
        }),
      );
  }
  if (text.includes("HAVING COUNT(*) >=")) {
    const positions = peoplePositions(p)!;
    const rows = new Map<string, ReachCounts & { papers: number }>();
    for (const pub of inScope(p, positions)) {
      const c = countsOf(pub, p);
      if (!citedBy(c, tickedTypes(p))) continue;
      for (const a of matchingAuthors(pub, p, positions)) {
        const r = rows.get(a.cwid) ?? { papers: 0, ...zeros() };
        rows.set(a.cwid, r);
        r.papers += 1;
        for (const t of REACH_TYPES) if (c[t] > 0) r[t] += 1;
      }
    }
    return [...rows]
      .filter(([, r]) => r.papers >= MIN_REACH_PAPERS)
      .map(([cwid, r]) => {
        const s = fx.scholars.find((x) => x.cwid === cwid)!;
        return { cwid, preferred_name: s.name, primary_department: `Department ${s.dept}`, role_category: null, primary_org_code: null, papers: r.papers, ...countCols(r) };
      });
  }
  if (text.includes("SELECT COUNT(*) AS n FROM (")) return [{ n: docGroups(p).length }];
  if (text.includes("SELECT g.level, g.unit, g.papers, g.rep")) {
    const [limit, offset] = lastTwo();
    const groups = docGroups(p);
    return groups.slice(offset, offset + limit).map((g) => ({ ...g, total: groups.length }));
  }
  if (text.includes("COUNT(DISTINCT p.pmid) AS n")) return [{ n: inScope(p).length }];
  if (text.includes("ORDER BY year DESC, p.pmid DESC")) {
    const [limit, offset] = lastTwo();
    return inScope(p)
      .sort((a, b) => b.year - a.year || b.pmid.localeCompare(a.pmid))
      .slice(offset, offset + limit)
      .map((pub) => ({ pmid: pub.pmid, year: pub.year, stage: pub.stage, confidence: pub.confidence }));
  }
  if (text.includes("MAX(p.translational_stage) AS stage")) {
    return inScope(p)
      .map((pub) => ({ pub, c: countsOf(pub, p) }))
      .filter(({ c }) => citedBy(c, REACH_TYPES))
      .map(({ pub, c }) => ({ pmid: pub.pmid, year: pub.year, stage: pub.stage, confidence: pub.confidence, ...countCols(c) }));
  }
  if (text.includes("p.title LIKE")) return inScope(p).filter((pub) => pub.pmid === p.q).map((pub) => ({ pmid: pub.pmid }));
  throw new Error(`unmodelled query: ${text.slice(0, 160)}`);
}

/** Every `$queryRaw` tagged-template call so far, re-composed: one-spaced text plus bound values. */
const calls = () =>
  h.queryRaw.mock.calls.map((c) => {
    const [strings, ...values] = c as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...values);
    return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
  });
const flat = (sql: Prisma.Sql) => ({ text: sql.sql.replace(/\s+/g, " "), values: sql.values });
/** A query that names a person, an authorship or a publication. */
const readsPeopleOrPapers = (text: string) => /\b(scholar|publication_author|publication) [a-z]+\b/.test(text);

const EVERYTHING = 100_000;
/** Resolve a query string for a viewer and load one view of it, whole. */
async function open(qs: string, session = SUPER, views?: readonly ReachView[]): Promise<{ p: ReachParams; data: ReachData }> {
  // `doc` filters are resolved under the params being resolved.
  cur = parse(qs);
  const p = await resolveReachParams(parse(qs), session);
  cur = p;
  return { p, data: await loadReach(p, { views: views ?? [p.view], limit: EVERYTHING }) };
}
/** How many rows the list at this query string holds: what a count must equal. */
async function listLength(qs: string, session = SUPER): Promise<number> {
  const { p, data } = await open(qs, session);
  if (p.view === "documents") {
    expect(data.docs).toHaveLength(data.docTotal!);
    return data.docs.length;
  }
  if (p.view === "people") return data.people!.length;
  expect(data.pubs).toHaveLength(data.pubMatched);
  return data.pubs.length;
}

beforeEach(() => {
  cur = parse();
  h.queryRaw.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    return answer(sql.sql.replace(/\s+/g, " "), sql.values);
  });
  h.topics.mockReset().mockResolvedValue([{ id: "area_a", label: "Example area" }]);
  h.suppressions.mockReset().mockResolvedValue([]);
  h.hiddenAuthors.mockReset().mockResolvedValue([]);
  h.manageable.mockReset().mockResolvedValue(units());
  h.session.mockReset();
  vi.stubEnv("DOWNSTREAM_REACH_REPORT", "on");
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------

describe("parseReachParams", () => {
  it("a bare URL: T0 and T1 papers since 2020, all five citing types, own work left out", () => {
    expect(parse()).toEqual({
      types: [],
      units: [],
      people: [],
      positions: [],
      basis: "cy",
      from: 2020,
      to: null,
      stages: ["T0", "T1"],
      ctypes: [],
      includeOwn: false,
      area: null,
      pmid: null,
      docs: [],
      showAll: false,
      view: "publications",
      sort: "cited",
      asc: false,
      docSort: "papers",
      q: "",
      page: 1,
      scope: [],
      docRefs: null,
      with: null,
      dir: "cited",
    });
    expect(DEFAULT_STAGES).toEqual(["T0", "T1"]);
    expect(isReachDefault(parse())).toBe(true);
    // View state, and the every-publication listing, are not filters.
    expect(isReachDefault(parse("view=people&sort=year&dsort=recent&q=abc&page=3"))).toBe(true);
    expect(isReachDefault(parse("stage=T0&stage=T1&from=2020&basis=cy&show=all"))).toBe(true);
    expect(isReachDefault(parse("stage=T2&from=2020"))).toBe(false);
    expect(isReachDefault(parse("ctype=patent&from=2020"))).toBe(false);
    expect(isReachDefault(parse("own=in&from=2020"))).toBe(false);
  });

  it("the stage and own-work defaults hold on a link that carries only a person", () => {
    const p = parse("person=aaa1001");
    expect(p.stages).toEqual(["T0", "T1"]);
    expect(p.includeOwn).toBe(false);
    expect(p.ctypes).toEqual([]);
    // The years default belongs to a bare URL, as on report 24.
    expect(p.from).toBeNull();
  });

  it("stage: a stage counts by name, No stage is its own value, and `any` (the submitted form) means every stage", () => {
    expect(parse("stage=T2&stage=none&stage=T9").stages).toEqual(["T2", "none"]);
    expect(parse("stage=any").stages).toEqual([]);
    expect(parse("stage=any&stage=T3-4").stages).toEqual(["T3-4"]);
    expect(parse("stage=nope").stages).toEqual(["T0", "T1"]);
  });

  it("own work: the hidden `in` alone includes it; the ticked box adds `out`, which wins", () => {
    expect(parse("own=in").includeOwn).toBe(true);
    expect(parse("own=in&own=out").includeOwn).toBe(false);
    expect(parse("own=out").includeOwn).toBe(false);
    expect(parse("own=yes").includeOwn).toBe(false);
  });

  it("reads each filter, drops what it does not know, and keeps ranges in order", () => {
    const p = parse(
      "type=full_time_faculty&unit=dept:N1&person=aaa1001&person=bad%20one&pos=last&pos=nope&basis=fy&from=2012&to=2001" +
        "&stage=T0&ctype=patent&ctype=clinical&ctype=reviews&own=in&area=area_a&pmid=101&doc=7&doc=7&doc=abc&doc=0" +
        "&show=all&view=documents&sort=year&dsort=recent&q=%20kinase%20&page=4",
    );
    expect(p).toMatchObject({
      types: ["full_time_faculty"],
      units: ["dept:N1"],
      people: ["aaa1001"],
      positions: ["last"],
      basis: "fy",
      from: 2012,
      to: 2012,
      stages: ["T0"],
      ctypes: ["clinical", "patent"],
      includeOwn: true,
      area: "area_a",
      pmid: "101",
      docs: [7],
      showAll: true,
      view: "documents",
      sort: "year",
      docSort: "recent",
      q: "kinase",
      page: 4,
    });
    expect(parse("area=bad%20area&pmid=12a&view=inventions&sort=ranked&dsort=x&page=-2")).toMatchObject({
      area: null,
      pmid: null,
      view: "publications",
      sort: "cited",
      docSort: "papers",
      page: 1,
    });
    expect(parse(Array.from({ length: 9 }, (_, i) => `doc=${i + 1}`).join("&")).docs).toHaveLength(MAX_DOC_FILTERS);
  });

  it("never reads a scope or a resolved document from the URL: unresolved params match nothing", () => {
    const p = parse("scope=dept:N1&docRefs=1&doc=7");
    expect(p.scope).toEqual([]);
    expect(p.docRefs).toBeNull();
    expect(flat(reachPubSql(p)).text).toContain("AND 1 = 0");
  });

  it("the query string round-trips, always carries basis and stage, and carries page only when asked", () => {
    const qs =
      "unit=dept%3AN1&person=aaa1001&pos=first&stage=T0&stage=none&ctype=clinical&own=in&area=area_a&basis=cy&from=2015" +
      "&pmid=101&doc=7&doc=3&show=all&view=documents&sort=year&dsort=recent&q=kinase";
    const p = parse(`${qs}&page=3`);
    expect(reachQueryString(p)).toBe(qs);
    expect(reachQueryString(p, { page: 3 })).toBe(`${qs}&page=3`);
    expect(parse(reachQueryString(p, { page: 3 }))).toEqual(p);
    // Never bare: a link built here does not fall back to the bare-URL years.
    expect(reachQueryString(parse())).toBe("stage=T0&stage=T1&basis=cy&from=2020");
    expect(reachQueryString(parse("stage=any"))).toBe("stage=any&basis=cy");
    expect(parse(reachQueryString(parse("stage=any"))).stages).toEqual([]);
  });

  it("a stage counts only under the display rule; everything else is No stage", () => {
    expect(stageKeyOf("T0", "high")).toBe("T0");
    expect(stageKeyOf("T3-4", null)).toBe("T3-4");
    expect(stageKeyOf("T0", "low")).toBe("none");
    expect(stageKeyOf("NA", "high")).toBe("none");
    expect(stageKeyOf(null, null)).toBe("none");
  });
});

describe("the flag", () => {
  it("is on only at exactly 'on'", () => {
    for (const v of ["", "true", "1", "ON", "off"]) {
      vi.stubEnv("DOWNSTREAM_REACH_REPORT", v);
      expect(isDownstreamReachReportEnabled()).toBe(false);
    }
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "on");
    expect(isDownstreamReachReportEnabled()).toBe(true);
  });

  it("off: nobody can view it (so no index entry and a 404 page), and nothing is read to find that out", async () => {
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "off");
    expect(await canViewDownstreamReachReport(SUPER)).toBe(false);
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }] }));
    expect(await canViewDownstreamReachReport(ADMIN)).toBe(false);
    expect(h.manageable).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("off: the download route 404s before it looks at the session or runs a query", async () => {
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "off");
    h.session.mockResolvedValue(SUPER);
    const res = await GET(new Request("https://scholars.example/api/edit/reports/downstream-reach"));
    expect(res.status).toBe(404);
    expect(h.session).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.topics).not.toHaveBeenCalled();
  });

  it("on: report 24's access rule, and report 27 is registered with this gate", async () => {
    expect(await canViewDownstreamReachReport(SUPER)).toBe(true);
    expect(await canViewDownstreamReachReport({ ...ADMIN, isCommsSteward: true })).toBe(true);
    expect(await canViewDownstreamReachReport(ADMIN)).toBe(false);
    h.manageable.mockResolvedValue(units({ cores: [{ code: "9" }] }));
    expect(await canViewDownstreamReachReport(ADMIN)).toBe(false);
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }] }));
    expect(await canViewDownstreamReachReport(ADMIN)).toBe(true);
    const def = REPORTS["27"];
    expect(def.gate).toBe("admin");
    expect(def.gate === "admin" && def.canView).toBe(canViewDownstreamReachReport);
    expect(def.gate === "admin" && def.accessRule).toBe(POLICY_CITATIONS_ACCESS_RULE);
    expect(REPORT_META_DEFAULTS["27"]).toMatchObject({ slug: "downstream-reach", name: "Downstream reach" });
  });

  it("About this report says what each type is, where it comes from, and the two caveats", () => {
    const about = REPORT_META_DEFAULTS["27"].descriptionHtml!;
    for (const said of [
      "NIH iCite",
      "PubMed",
      "ClinicalTrials.gov",
      "NCBI Bookshelf",
      "Reliance on Science",
      "own work is left out",
      "Nobody reviews the stages by hand",
      "A later stage is not a better one",
    ]) {
      expect(about).toContain(said);
    }
    // Guidelines and policy no longer takes in systematic reviews; they have a line of their own.
    const policyLine = about.match(/<li><strong>Guidelines and policy<\/strong>[^]*?<\/li>/)![0];
    expect(policyLine).not.toMatch(/review/i);
    expect(about).toMatch(/<li><strong>Systematic reviews<\/strong>: PubMed articles typed Systematic Review or Meta-Analysis \(by publication type\), as the policy import classifies them/);
    expect(REACH_REVIEW_RULE).toContain("Systematic reviews are counted on their own");
    const criteria = new Map(describeReachCriteria({ ...parse(), scope: null }, new Date(0)));
    expect(criteria.get("Citing types")).toBe(REACH_REVIEW_RULE);
    expect(criteria.get("Sources")).toContain("PubMed (systematic reviews)");
  });
});

describe("the patent source", () => {
  it("carries report 25's credit, licence and caveat, on the page, in the Criteria sheet and in About", () => {
    const about = REPORT_META_DEFAULTS["27"].descriptionHtml!;
    for (const said of [
      "Reliance on Science (Marx and Fuegi), CC BY-NC 4.0",
      "USPTO PatentsView",
      "A patent citing a paper does not mean the paper's authors hold the patent.",
    ]) {
      expect(PATENT_SOURCES).toContain(said);
      expect(REACH_SOURCES).toContain(said);
      expect(about).toContain(said);
    }
    const criteria = new Map(describeReachCriteria({ ...parse(), scope: null }, new Date(0)));
    expect(criteria.get("Sources")).toBe(REACH_SOURCES.replace(/^Sources: /, ""));
  });
});

describe("where the counts come from", () => {
  it("the default view reads the rollup columns and never the link table", async () => {
    const { p } = await open("");
    expect(usesRollups(p)).toBe(true);
    const texts = calls().map((c) => c.text);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).not.toContain("publication_citing_document");
      expect(text).not.toContain("citing_document");
      expect(text).toContain("FROM publication p JOIN publication_author pa ON pa.pmid = p.pmid JOIN scholar s ON s.cwid = pa.cwid");
    }
    const counts = texts.find((t) => t.includes("AS n_clinical"))!;
    expect(counts).toContain("MAX(p.clinical_cite_count) AS n_clinical");
    expect(counts).toContain("MAX(p.trial_count) AS n_trial");
    expect(counts).toContain("MAX((p.authority_count + p.guideline_count + p.consensus_count)) AS n_policy");
    expect(counts).toContain("MAX(p.review_count) AS n_review");
    expect(counts).toContain("MAX(p.patent_family_count) AS n_patent");
    expect(counts).toContain(
      "WHERE (p.clinical_cite_count > 0 OR p.trial_count > 0 OR (p.authority_count + p.guideline_count + p.consensus_count) > 0 OR p.review_count > 0 OR p.patent_family_count > 0)",
    );
    expect(counts).toContain("GROUP BY p.pmid");
  });

  it("the People view reads the rollups too", async () => {
    await open("view=people");
    const people = calls().find((c) => c.text.includes("HAVING COUNT(*) >="))!;
    expect(people.text).not.toContain("citing_document");
    expect(people.text).toContain("COUNT(CASE WHEN p.clinical_cite_count > 0 THEN 1 END) AS n_clinical");
    expect(people.text).toContain("(pa.is_first = 1 OR pa.is_last = 1)");
    expect(people.values).toContain(MIN_REACH_PAPERS);
  });

  it("the stage filter is the display rule in SQL, and every stage ticked is no filter", () => {
    const sql = (qs: string) => flat(reachPubSql({ ...parse(qs), scope: null }));
    const dflt = sql("");
    expect(dflt.text).toContain(
      "AND ((p.translational_stage IN (?,?) AND (p.translational_stage_confidence IS NULL OR p.translational_stage_confidence <> 'low')))",
    );
    expect(dflt.values).toEqual(expect.arrayContaining(["T0", "T1", 2020]));
    // No stage: not a displayed stage, NULLs included.
    const none = sql("stage=none&stage=T2");
    expect(none.text).toMatch(/OR COALESCE\(p\.translational_stage IN \(\?,\?,\?,\?\) AND \(.*?\), 0\) = 0\)/);
    expect(sql("stage=any").text).not.toContain("translational_stage");
    expect(sql("stage=T0&stage=T1&stage=T2&stage=T3-4&stage=none").text).not.toContain("translational_stage");
  });

  it("research area is report 26's rule: the area score floor on publication_topic", () => {
    const { text, values } = flat(reachPubSql({ ...parse("area=area_a"), scope: null }));
    expect(text).toContain("pt_a.parent_topic_id = ? AND pt_a.score >= ?");
    expect(values).toEqual(expect.arrayContaining(["area_a", 0.3]));
  });

  it("own work included: a live aggregate, driven from the publications in scope, never from the links", async () => {
    const { p } = await open("own=in");
    expect(usesRollups(p)).toBe(false);
    const counts = calls().find((c) => c.text.includes("AS n_clinical"))!;
    expect(counts.text).toContain("COUNT(DISTINCT CASE WHEN d.level = 'clinical' THEN d.id END) AS n_clinical");
    expect(counts.text).toContain("COUNT(DISTINCT CASE WHEN d.level = 'trial' THEN d.dedup_key END) AS n_trial");
    expect(counts.text).toContain("COUNT(DISTINCT CASE WHEN d.level = 'patent' THEN d.dedup_key END) AS n_patent");
    expect(counts.text).toContain("COUNT(DISTINCT CASE WHEN d.level IN (?,?,?) THEN CONCAT(d.level, '|', d.dedup_key) END) AS n_policy");
    expect(counts.text).toContain("COUNT(DISTINCT CASE WHEN d.level IN (?) THEN CONCAT(d.level, '|', d.dedup_key) END) AS n_review");
    // The publications lead: `ok` is one row per publication in scope, with the authorship test and
    // the publication filters inside it, so neither is evaluated per link.
    expect(counts.text).toMatch(
      /FROM \(SELECT STRAIGHT_JOIN p\.pmid, MAX\(p\.year\) AS year.* FROM publication p JOIN publication_author pa ON pa\.pmid = p\.pmid JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.is_confirmed = 1 .*p\.translational_stage IN \(\?,\?\).* GROUP BY p\.pmid\) ok JOIN publication_citing_document l ON l\.pmid = ok\.pmid JOIN citing_document d ON d\.id = l\.citing_document_id WHERE d\.level IN \(\?,\?,\?,\?,\?,\?,\?\) GROUP BY ok\.pmid$/,
    );
    expect(counts.text).not.toContain("EXISTS");
    expect(counts.text).not.toContain("clinical_cite_count");
    expect(counts.text).not.toContain("ownWork");
  });

  it("own work included: the live aggregate is evaluated once per request, on every tab and in the download", async () => {
    const aggregates = () => calls().filter((c) => c.text.includes("COUNT(DISTINCT CASE WHEN d.level = 'clinical'"));
    for (const views of [["publications"], ["documents"], ["people"], ["publications", "documents", "people"]] as const) {
      h.queryRaw.mockClear();
      await open(`own=in&stage=any&view=${views[0]}`, SUPER, views);
      expect(aggregates(), views.join()).toHaveLength(1);
    }
    // The People view takes the rows already fetched, plus the authorships of papers that have a
    // link at all: a keyed probe, not a second pass over the links.
    const people = calls().find((c) => c.text.includes("s.primary_org_code, p.pmid AS pmid"))!;
    expect(people.text).toContain("WHERE EXISTS (SELECT 1 FROM publication_citing_document l WHERE l.pmid = p.pmid) AND pa.is_confirmed = 1");
    expect(people.text).toContain("(pa.is_first = 1 OR pa.is_last = 1)");
    expect(people.text).not.toContain("citing_document d");
    // Asked for on its own, it loads the counts itself: the same rows either way.
    const p = { ...parse("own=in&stage=any"), scope: null };
    cur = p;
    expect(await loadReachPeople(p)).toEqual(await loadReachPeople(p, await loadReachCounts(p)));
    expect((await loadReachPeople(p)).map((r) => r.cwid)).toEqual(["aaa1001", "bbb1002"]);
  });

  it("the Citing documents view starts from the listed publications and reads their links once, own work left out", async () => {
    await open("view=documents&ctype=clinical&ctype=trial");
    // One evaluation: the page's rows carry the total.
    const docs = calls().filter((c) => c.text.includes("GROUP BY d.level, unit"));
    expect(docs).toHaveLength(1);
    const [{ text, values }] = docs;
    expect(text).toContain("SELECT g.level, g.unit, g.papers, g.rep, COUNT(*) OVER () AS total FROM (");
    expect(text).toContain("FROM (SELECT STRAIGHT_JOIN p.pmid FROM publication p JOIN publication_author pa");
    expect(text).toContain("WHERE (p.clinical_cite_count > 0 OR p.trial_count > 0) AND");
    expect(text).toContain("GROUP BY p.pmid) ok JOIN publication_citing_document l ON l.pmid = ok.pmid JOIN citing_document d ON d.id = l.citing_document_id WHERE d.level IN (?,?)");
    expect(values).toEqual(expect.arrayContaining(["clinical", "trial"]));
    // Own work is the rollups' rule and no wider: the flag counts only at its own level, and the
    // level is tested first, so the JSON is read on clinical and trial links alone.
    expect(text).toContain(
      "AND NOT ((d.level = 'clinical' AND COALESCE(JSON_CONTAINS(l.evidence, 'true', '$.ownWork'), 0) = 1) OR (d.level = 'trial' AND COALESCE(JSON_CONTAINS(l.evidence, 'true', '$.ownTrial'), 0) = 1)) GROUP BY d.level, unit",
    );
    // A clinical study is one article; everything else one `dedup_key`.
    expect(text).toContain("IF(d.level = 'clinical', CAST(d.id AS CHAR), d.dedup_key) AS unit, COUNT(DISTINCT l.pmid) AS papers");
    // Only a patent has a kind: `details` is read for patents alone.
    expect(text).toContain("MIN(CONCAT(IF(d.level = 'patent' AND JSON_UNQUOTE(JSON_EXTRACT(d.details, '$.kind')) = 'application', '1', '0'),");
    h.queryRaw.mockClear();
    // Own work counted: every link counts, so the level test is the whole "cited" test. No rollup
    // is consulted and the live counts are not evaluated a second time here.
    await open("view=documents&own=in");
    const live = calls().filter((c) => c.text.includes("GROUP BY d.level, unit"));
    expect(live).toHaveLength(1);
    expect(live[0].text).not.toContain("JSON_CONTAINS(l.evidence");
    expect(live[0].text).not.toContain("clinical_cite_count");
    expect(live[0].text).not.toContain("AS n_clinical");
    expect(live[0].text).toContain("FROM (SELECT STRAIGHT_JOIN p.pmid FROM publication p JOIN publication_author pa ON pa.pmid = p.pmid JOIN scholar s ON s.cwid = pa.cwid WHERE pa.is_confirmed = 1");
  });

  it("a view that was not asked for is not loaded, and so has no count to show", async () => {
    const { data } = await open("");
    expect(data.docTotal).toBeNull();
    expect(data.people).toBeNull();
    expect(calls().some((c) => c.text.includes("GROUP BY d.level, unit") || c.text.includes("HAVING COUNT"))).toBe(false);
  });

  it("a citing-document filter: a clinical study by its id, anything else by level and dedup_key, under the own-work rule", async () => {
    const { p } = await open("doc=1&doc=7");
    expect(p.docRefs).toEqual([
      { id: 1, level: "clinical", type: "clinical", dedupKey: "trial of an example 2022", title: "A trial of an example" },
      { id: 7, level: "patent", type: "patent", dedupKey: "fam-1", title: "Example method" },
    ]);
    const { text, values } = flat(reachPubSql(p));
    expect(text).toContain(
      "AND p.pmid IN (SELECT l2.pmid FROM publication_citing_document l2 WHERE l2.citing_document_id = ? AND NOT (COALESCE(JSON_CONTAINS(l2.evidence, 'true', '$.ownWork'), 0) = 1))",
    );
    // A patent link has no own-work flag: nothing is left out, as `patent_family_count` leaves nothing out.
    expect(text).toContain("JOIN publication_citing_document l2 ON l2.citing_document_id = d2.id WHERE d2.level = ? AND d2.dedup_key = ? )");
    expect(values).toEqual(expect.arrayContaining([1, "patent", "fam-1"]));
    // A trial by its own flag; a guideline by none, whatever its links carry.
    const other = flat(reachPubSql((await open("doc=3&doc=4")).p)).text;
    expect(other).toContain("WHERE d2.level = ? AND d2.dedup_key = ? AND NOT (COALESCE(JSON_CONTAINS(l2.evidence, 'true', '$.ownTrial'), 0) = 1))");
    expect(other.match(/JSON_CONTAINS/g)).toHaveLength(1);
    // An id that is no citing document: the filter matches nothing.
    const missing = await open("doc=999");
    expect(missing.p.docRefs).toEqual([]);
    expect(flat(reachPubSql(missing.p)).text).toContain("AND 1 = 0");
    expect(missing.data.pubTotal).toBe(0);
  });

  it("sorts: most citing documents over the ticked types, or publication year", () => {
    const row = (pmid: string, year: number, c: Partial<ReachCounts>) => ({
      pmid,
      year,
      stage: "T0" as const,
      ...zeros(),
      ...c,
    });
    const rows = [row("1", 2021, { clinical: 2, patent: 9 }), row("2", 2023, { clinical: 5 }), row("3", 2022, { clinical: 5 })];
    expect(sortReachPublications(rows, "cited", REACH_TYPES).map((r) => r.pmid)).toEqual(["1", "2", "3"]);
    expect(sortReachPublications(rows, "cited", ["clinical"]).map((r) => r.pmid)).toEqual(["2", "3", "1"]);
    expect(sortReachPublications(rows, "year", REACH_TYPES).map((r) => r.pmid)).toEqual(["2", "3", "1"]);
    // A type's column: by that count, ties by the Total, then the newest; asc reverses the count only.
    expect(sortReachPublications(rows, "clinical", REACH_TYPES).map((r) => r.pmid)).toEqual(["2", "3", "1"]);
    expect(sortReachPublications(rows, "patent", REACH_TYPES).map((r) => r.pmid)).toEqual(["1", "2", "3"]);
    expect(sortReachPublications(rows, "clinical", REACH_TYPES, true).map((r) => r.pmid)).toEqual(["1", "2", "3"]);
    expect(sortReachPublications(rows, "cited", REACH_TYPES, true).map((r) => r.pmid)).toEqual(["2", "3", "1"]);
    expect(sortReachPublications(rows, "oldest", REACH_TYPES).map((r) => r.pmid)).toEqual(["1", "3", "2"]);
  });

  it("order=asc rides only with a count sort", () => {
    expect(reachQueryString(parse("sort=trial&order=asc"))).toContain("order=asc");
    expect(reachQueryString(parse("sort=oldest&order=asc"))).not.toContain("order");
  });
});

describe("the fixture, read through the loaders", () => {
  it("the default view: T0 and T1 papers since 2020 by confirmed, active authors", async () => {
    const { data } = await open("");
    // 101, 102, 103, 104, 108, 109, 111, 113, 114 are in scope; 103 and 108 are not cited (103 only by own work).
    expect(data.scopeTotal).toBe(9);
    expect(data.pubs.map((r) => r.pmid).sort()).toEqual(["101", "102", "104", "109", "111", "113", "114"]);
    const byPmid = new Map(data.pubs.map((r) => [r.pmid, r]));
    // One clinical study (the other is the authors' own), one trial, one invention in two documents.
    expect(byPmid.get("101")).toMatchObject({ stage: "T0", clinical: 1, trial: 1, policy: 0, review: 0, patent: 1 });
    // A guideline printed twice counts once; the review is a type of its own.
    expect(byPmid.get("102")).toMatchObject({ stage: "T1", clinical: 1, policy: 1, review: 1 });
    // Cited by a systematic review and no guideline: under Systematic reviews only.
    expect(byPmid.get("111")).toMatchObject({ policy: 0, review: 1, patent: 1 });
    // The authors' own trial is not counted.
    expect(byPmid.get("104")).toMatchObject({ trial: 0, patent: 1 });
    expect(data.typePapers).toEqual({ clinical: 5, trial: 2, policy: 1, review: 2, patent: 3 });
  });

  it("own work included: the own article and the own trial count", async () => {
    const { data } = await open("own=in");
    const byPmid = new Map(data.pubs.map((r) => [r.pmid, r]));
    expect(byPmid.get("101")).toMatchObject({ clinical: 2 });
    expect(byPmid.get("103")).toMatchObject({ clinical: 1 });
    expect(byPmid.get("104")).toMatchObject({ trial: 1 });
  });

  it("the People view: first or senior author only, at least three such papers, by count", async () => {
    const { data } = await open("view=people");
    // Ada: 101, 102, 104, 111 (109 is a middle authorship). Ben has two cited first/senior papers.
    expect(data.people!.map((r) => [r.cwid, r.papers])).toEqual([["aaa1001", 4]]);
    expect(data.people![0]).toMatchObject({ name: "Ada Example", clinical: 2, trial: 1, policy: 1, review: 2, patent: 3 });
    expect(peoplePositions(parse())).toEqual(["first", "last"]);
    expect(peoplePositions(parse("pos=last&pos=middle"))).toEqual(["last"]);
    // Middle authors only: nobody qualifies, and no query is needed to say so.
    expect(peoplePositions(parse("pos=middle"))).toBeNull();
    h.queryRaw.mockClear();
    expect(await loadReachPeople({ ...parse("pos=middle"), scope: null })).toEqual([]);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("the Citing documents view: one row per article, per deduplicated document and per invention", async () => {
    const { data } = await open("view=documents&stage=any");
    const docs = await withReachDocDetails(data.docs);
    const row = (title: string) => docs.filter((d) => d.title === title);
    // The guideline printed in two journals is one row; so is the invention with two documents.
    expect(row("Example guideline")).toHaveLength(1);
    expect(row("Example method")).toHaveLength(1);
    // The invention is shown by its granted patent, not the earlier application.
    expect(row("Example method")[0]).toMatchObject({ docId: 7, kind: "Patent", year: 2024, application: false });
    expect(row("Example guideline")[0]).toMatchObject({ kind: "Clinical guideline", papers: 2 });
    expect(row("Example registered study")[0]).toMatchObject({ kind: "Registered trial", source: "x3" });
  });
});

// ---------------------------------------------------------------------------
// THE RULE: a count equals the number of rows its link lists.
// ---------------------------------------------------------------------------

describe.each<[string, string, typeof SUPER, Record<string, { code: string }[]>]>([
  ["the default view", "", SUPER, {}],
  ["own work included", "own=in&stage=T0&stage=T1&from=2020", SUPER, {}],
  ["every stage, any year", "stage=any", SUPER, {}],
  ["two citing types", "ctype=clinical&ctype=patent&from=2020", SUPER, {}],
  ["one research area", "area=area_a&stage=any", SUPER, {}],
  ["a unit administrator's view", "stage=any", ADMIN, { departments: [{ code: "N2" }] }],
  ["a unit administrator, own work included", "own=in&stage=any", ADMIN, { departments: [{ code: "N1" }] }],
  ["a person filter and last authors", "person=aaa1001&pos=last&stage=any", SUPER, {}],
])("every count equals the list its link opens: %s", (_name, qs, session, managed) => {
  beforeEach(() => h.manageable.mockResolvedValue(units(managed)));

  it("the first tile: N cited downstream, of M in scope", async () => {
    const { p, data } = await open(qs, session);
    const links = reachLinks(p);
    expect(await listLength(links.cited(), session)).toBe(data.pubTotal);
    expect(await listLength(links.scope(), session)).toBe(data.scopeTotal);
    expect(data.pubTotal).toBeLessThanOrEqual(data.scopeTotal);
  });

  it.each(REACH_TYPES)("the %s tile", async (t) => {
    const { p, data } = await open(qs, session);
    expect(await listLength(reachLinks(p).type(t), session)).toBe(data.typePapers[t]);
  });

  it("the three tabs", async () => {
    const { p, data } = await open(qs, session, ["publications", "documents", "people"]);
    const links = reachLinks(p);
    expect(await listLength(links.view("publications"), session)).toBe(data.pubTotal);
    expect(await listLength(links.view("documents"), session)).toBe(data.docTotal);
    expect(await listLength(links.view("people"), session)).toBe(data.peopleTotal);
  });

  it("a Publications cell: the paper's citing documents of that type", async () => {
    const { p, data } = await open(qs, session);
    const types = tickedTypes(p);
    let checked = 0;
    for (const r of data.pubs) {
      for (const t of types) {
        if (r[t] === 0) continue;
        expect(await listLength(reachLinks(p).paperDocs(r.pmid, t), session), `${r.pmid} ${t}`).toBe(r[t]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a Publications Total: the paper's citing documents of every ticked type", async () => {
    const { p, data } = await open(qs, session);
    const types = tickedTypes(p);
    let checked = 0;
    for (const r of data.pubs) {
      const total = types.reduce((n, t) => n + r[t], 0);
      expect(await listLength(reachLinks(p).paperDocs(r.pmid, null), session), r.pmid).toBe(total);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a Citing documents row: the papers it cites", async () => {
    const { p, data } = await open(`${qs}${qs ? "&" : ""}view=documents`, session);
    expect(data.docs.length).toBeGreaterThan(0);
    for (const d of data.docs) {
      const link = reachLinks(p).docPapers(d.docId);
      expect(link).not.toBeNull();
      expect(await listLength(link!, session), `document ${d.docId}`).toBe(d.papers);
    }
  });

  it("a People row: papers cited downstream, and one count per type", async () => {
    // The threshold of three would leave some of these views with nobody.
    const { p, data } = await open(`${qs}${qs ? "&" : ""}view=people`, session);
    for (const r of data.people!) {
      expect(r.papers).toBeGreaterThanOrEqual(MIN_REACH_PAPERS);
      expect(await listLength(reachLinks(p).person(r.cwid, null), session), `${r.cwid} papers`).toBe(r.papers);
      for (const t of tickedTypes(p)) {
        expect(await listLength(reachLinks(p).person(r.cwid, t), session), `${r.cwid} ${t}`).toBe(r[t]);
      }
    }
  });
});

describe("the rule's edges", () => {
  it("the People columns are checked on a view where two people qualify", async () => {
    const { p, data } = await open("view=people&stage=any&own=in");
    expect(data.people!.map((r) => r.cwid)).toEqual(["aaa1001", "bbb1002"]);
    for (const r of data.people!) {
      expect(await listLength(reachLinks(p).person(r.cwid, null))).toBe(r.papers);
      for (const t of REACH_TYPES) expect(await listLength(reachLinks(p).person(r.cwid, t))).toBe(r[t]);
    }
  });

  it("a count's link drops the search and the every-publication listing, which no count is taken under", () => {
    const links = reachLinks(parse("q=kinase&show=all&stage=T0"));
    for (const link of [links.cited(), links.type("clinical"), links.person("aaa1001", null), links.paperDocs("101", "trial")]) {
      expect(link).not.toContain("q=");
      expect(link).not.toContain("show=all");
    }
    expect(links.scope()).toContain("show=all");
  });

  it("a Citing documents count keeps the filters it was counted under, and is withheld when the URL can carry no more", async () => {
    // Under an existing document filter the count is of papers cited by both.
    const { p, data } = await open("view=documents&stage=any&doc=1");
    for (const d of data.docs) {
      const link = reachLinks(p).docPapers(d.docId)!;
      expect(parse(link).docs).toEqual([...new Set([1, d.docId])]);
      expect(await listLength(link)).toBe(d.papers);
    }
    const full = parse(Array.from({ length: MAX_DOC_FILTERS }, (_, i) => `doc=${i + 1}`).join("&"));
    expect(reachLinks(full).docPapers(1)).not.toBeNull();
    expect(reachLinks(full).docPapers(99)).toBeNull();
  });

  it("the tiles are folded from the rows the list is cut from", () => {
    const rows: ReachCounts[] = [
      { ...zeros(), clinical: 3 },
      { ...zeros(), policy: 1, patent: 2 },
      { ...zeros(), clinical: 1, trial: 1, review: 4 },
    ];
    const tiles = papersByType(rows);
    for (const t of REACH_TYPES) expect(tiles[t]).toBe(listedFor(rows, [t]).length);
    expect(tiles).toEqual({ clinical: 2, trial: 1, policy: 1, review: 1, patent: 1 });
    expect(listedFor(rows, ["trial", "patent"])).toHaveLength(2);
  });

  it("the every-publication listing pages in SQL and takes its counts from the cited rows", async () => {
    const { data } = await open("show=all");
    expect(data.pubs).toHaveLength(data.scopeTotal);
    expect(data.pubs.find((r) => r.pmid === "108")).toMatchObject(zeros());
    expect(data.pubs.find((r) => r.pmid === "101")).toMatchObject({ clinical: 1, patent: 1 });
    const page = calls().find((c) => c.text.includes("ORDER BY year DESC, p.pmid DESC"))!;
    expect(page.text).toContain("LIMIT ? OFFSET ?");
    h.queryRaw.mockClear();
    cur = { ...parse("show=all"), scope: null };
    // Newest first, then the higher PMID: 114, 104, then 113 and 111.
    expect((await loadScopePage(cur, 2, 2)).map((r) => r.pmid)).toEqual(["113", "111"]);
    expect(await loadScopeTotal(cur)).toBe(9);
  });

  it("the Citing documents listing pages in SQL, total and page from one evaluation of the grouping", async () => {
    cur = { ...parse("view=documents&stage=any"), scope: null };
    const first = await loadReachDocs(cur, 3, 0);
    const rest = await loadReachDocs(cur, EVERYTHING, 3);
    expect(first.rows).toHaveLength(3);
    expect(rest.total).toBe(first.total);
    expect(first.rows.length + rest.rows.length).toBe(first.total);
    expect(new Set([...first.rows, ...rest.rows].map((d) => `${d.level}:${d.docId}`)).size).toBe(first.total);
    // Two pages, two queries: the total rode on the rows.
    expect(calls()).toHaveLength(2);
    const page = calls()[0];
    expect(page.text).toContain("SELECT g.level, g.unit, g.papers, g.rep, COUNT(*) OVER () AS total FROM (");
    expect(page.text).toContain("ORDER BY g.papers DESC, NULLIF(SUBSTRING(g.rep, 2, 4), '9999') DESC, g.rep LIMIT ? OFFSET ?");
    // A page past the end has no row to carry the total, so it is counted on its own.
    h.queryRaw.mockClear();
    expect(await loadReachDocs(cur, 3, 9000)).toEqual({ total: first.total, rows: [] });
    expect(calls().map((c) => c.text.trim().slice(0, 24))).toEqual(["SELECT g.level, g.unit, ", "SELECT COUNT(*) AS n FRO"]);
    expect(await loadReachDocTotal(cur)).toBe(first.total);
    // Nothing matches: no second query.
    h.queryRaw.mockClear();
    cur = { ...parse("view=documents&from=2090"), scope: null };
    expect(await loadReachDocs(cur, 3, 0)).toEqual({ total: 0, rows: [] });
    expect(calls()).toHaveLength(1);
  });

  it("a stale own-work flag on a ranked document is not own work: the policy count, its list and the document's papers agree", async () => {
    // A clinical article sharing an author with the paper was flagged, then PubMed typed it as a
    // guideline: the document moved level and the link kept its flag. `guideline_count` counts it.
    fx.pubs = [...PUBS, { pmid: "115", year: 2022, stage: "T0", confidence: "high", authors: [{ cwid: "aaa1001", position: "first" }], links: [{ doc: 4, own: true }] }];
    try {
      for (const own of ["", "&own=in"]) {
        const { p, data } = await open(`stage=T0&stage=T1&from=2020${own}`);
        const row = data.pubs.find((r) => r.pmid === "115")!;
        expect(row.policy).toBe(1);
        // The cell's fallback list, the document's own row, and the papers that row opens.
        expect(await listLength(reachLinks(p).paperDocs("115", "policy"))).toBe(row.policy);
        const docs = await open(`view=documents&stage=T0&stage=T1&from=2020&ctype=policy${own}`);
        const guideline = docs.data.docs.find((d) => d.level === "guideline")!;
        expect(guideline.papers).toBe(2);
        expect(await listLength(reachLinks(docs.p).docPapers(guideline.docId)!)).toBe(guideline.papers);
        // The modal lists it too, so the cell may open there.
        cur = p;
        const modal = await loadModalCounts(p, ["115"]);
        expect(modalListsExactly("policy", row.policy, modal.get("115"), { ...modalGroupsOn(), policy: true })).toBe(true);
      }
      // Counting own work changes nothing at a level that has none.
      const out = await open("view=documents&ctype=policy&stage=any");
      const incl = await open("view=documents&ctype=policy&stage=any&own=in");
      expect(incl.data.docTotal).toBe(out.data.docTotal);
    } finally {
      fx.pubs = PUBS;
    }
  });

  it("the People tab counts everyone listed, whatever the search, because its link drops the search", async () => {
    const { p, data } = await open("view=people&stage=any&own=in&q=ben");
    expect(data.people!.map((r) => r.cwid)).toEqual(["bbb1002"]);
    expect(data.peopleTotal).toBe(2);
    expect(reachLinks(p).view("people")).not.toContain("q=");
    expect(await listLength(reachLinks(p).view("people"))).toBe(data.peopleTotal);
    expect((await open("stage=any")).data.peopleTotal).toBeNull();
  });
});

describe("does the publication modal list exactly what a cell counts?", () => {
  const on = { clinical: true, trial: true, policy: true, review: true, patent: true };
  /** `ranked` defaults to no document at both a policy level and the review level. */
  const modal = (over: Partial<ModalCounts> = {}): ModalCounts => {
    const m = { clinical: 0, trial: 0, patent: 0, policy: 0, review: 0, ...over };
    return { ranked: m.policy + m.review, ...m };
  };

  it("yes when the modal's list is the counted documents, whole", () => {
    expect(modalListsExactly("clinical", 5200, modal({ clinical: 5200 }), on)).toBe(true);
    expect(modalListsExactly("trial", 3, modal({ trial: 3 }), on)).toBe(true);
    expect(modalListsExactly("patent", 50, modal({ patent: 50 }), on)).toBe(true);
    // The "Guidelines and policy" tab counts no review, so the reviews beside it do not matter.
    expect(modalListsExactly("policy", 4, modal({ policy: 4, review: 2 }), on)).toBe(true);
    expect(modalListsExactly("policy", 4, modal({ policy: 4, review: 900 }), on)).toBe(true);
    expect(modalListsExactly("review", 3, modal({ policy: 2, review: 3 }), on)).toBe(true);
    expect(modalListsExactly("review", POLICY_REVIEWS_CAP, modal({ review: POLICY_REVIEWS_CAP }), on)).toBe(true);
  });

  it("no when one document stands at a policy level and as a review: the modal lists it once, in one group", () => {
    expect(modalListsExactly("policy", 2, modal({ policy: 2, review: 1, ranked: 2 }), on)).toBe(false);
    expect(modalListsExactly("review", 1, modal({ policy: 2, review: 1, ranked: 2 }), on)).toBe(false);
  });

  it("no when the modal would also list the authors' own work, which the count left out", () => {
    expect(modalListsExactly("clinical", 4, modal({ clinical: 5 }), on)).toBe(false);
    expect(modalListsExactly("trial", 1, modal({ trial: 2 }), on)).toBe(false);
  });

  it("no when the modal cuts its list at a cap", () => {
    expect(modalListsExactly("trial", 51, modal({ trial: 51 }), on)).toBe(false);
    expect(modalListsExactly("patent", 1600, modal({ patent: 1600 }), on)).toBe(false);
    expect(modalListsExactly("review", POLICY_REVIEWS_CAP + 1, modal({ review: POLICY_REVIEWS_CAP + 1 }), on)).toBe(false);
  });

  it("no when the modal's group is switched off, the paper was not checked, or there is nothing to list", () => {
    expect(modalListsExactly("clinical", 2, modal({ clinical: 2 }), { ...on, clinical: false })).toBe(false);
    expect(modalListsExactly("review", 2, modal({ review: 2 }), { ...on, review: false })).toBe(false);
    // A count that is not the modal's (a guideline in two journals at two levels counts twice).
    expect(modalListsExactly("policy", 2, modal({ policy: 1 }), on)).toBe(false);
    expect(modalListsExactly("clinical", 2, undefined, on)).toBe(false);
    expect(modalListsExactly("clinical", 0, modal(), on)).toBe(false);
  });

  it("a publication taken down is one the modal will not open", async () => {
    expect((await loadModalHidden([])).size).toBe(0);
    expect(h.suppressions).not.toHaveBeenCalled();
    expect([...(await loadModalHidden(["101", "102"]))]).toEqual([]);
    h.suppressions.mockResolvedValue([{ entityId: "102", contributorCwid: null }]);
    expect([...(await loadModalHidden(["101", "102"]))]).toEqual(["102"]);
  });

  it("the modal's side is read for one page of papers, own work included, and only for papers the viewer may see", async () => {
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }] }));
    cur = await resolveReachParams(parse("stage=any"), ADMIN);
    const got = await loadModalCounts(cur, ["101", "104", "106"]);
    // 106 belongs to another department.
    expect([...got.keys()].sort()).toEqual(["101", "104"]);
    // Both clinical articles and both patent documents (one invention) are in the modal's list.
    expect(got.get("101")).toEqual({ clinical: 2, trial: 1, patent: 1, policy: 0, review: 0, ranked: 0 });
    expect(got.get("104")).toMatchObject({ trial: 1 });
    const { text, values } = calls().at(-1)!;
    expect(text).toContain("WHERE p.pmid IN (?,?,?)");
    expect(text).toContain("s.dept_code IN (?)");
    expect(values).toEqual(expect.arrayContaining(["101", "104", "106", "N1"]));
    h.queryRaw.mockClear();
    expect((await loadModalCounts(cur, [])).size).toBe(0);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe("systematic reviews are a citing type of their own (plan decision 10)", () => {
  it("the two ranked types split report 24's four levels between them, with nothing in both", () => {
    expect(REACH_LEVELS.policy).toEqual(["authority", "guideline", "consensus"]);
    expect(REACH_LEVELS.review).toEqual(["review"]);
    expect([...REACH_LEVELS.policy, ...REACH_LEVELS.review].sort()).toEqual([...POLICY_LEVELS].sort());
    expect(REACH_TYPES).toEqual(["clinical", "trial", "policy", "review", "patent"]);
    expect(REACH_TYPE_LABEL.review).toBe("Systematic reviews");
    expect(reachTypeOfLevel("review")).toBe("review");
    for (const l of REACH_LEVELS.policy) expect(reachTypeOfLevel(l)).toBe("policy");
  });

  it("Guidelines and policy counts no systematic review, and Systematic reviews counts nothing else", async () => {
    for (const own of ["", "&own=in"]) {
      for (const [t, levels] of [["policy", REACH_LEVELS.policy], ["review", REACH_LEVELS.review]] as const) {
        const { data } = await open(`view=documents&stage=any&ctype=${t}${own}`);
        expect(data.docs.length, t).toBeGreaterThan(0);
        for (const d of data.docs) {
          expect(levels as readonly string[], `${t} ${d.level}`).toContain(d.level);
          expect(d.type).toBe(t);
        }
      }
    }
    // The per-paper counts, against the fixture: 102 has one guideline (in two journals) and one review.
    const { data } = await open("stage=any");
    const r102 = data.pubs.find((r) => r.pmid === "102")!;
    expect([r102.policy, r102.review]).toEqual([1, 1]);
  });

  it("a paper cited only by a systematic review is under Systematic reviews and not under Guidelines and policy", async () => {
    const reviews = await open("ctype=review");
    const policy = await open("ctype=policy");
    expect(reviews.data.pubs.map((r) => r.pmid)).toContain("111");
    expect(policy.data.pubs.map((r) => r.pmid)).not.toContain("111");
    expect(reviews.data.typePapers).toEqual(policy.data.typePapers);
    expect(reviews.data.typePapers).toMatchObject({ policy: 1, review: 2 });
    // Its Systematic reviews cell opens a list of one review; no Guidelines and policy cell has a count.
    const row = reviews.data.pubs.find((r) => r.pmid === "111")!;
    expect(row).toMatchObject({ policy: 0, review: 1 });
    expect(await listLength(reachLinks(reviews.p).paperDocs("111", "review"))).toBe(1);
    expect(await listLength(reachLinks(reviews.p).paperDocs("111", "policy"))).toBe(0);
  });

  it("an old link's ctype=policy still opens, and now means guidelines and policy without reviews", async () => {
    const old = parse("ctype=policy&stage=T0&stage=T1&from=2020");
    expect(old.ctypes).toEqual(["policy"]);
    expect(tickedTypes(old)).toEqual(["policy"]);
    expect(reachQueryString(old)).toBe("stage=T0&stage=T1&ctype=policy&basis=cy&from=2020");
    const { data } = await open("ctype=policy&stage=T0&stage=T1&from=2020");
    expect(data.pubs.map((r) => r.pmid)).toEqual(["102"]);
    // `review` is a value of its own and round-trips; no ctype is all five.
    const both = parse("ctype=review&ctype=policy");
    expect(both.ctypes).toEqual(["policy", "review"]);
    expect(parse(reachQueryString(both))).toEqual(both);
    expect(tickedTypes(parse())).toEqual(REACH_TYPES);
    expect(reachChips({ ...parse("ctype=review"), scope: null }).find((c) => c.group === "Citing type")).toMatchObject({
      value: "Systematic reviews",
    });
  });

  it("every Systematic reviews link round-trips, and its count is the length of its list", async () => {
    for (const qs of ["", "stage=any", "stage=any&own=in", "ctype=review&stage=any", "view=people&stage=any&own=in"]) {
      const { p, data } = await open(qs);
      const links = reachLinks(p);
      const roundTrips = (link: string) => expect(reachQueryString(parse(link))).toBe(link);
      roundTrips(links.type("review"));
      expect(parse(links.type("review")).ctypes).toEqual(["review"]);
      expect(await listLength(links.type("review")), `${qs} tile`).toBe(data.typePapers.review);
      if (p.view === "publications") {
        for (const r of data.pubs.filter((x) => x.review > 0)) {
          roundTrips(links.paperDocs(r.pmid, "review"));
          expect(await listLength(links.paperDocs(r.pmid, "review")), `${qs} ${r.pmid}`).toBe(r.review);
        }
      } else {
        for (const r of data.people!) {
          roundTrips(links.person(r.cwid, "review"));
          expect(await listLength(links.person(r.cwid, "review")), `${qs} ${r.cwid}`).toBe(r.review);
        }
      }
    }
    // A systematic review's Citing documents row, and the papers it opens.
    const { p, data } = await open("view=documents&stage=any&ctype=review");
    const review = data.docs.find((d) => d.level === "review")!;
    expect(review.papers).toBe(2);
    expect((await withReachDocDetails([review]))[0].kind).toBe("Systematic review");
    const link = reachLinks(p).docPapers(review.docId)!;
    expect(reachQueryString(parse(link))).toBe(link);
    expect(await listLength(link)).toBe(review.papers);
  });

  it("reads the review rollup on its own, and the review level alone, in SQL", async () => {
    await open("view=documents&ctype=review");
    const docs = calls().find((c) => c.text.includes("GROUP BY d.level, unit"))!;
    expect(docs.text).toContain("WHERE (p.review_count > 0) AND");
    expect(docs.text).toContain("WHERE d.level IN (?)");
    expect(docs.values).toContain("review");
    expect(docs.values).not.toContain("guideline");
    h.queryRaw.mockClear();
    await open("view=documents&ctype=policy");
    const policy = calls().find((c) => c.text.includes("GROUP BY d.level, unit"))!;
    expect(policy.text).toContain("WHERE ((p.authority_count + p.guideline_count + p.consensus_count) > 0) AND");
    expect(policy.text).not.toContain("review_count");
    expect(policy.values).not.toContain("review");
  });

  it("the modal: each cell opens it only where its group lists exactly the counted documents", async () => {
    cur = { ...parse("stage=any"), scope: null };
    const got = await loadModalCounts(cur, ["102", "111"]);
    // 102: one guideline (two journals, one dedup_key) and one review; 111: one review.
    expect(got.get("102")).toMatchObject({ policy: 1, review: 1, ranked: 2 });
    expect(got.get("111")).toMatchObject({ policy: 0, review: 1, ranked: 1 });
    const on = { ...modalGroupsOn(), policy: true, review: true };
    expect(modalListsExactly("policy", 1, got.get("102"), on)).toBe(true);
    expect(modalListsExactly("review", 1, got.get("102"), on)).toBe(true);
    expect(modalListsExactly("review", 1, got.get("111"), on)).toBe(true);
    expect(modalListsExactly("policy", 0, got.get("111"), on)).toBe(false);
    // The modal's switch for both is the guideline badges' flag.
    const offOn = modalGroupsOn();
    expect(offOn.review).toBe(offOn.policy);
    const sql = calls().at(-1)!;
    expect(sql.text).toContain("THEN d.dedup_key END) AS policy");
    expect(sql.text).toContain("THEN d.dedup_key END) AS review");
    expect(sql.text).toContain("THEN d.dedup_key END) AS ranked");
  });
});

describe("scope narrowing", () => {
  const scoped = async (qs = "") => {
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }] }));
    cur = await resolveReachParams(parse(qs), ADMIN);
    return cur;
  };
  /** Every query either carries the viewer's department, or reads citing-document facts alone. */
  const expectEveryQueryScoped = () => {
    let scopedQueries = 0;
    for (const { text, values } of calls()) {
      if (readsPeopleOrPapers(text)) {
        expect(text, text).toContain("s.dept_code IN (?)");
        expect(values, text).toContain("N1");
        scopedQueries += 1;
      } else {
        expect(text, text).toMatch(/ FROM citing_document d WHERE d\.id IN /);
        expect(text, text).not.toContain("publication_citing_document");
      }
    }
    return scopedQueries;
  };

  it("a superuser and a comms steward see everything: no scope clause", async () => {
    for (const session of [SUPER, { ...ADMIN, isCommsSteward: true }]) {
      const p = await resolveReachParams(parse(), session);
      expect(p.scope).toBeNull();
    }
    await open("");
    for (const { text } of calls()) expect(text).not.toContain("dept_code");
  });

  it("a unit administrator is pinned to their units, whatever the URL says", async () => {
    const p = await scoped("unit=dept:N2&scope=dept:N2");
    expect(p.scope).toEqual(["dept:N1"]);
    // The URL's unit is AND-ed with the scope, so a unit outside it matches nobody.
    const data = await loadReach(p, { views: ["publications", "documents", "people"], limit: EVERYTHING });
    expect(data.scopeTotal).toBe(0);
    expect(data.pubs).toEqual([]);
    expect(data.docs).toEqual([]);
    expect(data.people).toEqual([]);
  });

  it("someone who administers no unit matches nothing", async () => {
    h.manageable.mockResolvedValue(units());
    const p = await resolveReachParams(parse(), ADMIN);
    expect(p.scope).toEqual([]);
    cur = p;
    await loadReachCounts(p);
    expect(calls().at(-1)!.text).toContain("AND 1 = 0");
  });

  it.each([
    ["the default page", ""],
    ["all three views with a search", "q=101&stage=any"],
    ["own work included", "own=in"],
    ["a paper and a citing document", "pmid=101&doc=1&stage=any"],
    ["every publication in scope", "show=all"],
  ])("every query carries the scope: %s", async (_what, qs) => {
    const p = await scoped(qs);
    h.queryRaw.mockClear();
    const data = await loadReach(p, { views: ["publications", "documents", "people"], limit: EVERYTHING });
    await withReachPublicationDetails(p, data.pubs);
    await loadModalCounts(p, data.pubs.map((r) => r.pmid));
    expect(expectEveryQueryScoped()).toBeGreaterThanOrEqual(5);
  });

  it("a unit administrator sees only their units' papers and people", async () => {
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N2" }] }));
    const { data, p } = await open("stage=any&view=people&own=in", ADMIN, ["publications", "people"]);
    // Ben's papers only: 102 (middle), 106, 113, 114.
    expect(data.pubs.map((r) => r.pmid).sort()).toEqual(["102", "106", "113", "114"]);
    expect(data.people!.map((r) => r.cwid)).toEqual(["bbb1002"]);
    // On a shared paper the other department's author is not shown.
    const rows = await withReachPublicationDetails(p, data.pubs);
    expect(rows.find((r) => r.pmid === "102")!.authors.map((a) => a.cwid)).toEqual(["bbb1002"]);
  });

  it("the download route pins the same scope, and refuses a viewer with no session or no unit", async () => {
    const url = "https://scholars.example/api/edit/reports/downstream-reach?unit=dept:N2&stage=any";
    h.session.mockResolvedValue(null);
    expect((await GET(new Request(url))).status).toBe(401);
    h.session.mockResolvedValue(ADMIN);
    h.manageable.mockResolvedValue(units());
    expect((await GET(new Request(url))).status).toBe(403);

    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }] }));
    cur = await resolveReachParams(parse("unit=dept:N2&stage=any"), ADMIN);
    h.queryRaw.mockClear();
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Downstream reach \d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(expectEveryQueryScoped()).toBeGreaterThanOrEqual(4);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.getWorksheet("Publications")!.rowCount).toBe(1);
  });

  it("the scope is a chip that cannot be removed, and a Criteria row", async () => {
    const p = await scoped("stage=T0&ctype=patent&own=in&area=area_a&pmid=101&doc=7&show=all");
    const labels = new Map([["dept:N1", "Department of Examples"]]);
    const chips = reachChips(p, labels, new Map(), new Map([["area_a", "Example area"]]));
    expect(chips[0]).toEqual({ group: "Unit", value: "Department of Examples", removeQuery: null });
    expect(chips.map((c) => `${c.group}: ${c.value}`)).toEqual([
      "Unit: Department of Examples",
      "Stage: T0 · Basic research",
      "Citing type: Patents",
      "Authors' own work: Included",
      "Research area: Example area",
      "Paper: PMID 101",
      "Cited by: Example method",
      "Listing: Every publication in scope",
    ]);
    // Removing a chip removes that filter and nothing else.
    const own = chips.find((c) => c.group === "Authors' own work")!;
    expect(parse(own.removeQuery!)).toMatchObject({ includeOwn: false, ctypes: ["patent"], pmid: "101", docs: [7] });
    const criteria = new Map(describeReachCriteria(p, new Date("2026-11-26T12:00:00Z"), labels));
    expect(criteria.get("Access")).toBe("Limited to the units you administer: Department of Examples");
    expect(criteria.get("Translational stage of the cited paper")).toBe("T0 · Basic research");
    expect(criteria.get("Citing type")).toBe("Patents");
    expect(criteria.get("Authors' own work")).toBe("Counted");
    expect(criteria.get("Cited by (citing document)")).toBe("Example method");
  });
});

describe("the workbook", () => {
  const pub = (over: Partial<ReachPubRow> = {}): ReachPubRow => ({
    pmid: "101",
    year: 2021,
    stage: "T0",
    clinical: 4,
    trial: 1,
    policy: 0,
    review: 3,
    patent: 2,
    title: "A <i>paper</i> about examples",
    journal: "Journal of Examples",
    doi: "10.1000/example.101",
    authors: [{ cwid: "aaa1001", name: "Ada Example", position: "first" }],
    ...over,
  });
  const person = (i: number): ReachPersonRow => ({
    cwid: `zzz${String(i).padStart(4, "0")}`,
    name: `Person ${String(i).padStart(3, "0")}`,
    orgUnit: "Department of Examples",
    personType: "Full-time faculty",
    institution: "Example Institution",
    papers: 3 + (i % 4),
    clinical: 2,
    trial: 0,
    policy: 1,
    review: 2,
    patent: 1,
  });
  const read = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  };
  const AT = new Date("2026-11-26T12:00:00Z");

  it("four sheets, in order, with plain titles and one column per ticked type", async () => {
    const p = { ...parse("ctype=clinical&ctype=patent"), scope: null };
    const wb = await read(
      await buildReachWorkbook(
        p,
        {
          pubs: [pub()],
          pubTotal: 1,
          docs: [{ docId: 7, level: "patent", type: "patent", year: 2024, application: false, papers: 2, title: "Example method", url: "https://example.org/doc/7", kind: "Patent", source: "US90000001B2" }],
          docTotal: 1,
          people: [person(1)],
        },
        AT,
      ),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Publications", "Citing documents", "People", "Criteria"]);
    const pubs = wb.getWorksheet("Publications")!;
    expect(pubs.getRow(1).values).toEqual([undefined, "PMID", "Title", "Journal", "Year", "Stage", "WCM authors", "Total", "Clinical studies", "Patents", "DOI"]);
    expect(pubs.getRow(2).values).toEqual([undefined, "101", "A paper about examples", "Journal of Examples", 2021, "T0 · Basic research", "Ada Example (first author)", 6, 4, 2, "10.1000/example.101"]);
    expect(wb.getWorksheet("Citing documents")!.getRow(2).values).toEqual([undefined, "Example method", "Patent", "US90000001B2", 2024, 2, "https://example.org/doc/7"]);
    expect(wb.getWorksheet("People")!.getRow(1).values).toEqual([
      undefined,
      "Name",
      "CWID",
      "Org unit",
      "Person type",
      "Primary institution",
      "Papers cited downstream",
      "Papers cited by clinical studies",
      "Papers cited in patents",
    ]);
  });

  it("all five types: a Systematic reviews column after Guidelines and policy on every sheet with per-type counts", async () => {
    const p = { ...parse(), scope: null };
    const wb = await read(await buildReachWorkbook(p, { pubs: [pub()], pubTotal: 1, docs: [], docTotal: 0, people: [person(1)] }, AT));
    const pubs = wb.getWorksheet("Publications")!;
    expect((pubs.getRow(1).values as unknown[]).slice(7)).toEqual([
      "Total",
      "Clinical studies",
      "Registered trials",
      "Guidelines and policy",
      "Systematic reviews",
      "Patents",
      "DOI",
    ]);
    expect((pubs.getRow(2).values as unknown[]).slice(7)).toEqual([10, 4, 1, 0, 3, 2, "10.1000/example.101"]);
    const people = wb.getWorksheet("People")!;
    expect((people.getRow(1).values as unknown[]).slice(7)).toEqual([
      "Papers cited by clinical studies",
      "Papers cited by registered trials",
      "Papers cited in guidelines or policy",
      "Papers cited in systematic reviews",
      "Papers cited in patents",
    ]);
    expect((people.getRow(2).values as unknown[]).slice(7)).toEqual([2, 0, 1, 2, 1]);
    // Only the ticked type, when one is ticked.
    const only = await read(
      await buildReachWorkbook({ ...parse("ctype=review"), scope: null }, { pubs: [pub()], pubTotal: 1, docs: [], docTotal: 0, people: [person(1)] }, AT),
    );
    expect((only.getWorksheet("Publications")!.getRow(1).values as unknown[]).slice(7)).toEqual(["Total", "Systematic reviews", "DOI"]);
    expect((only.getWorksheet("People")!.getRow(1).values as unknown[]).slice(7)).toEqual(["Papers cited in systematic reviews"]);
    const criteria = new Map(
      (only.getWorksheet("Criteria")!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => [String(r[1]), String(r[2])]),
    );
    expect(criteria.get("Citing type")).toBe("Systematic reviews");
    expect(criteria.get("Citing types")).toBe(REACH_REVIEW_RULE);
  });

  it("the People sheet lists everyone past the 50-scholar cap: the named exception, and no contact column", async () => {
    // The shared cap itself is untouched.
    expect(SCHOLAR_EXPORT_CAP).toBe(50);
    const everyone = Array.from({ length: SCHOLAR_EXPORT_CAP + 37 }, (_, i) => person(i));
    const wb = await read(
      await buildReachWorkbook({ ...parse(), scope: null }, { pubs: [], pubTotal: 0, docs: [], docTotal: 0, people: everyone }, AT),
    );
    const people = wb.getWorksheet("People")!;
    expect(people.rowCount).toBe(everyone.length + 1);
    const header = (people.getRow(1).values as unknown[]).filter(Boolean).map(String);
    expect(header.some((x) => /e-?mail|phone|contact/i.test(x))).toBe(false);
    for (let r = 2; r <= people.rowCount; r++) {
      for (const cell of people.getRow(r).values as unknown[]) expect(String(cell ?? "")).not.toContain("@");
    }
    const criteria = new Map(
      (wb.getWorksheet("Criteria")!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => [String(r[1]), String(r[2])]),
    );
    expect(criteria.get("People sheet")).toBe(
      `Lists all ${everyone.length} people, with no contact details. This report follows report 24's exemption from the 50-person limit on scholar exports (extended to this report 2026-11-26).`,
    );
    expect(criteria.get("Report")).toBe("27. Downstream reach");
    expect(criteria.get("Authors' own work")).toBe("Left out");
    expect(criteria.get("Translational stage of the cited paper")).toBe("T0 · Basic research; T1 · Early translation");
    expect(criteria.get("Citing type")).toBe("All");
  });

  it("the download lists every person through the route too, and says where a sheet was cut", async () => {
    // Sixty first authors with three cited papers each, alongside the fixture.
    const extra = Array.from({ length: 60 }, (_, i) => ({ cwid: `yyy${String(i).padStart(4, "0")}`, name: `Extra ${String(i).padStart(2, "0")}`, dept: "N3", active: true }));
    const extraPubs: Pub[] = extra.flatMap((s, i) =>
      [0, 1, 2].map((k) => ({ pmid: String(9000 + i * 3 + k), year: 2022, stage: "T0", confidence: "high", authors: [{ cwid: s.cwid, position: "first" as const }], links: [{ doc: 1 }] })),
    );
    fx.scholars = [...SCHOLARS, ...extra];
    fx.pubs = [...PUBS, ...extraPubs];
    try {
      h.session.mockResolvedValue(SUPER);
      cur = await resolveReachParams(parse("view=people"), SUPER);
      const res = await GET(new Request("https://scholars.example/api/edit/reports/downstream-reach?view=people"));
      expect(res.status).toBe(200);
      const wb = await read(Buffer.from(await res.arrayBuffer()));
      const people = wb.getWorksheet("People")!;
      // Ada and the sixty: all of them, past the cap of 50.
      expect(people.rowCount - 1).toBe(61);
      expect(people.rowCount - 1).toBeGreaterThan(SCHOLAR_EXPORT_CAP);
      const criteria = new Map(
        (wb.getWorksheet("Criteria")!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => [String(r[1]), String(r[2])]),
      );
      expect(criteria.get("Publications sheet")).toMatch(/^Lists all 187 publications/);
      expect(criteria.get("People sheet")).toMatch(/^Lists all 61 people, with no contact details\./);
    } finally {
      fx.scholars = SCHOLARS;
      fx.pubs = PUBS;
    }
  });
});

// ---------------------------------------------------------------------------
// The two doors into the report (`downstream-reach-entry.ts`): the scholar's
// Bibliometrics block and the portfolio report's tile. Same rule: each number
// equals the row count of the list its link opens.
// ---------------------------------------------------------------------------

/** A door's link, as the query string the report page would parse. */
const qsOf = (href: string) => {
  expect(href.startsWith(`${REACH_REPORT_PATH}?`)).toBe(true);
  return href.slice(REACH_REPORT_PATH.length + 1);
};
const N2_ADMIN = () => h.manageable.mockResolvedValue(units({ departments: [{ code: "N2" }] }));

describe("the Bibliometrics tab's Downstream reach block", () => {
  async function block(cwid: string, session = SUPER) {
    const want = scholarReachParams(cwid);
    if (want) cur = await resolveReachParams(want, session);
    return loadScholarReach(cwid, session);
  }

  it("each line's number is the row count of the list its link opens", async () => {
    const reach = (await block("aaa1001"))!;
    expect(reach.lines.map((l) => [l.type, l.papers])).toEqual([
      // 101, 102, 105 (No stage), 107 (2019) and 109 (middle author); 103 is cited only by the authors' own article.
      ["clinical", 5],
      // 101; 104's trial is the authors' own.
      ["trial", 1],
      // 102's guideline; 106's is another scholar's.
      ["policy", 1],
      // 102 and 111: 111 is cited by a systematic review and no guideline.
      ["review", 2],
      ["patent", 3],
    ]);
    for (const l of reach.lines) expect(await listLength(qsOf(l.href)), l.type).toBe(l.papers);
    expect(reach.note).toBe(SCHOLAR_REACH_NOTE);
  });

  it("covers every stage, year and author position, and its links say so", async () => {
    const reach = (await block("aaa1001"))!;
    for (const l of reach.lines) {
      const p = parse(qsOf(l.href));
      expect(p).toMatchObject({
        people: ["aaa1001"],
        ctypes: [l.type],
        stages: [],
        positions: [],
        units: [],
        types: [],
        from: null,
        to: null,
        basis: "cy",
        includeOwn: false,
        area: null,
        view: "publications",
        showAll: false,
      });
      expect(qsOf(l.href)).toContain("stage=any");
    }
    // The report's default (T0 and T1, 2020 on) would list fewer.
    const clinical = reach.lines.find((l) => l.type === "clinical")!;
    expect(await listLength("person=aaa1001&ctype=clinical&stage=T0&stage=T1&from=2020")).toBeLessThan(clinical.papers);
  });

  it("always has one line per citing type: a zero is a line, and a link to its empty list", async () => {
    const reach = (await block("bbb1002"))!;
    expect(reach.lines.map((l) => l.type)).toEqual([...REACH_TYPES]);
    expect(reach.lines.find((l) => l.type === "patent")!.papers).toBe(0);
    for (const l of reach.lines) expect(await listLength(qsOf(l.href)), l.type).toBe(l.papers);
    // Their only authorship is unconfirmed: nothing cites their work, and the
    // block says so in a zero per type instead of going missing.
    const none = (await block("ddd1004"))!;
    expect(none.lines.map((l) => [l.type, l.papers])).toEqual(REACH_TYPES.map((t) => [t, 0]));
    for (const l of none.lines) expect(await listLength(qsOf(l.href)), l.type).toBe(0);
  });

  it("is absent with the flag off, and reads nothing", async () => {
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "off");
    expect(await loadScholarReach("aaa1001", SUPER)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.manageable).not.toHaveBeenCalled();
  });

  it("is absent for a viewer who cannot open the report, and reads no publication", async () => {
    // Administers nothing: report 27 is not theirs to open.
    expect(await loadScholarReach("aaa1001", ADMIN)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("gives a unit administrator nothing for a scholar outside their units, and the report's own numbers inside them", async () => {
    N2_ADMIN();
    expect(await block("aaa1001", ADMIN)).toBeNull();
    const reach = (await block("bbb1002", ADMIN))!;
    expect(reach.lines.map((l) => l.type)).toEqual([...REACH_TYPES]);
    for (const l of reach.lines) expect(await listLength(qsOf(l.href), ADMIN), l.type).toBe(l.papers);
    // The scope rides in the query, never in the link.
    expect(calls().every((c) => !readsPeopleOrPapers(c.text) || c.values.includes("N2"))).toBe(true);
    for (const l of reach.lines) expect(l.href).not.toContain("N2");
  });

  it("shows nothing for an identifier the report's link cannot carry", async () => {
    expect(scholarReachParams("x".repeat(17))).toBeNull();
    expect(await loadScholarReach("x".repeat(17), SUPER)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe("the portfolio report's Downstream reach tile", () => {
  const portfolio = (qs: string) => parsePortfolioParams(new URLSearchParams(qs));
  async function tile(qs: string, session = SUPER) {
    const want = portfolioReachParams(portfolio(qs));
    if (want) cur = await resolveReachParams(want, session);
    return loadPortfolioReachTile(portfolio(qs), session);
  }

  it("N and M are the row counts of the lists their links open, for each filter state", async () => {
    for (const qs of [
      "from=2020&to=2024",
      "from=2019&to=2022",
      "unit=dept:N1&from=2020&to=2024",
      "unit=dept:N2&from=2020&to=2024",
      "area=area_a&from=2020&to=2024",
      "cwid=aaa1001&from=2020&to=2024",
      "unit=dept:N1&area=area_a&cwid=aaa1001&from=2021&to=2023",
      // A stage pick on the page is not carried: the tile stays T0 and T1.
      "stage=T2&from=2020&to=2024",
    ]) {
      const t = (await tile(qs))!;
      expect(await listLength(qsOf(t.citedHref)), `N ${qs}`).toBe(t.cited);
      expect(await listLength(qsOf(t.totalHref)), `M ${qs}`).toBe(t.total);
      expect(t.cited).toBeLessThanOrEqual(t.total);
    }
    // 101, 102, 109, 113 and 114 of the nine T0 and T1 papers of 2020 to 2024 in scope
    // (103 is cited only by its authors' own article; 104, 108 and 111 by no clinical study).
    expect(await tile("from=2020&to=2024")).toMatchObject({ cited: 5, total: 9 });
  });

  it("the links carry the page's unit, years and area, stage T0 and T1, citing type clinical", async () => {
    const t = (await tile("unit=dept:N1&area=area_a&from=2021&to=2023&stage=T2&by=area&view=scholars&page=3"))!;
    const cited = parse(qsOf(t.citedHref));
    expect(cited).toMatchObject({
      units: ["dept:N1"],
      area: "area_a",
      from: 2021,
      to: 2023,
      basis: "cy",
      stages: ["T0", "T1"],
      ctypes: ["clinical"],
      people: [],
      positions: [],
      types: [],
      includeOwn: false,
      view: "publications",
      showAll: false,
      page: 1,
    });
    // M: the same filters, every publication in scope.
    expect(parse(qsOf(t.totalHref))).toEqual({ ...cited, showAll: true });
  });

  it("one scholar in scope is that scholar's first- or senior-author papers, as on the page", async () => {
    const t = (await tile("cwid=aaa1001&from=2020&to=2024"))!;
    expect(parse(qsOf(t.citedHref))).toMatchObject({ people: ["aaa1001"], positions: ["first", "last"] });
    // 109 is a middle authorship: in the unfiltered tile, not in this one.
    const all = (await tile("from=2020&to=2024"))!;
    expect(t.total).toBeLessThan(all.total);
  });

  it("is absent with the flag off, and reads nothing", async () => {
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "off");
    expect(await loadPortfolioReachTile(portfolio("from=2020&to=2024"), SUPER)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.manageable).not.toHaveBeenCalled();
  });

  it("is absent for a viewer who cannot open the report", async () => {
    expect(await loadPortfolioReachTile(portfolio("from=2020&to=2024"), ADMIN)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("is absent where report 27 would narrow the page for a unit administrator, and counts nothing", async () => {
    N2_ADMIN();
    // The page shows all of WCM, or another unit; report 27 would list only N2.
    for (const qs of ["from=2020&to=2024", "unit=dept:N1&from=2020&to=2024", "unit=dept:N1&unit=dept:N2&from=2020&to=2024", "cwid=bbb1002&from=2020&to=2024"]) {
      expect(await tile(qs, ADMIN), qs).toBeNull();
    }
    expect(calls().some((c) => readsPeopleOrPapers(c.text))).toBe(false);
  });

  it("is shown to a unit administrator for their own unit, with the report's numbers for them", async () => {
    N2_ADMIN();
    const t = (await tile("unit=dept:N2&from=2020&to=2024", ADMIN))!;
    expect(await listLength(qsOf(t.citedHref), ADMIN)).toBe(t.cited);
    expect(await listLength(qsOf(t.totalHref), ADMIN)).toBe(t.total);
    // The same unit, seen by a superuser: the scope adds nothing to it.
    h.manageable.mockResolvedValue(units());
    expect(await tile("unit=dept:N2&from=2020&to=2024")).toEqual(t);
  });

  it("is absent for a filter the report's link cannot carry", async () => {
    // The portfolio page accepts a longer identifier than report 27's `person`.
    const long = `cwid=${"x".repeat(20)}&from=2020&to=2024`;
    expect(portfolio(long).cwid).toHaveLength(20);
    expect(portfolioReachParams(portfolio(long))).toBeNull();
    expect(await loadPortfolioReachTile(portfolio(long), SUPER)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("is absent with more than one research area ticked (report 27 takes one)", async () => {
    const two = "area=area_a&area=area_b&from=2020&to=2024";
    expect(portfolio(two).areas).toEqual(["area_a", "area_b"]);
    expect(portfolioReachParams(portfolio(two))).toBeNull();
    expect(await loadPortfolioReachTile(portfolio(two), SUPER)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("carries a person type to report 27, which takes the same type filter", () => {
    expect(portfolioReachParams(portfolio("unit=dept:N1&type=full_time_faculty&from=2020&to=2024"))?.types).toEqual(["full_time_faculty"]);
  });

  it("is absent under a primary institution filter (report 27 would OR it with the unit)", async () => {
    const inst = "unit=dept:N1&inst=HSS&from=2020&to=2024";
    expect(portfolioReachParams(portfolio(inst))).toBeNull();
    expect(await loadPortfolioReachTile(portfolio(inst), SUPER)).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});
