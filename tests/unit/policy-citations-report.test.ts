/** Report 24 (Guideline and policy citations): the param parser and its
 *  defaults, the ranked sort, what Level lists, the scope narrowing for a unit
 *  administrator (in the lib, in every query, and through the download
 *  route), de-dup by `dedupKey`, excluded-study citations, edition grouping,
 *  the By citing document fold, and the workbook's sheets (People: no cap, no
 *  contact column; Citations; Criteria). Fixture people, units and documents
 *  are invented. */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  manageable: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { read: { $queryRaw: h.queryRaw }, write: {} } }));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: h.manageable }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({ roleCategories: [], departments: [], centers: [], institutions: [] })),
}));

import { GET } from "@/app/api/edit/reports/policy-citations/route";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { Prisma } from "@/lib/generated/prisma/client";
import { REPORTS } from "@/lib/edit/report-registry";
import {
  buildPolicyCitationWorkbook,
  canViewPolicyCitationsReport,
  citedSql,
  compareRanked,
  dedupeDocs,
  describePolicyCitationCriteria,
  editionTitle,
  groupDocLinks,
  groupEditions,
  howCited,
  isExcludedStudyCitation,
  isPolicyCitationDefault,
  listedAt,
  loadCitationPairs,
  loadCitingDocuments,
  loadDocLinks,
  loadPersonCounts,
  loadPolicyCitations,
  loadPolicyDocuments,
  loadPublicationCounts,
  POLICY_CITATIONS_CAP,
  policySummary,
  REVIEWS_SHOWN,
  searchPublications,
  sortDocGroups,
  yearRange,
  type DocLink,
  parsePolicyCitationParams,
  policyCitationChips,
  policyCitationQueryString,
  policyScopeSql,
  policyTiles,
  resolvePolicyCitationParams,
  sortPublications,
  type PersonRow,
  type PolicyCitationData,
  type PubCounts,
} from "@/lib/edit/policy-citations-report";

const parse = (qs = "") => parsePolicyCitationParams(new URLSearchParams(qs));
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
/** A `Prisma.Sql` as one-spaced text plus its bound values. */
const flat = (sql: Prisma.Sql) => ({ text: sql.sql.replace(/\s+/g, " "), values: sql.values });
/** The n-th `$queryRaw` tagged-template call, re-composed. */
const call = (n: number) => {
  const [strings, ...values] = h.queryRaw.mock.calls[n] as [TemplateStringsArray, ...unknown[]];
  return flat(Prisma.sql(strings, ...values));
};

beforeEach(() => {
  h.queryRaw.mockReset().mockResolvedValue([]);
  h.manageable.mockReset().mockResolvedValue(units());
  h.session.mockReset();
});

describe("parsePolicyCitationParams", () => {
  it("a bare URL lists everything above systematic reviews published 2020 or later, by publication, ranked", () => {
    expect(parse()).toMatchObject({
      types: [],
      units: [],
      people: [],
      positions: [],
      levels: ["authority", "guideline", "consensus"],
      bodies: [],
      hideExcluded: false,
      basis: "cy",
      from: 2020,
      to: null,
      cfrom: null,
      cto: null,
      view: "publications",
      sort: "ranked",
      docSort: "recent",
      q: "",
      page: 1,
    });
    // View state alone is still a bare URL.
    expect(parse("view=documents&sort=recent&dsort=papers&q=%20stroke%20&page=3")).toMatchObject({
      levels: ["authority", "guideline", "consensus"],
      from: 2020,
      view: "documents",
      sort: "recent",
      docSort: "papers",
      q: "stroke",
      page: 3,
    });
    expect(isPolicyCitationDefault(parse("view=people&q=abc&page=2&dsort=body"))).toBe(true);
  });

  it("Reset to defaults is 2020 or later: the same filters spelled out are the default, any year is not", () => {
    const spelled = "basis=cy&from=2020&level=authority&level=guideline&level=consensus";
    expect(isPolicyCitationDefault(parse(spelled))).toBe(true);
    // The canonical string of the default keeps the year, so a tab or sort link does not lose it.
    expect(policyCitationQueryString(parse())).toContain("from=2020");
    expect(parse(policyCitationQueryString(parse())).from).toBe(2020);
    // "Any" in the From select submits an empty `from` with the form: no default comes back.
    expect(parse("basis=cy&from=&level=authority&level=guideline&level=consensus").from).toBeNull();
    expect(isPolicyCitationDefault(parse("basis=cy&level=authority&level=guideline&level=consensus"))).toBe(false);
    expect(isPolicyCitationDefault(parse(`${spelled}&excl=1`))).toBe(false);
  });

  it("a submitted form is taken as-is: no level ticked means every level, not the default", () => {
    expect(parse("basis=cy").levels).toEqual([]);
    expect(parse("basis=cy").from).toBeNull();
    expect(parse("basis=cy&level=review&level=authority").levels).toEqual(["authority", "review"]);
    expect(isPolicyCitationDefault(parse("basis=cy"))).toBe(false);
  });

  it("drops what it does not know and keeps ranges in order", () => {
    const p = parse(
      "level=bogus&body=WHO&body=Nobody&pos=last&pos=senior&person=abc1234&person=x'--&basis=fy&from=2020&to=2010&cfrom=abc&cto=2025&sort=reviews&dsort=title&view=grid&excl=yes&page=-4",
    );
    expect(p).toMatchObject({
      levels: [],
      bodies: ["WHO"],
      positions: ["last"],
      people: ["abc1234"],
      basis: "fy",
      from: 2020,
      to: 2020,
      cfrom: null,
      cto: 2025,
      sort: "ranked",
      docSort: "recent",
      view: "publications",
      hideExcluded: false,
      page: 1,
    });
    expect(parse("basis=cy&excl=1").hideExcluded).toBe(true);
    expect(parse(`q=${"x".repeat(300)}`).q).toHaveLength(100);
  });

  it("takes the who-filter from the shared parser", () => {
    expect(parse("type=full_time_faculty&unit=dept:N1&unit=center:C9")).toMatchObject({
      types: ["full_time_faculty"],
      units: ["dept:N1", "center:C9"],
    });
  });

  it("never reads a scope from the URL: unresolved params match nothing", () => {
    const p = parse("scope=dept:N1&unit=dept:N1");
    expect(p.scope).toEqual([]);
    expect(flat(policyScopeSql(p)).text).toContain("AND 1 = 0");
  });

  it("the query string round-trips, always carries basis, and carries page only when asked", () => {
    const p = parse("type=full_time_faculty&unit=div:N2&person=abc1234&pos=first&level=guideline&body=NICE&excl=1&basis=fy&from=2019&to=2024&cfrom=2023&view=documents&sort=recent&dsort=body&q=asthma");
    expect(parse(policyCitationQueryString(p))).toEqual(p);
    expect(policyCitationQueryString(parse())).toContain("basis=cy");
    // Any other change starts at page 1.
    expect(policyCitationQueryString(parse("basis=cy&page=4"))).not.toContain("page=");
    expect(policyCitationQueryString(parse(), { page: 4 })).toContain("page=4");
  });
});

describe("ranked sort", () => {
  const row = (pmid: string, a: number, g: number, c: number, r: number, year = 2020, latest = 2024): PubCounts => ({
    pmid,
    authority: a,
    guideline: g,
    consensus: c,
    review: r,
    year,
    latest,
  });

  it("authority first, then guidelines, then consensus, then reviews: a lower level only breaks a tie", () => {
    const rows = [
      row("reviews", 0, 0, 0, 500),
      row("consensus", 0, 0, 9, 0),
      row("guidelines", 0, 3, 0, 0),
      row("one-authority", 1, 0, 0, 0),
      row("authority-and-guideline", 1, 1, 0, 0),
      row("two-authorities", 2, 0, 0, 0),
    ];
    expect(sortPublications(rows, "ranked").map((r) => r.pmid)).toEqual([
      "two-authorities",
      "authority-and-guideline",
      "one-authority",
      "guidelines",
      "consensus",
      "reviews",
    ]);
    expect(compareRanked(rows[0], rows[1])).toBeGreaterThan(0);
  });

  it("a full tie goes to the newer publication, then the PMID", () => {
    const rows = [row("2", 1, 2, 0, 4, 2015), row("3", 1, 2, 0, 4, 2021), row("1", 1, 2, 0, 4, 2015)];
    expect(sortPublications(rows, "ranked").map((r) => r.pmid)).toEqual(["3", "1", "2"]);
  });

  it("the other sorts lead with their column and fall back to the ranked order", () => {
    const rows = [row("a", 5, 1, 0, 1, 2010, 2019), row("b", 0, 9, 0, 2, 2022, 2026), row("c", 1, 9, 0, 80, 2018, 2021)];
    expect(sortPublications(rows, "guidelines").map((r) => r.pmid)).toEqual(["c", "b", "a"]);
    expect(sortPublications(rows, "recent").map((r) => r.pmid)).toEqual(["b", "c", "a"]);
    expect(sortPublications(rows, "year").map((r) => r.pmid)).toEqual(["b", "c", "a"]);
  });

  it("Level picks what is listed; the tiles cover every level", () => {
    const rows = [row("a", 1, 0, 0, 3), row("b", 0, 2, 0, 0), row("c", 0, 0, 0, 7), row("d", 1, 1, 0, 0)];
    expect(listedAt(rows, ["authority", "guideline"]).map((r) => r.pmid)).toEqual(["a", "b", "d"]);
    expect(listedAt(rows, ["review"]).map((r) => r.pmid)).toEqual(["a", "c"]);
    expect(listedAt(rows, [])).toHaveLength(4);
    // One tile per level; no "either".
    expect(policyTiles(rows)).toEqual({ authority: 2, guideline: 2, consensus: 0, review: 2 });
  });
});

describe("where the per-publication counts come from", () => {
  const ROLLUP =
    "(SELECT pmid, latest_citing_year AS latest, authority_count AS authority, guideline_count AS guideline, consensus_count AS consensus, review_count AS review FROM publication WHERE authority_count > 0 OR guideline_count > 0 OR consensus_count > 0 OR review_count > 0) x";
  // The live aggregate: links and documents only, the document filters inside.
  const LIVE =
    /^\(SELECT l\.pmid, MAX\(d\.year\) AS latest, COUNT\(DISTINCT CASE WHEN d\.level = \? THEN d\.dedup_key END\) AS authority, .*? FROM publication_citing_document l JOIN citing_document d ON d\.id = l\.citing_document_id WHERE d\.level IN \(\?,\?,\?,\?\) .*GROUP BY l\.pmid\) x$/;
  const source = (qs: string) => flat(citedSql({ ...parse(qs), scope: null }));

  it("no filter on the documents: the rollup columns on publication, no link table", () => {
    for (const qs of ["", "basis=cy", "basis=fy&from=2020&to=2024&level=review&pos=first&person=abc1234&type=full_time_faculty&unit=dept:N1"]) {
      expect(source(qs).text, qs).toBe(ROLLUP);
      expect(source(qs).values).toEqual([]);
    }
  });

  it("an issuing body or a citing-document year: the live aggregate, filtered inside", () => {
    const body = source("basis=cy&body=WHO");
    expect(body.text).toMatch(LIVE);
    expect(body.text).toContain("AND d.issuing_body IN (?)");
    expect(body.values).toContain("WHO");
    expect(source("basis=cy&cfrom=2020").text).toMatch(LIVE);
    expect(source("basis=cy&cfrom=2020").text).toContain("AND d.year >= ?");
    expect(source("basis=cy&cto=2024").text).toContain("AND d.year <= ?");
    for (const qs of ["basis=cy&body=WHO", "basis=cy&cto=2024"]) {
      expect(source(qs).text).not.toMatch(/publication_author|scholar|authority_count/);
      expect(source(qs).text).not.toContain("JSON_SEARCH");
    }
  });

  it("hiding excluded-study citations: the rollups cannot answer, so the live aggregate, the links tested inside", () => {
    const excl = source("basis=cy&excl=1");
    expect(excl.text).toMatch(LIVE);
    expect(excl.text).toContain(
      "AND COALESCE(JSON_LENGTH(JSON_SEARCH(LOWER(CAST(l.locations AS CHAR)), 'all', '%excluded%', NULL, '$[*].label')) = JSON_LENGTH(l.locations), 0) = 0 GROUP BY l.pmid",
    );
    expect(excl.text).not.toMatch(/authority_count/);
  });
});

describe("query shape: counts per publication first, people attached afterwards", () => {
  const P = { ...parse("basis=fy&from=2020&to=2024&level=guideline&pos=first&person=abc1234"), scope: null };

  it("publications: one pass, every level, grouped on the publication key, counts read off the rollup", async () => {
    await loadPublicationCounts(P);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const { text } = call(0);
    expect(text.trim()).toBe(
      "SELECT STRAIGHT_JOIN p.pmid AS pmid, MAX(p.year) AS year, MAX(p.latest_citing_year) AS latest, MAX(p.authority_count) AS authority, MAX(p.guideline_count) AS guideline, MAX(p.consensus_count) AS consensus, MAX(p.review_count) AS review FROM publication p JOIN publication_author pa ON pa.pmid = p.pmid JOIN scholar s ON s.cwid = pa.cwid WHERE (p.authority_count > 0 OR p.guideline_count > 0 OR p.consensus_count > 0 OR p.review_count > 0) AND pa.is_confirmed = 1 AND s.deleted_at IS NULL AND s.status = 'active' AND s.cwid IN (?) AND (pa.is_first = 1) AND YEAR(DATE_ADD(p.date_added_to_entrez, INTERVAL 6 MONTH)) BETWEEN ? AND ? GROUP BY p.pmid",
    );
    expect(text).not.toMatch(/DISTINCT|EXISTS|publication_citing_document/);
  });

  it("publications with a document filter: the live aggregate, grouped on its key", async () => {
    await loadPublicationCounts({ ...P, bodies: ["WHO"] });
    const { text } = call(0);
    expect(text.trim()).toMatch(
      /^SELECT STRAIGHT_JOIN x\.pmid AS pmid, MAX\(p\.year\) AS year, MAX\(x\.latest\) AS latest, MAX\(x\.authority\) AS authority, MAX\(x\.guideline\) AS guideline, MAX\(x\.consensus\) AS consensus, MAX\(x\.review\) AS review FROM \(SELECT l\.pmid, .* AND d\.issuing_body IN \(\?\) GROUP BY l\.pmid\) x JOIN publication p ON p\.pmid = x\.pmid JOIN publication_author pa ON pa\.pmid = x\.pmid JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.is_confirmed = 1 .* GROUP BY x\.pmid$/,
    );
    expect(text).not.toMatch(/authority_count|SELECT STRAIGHT_JOIN DISTINCT/);
  });

  it("tiles and the listing come from that one pass", async () => {
    const pub = (pmid: string, a: number, g: number, r: number) => ({ pmid, year: 2020, latest: 2024, authority: a, guideline: g, consensus: 0, review: r });
    h.queryRaw
      .mockResolvedValueOnce([pub("1", 1, 0, 2), pub("2", 0, 3, 0), pub("3", 0, 0, 9)]) // publications
      .mockResolvedValueOnce([]) // people
      .mockResolvedValue([]); // details
    const data = await loadPolicyCitations({ ...parse(), scope: null }, 100);
    expect(data.cited).toBe(3);
    expect(data.tiles).toEqual({ authority: 1, guideline: 1, consensus: 0, review: 2 });
    // The default levels leave the review-only paper out of the listing.
    expect(data.pubTotal).toBe(2);
    expect(data.pubMatched).toBe(2);
    expect(data.pubs.map((r) => r.pmid)).toEqual(["1", "2"]);
    // Publications + people, then authors + bodies for the listed rows: no second pass over x.
    expect(h.queryRaw).toHaveBeenCalledTimes(4);
  });

  it("pages: `limit` rows from `offset`, details loaded for those rows only", async () => {
    const pub = (pmid: string, a: number) => ({ pmid, year: 2021, latest: 2024, authority: a, guideline: 0, consensus: 0, review: 0 });
    h.queryRaw.mockResolvedValueOnce([pub("1", 5), pub("2", 4), pub("3", 3), pub("4", 2), pub("5", 1)]).mockResolvedValue([]);
    const data = await loadPolicyCitations({ ...parse(), scope: null }, 2, 2);
    expect(data.pubTotal).toBe(5);
    expect(data.pubs.map((r) => r.pmid)).toEqual(["3", "4"]);
    expect(call(2).values).toEqual(["3", "4"]);
  });

  it("the search narrows the listing, not the tiles: publications by one more scoped query, people in memory", async () => {
    const pub = (pmid: string) => ({ pmid, year: 2021, latest: 2024, authority: 1, guideline: 0, consensus: 0, review: 0 });
    const who = (cwid: string, preferred_name: string) => ({ cwid, preferred_name, primary_department: null, role_category: null, primary_org_code: null, authority: 1n, guideline: 0n, consensus: 0n, review: 0n });
    const people = [who("abc1234", "Example Person"), who("def5678", "Another Sample")];
    h.queryRaw
      .mockResolvedValueOnce([pub("1"), pub("2"), pub("3")])
      .mockResolvedValueOnce(people)
      .mockResolvedValueOnce([{ pmid: "2" }, { pmid: "999" }]) // the search; 999 is not listed
      .mockResolvedValue([]);
    const p = { ...parse("basis=cy&q=50%25_off"), scope: ["dept:N1"] };
    const data = await loadPolicyCitations(p, 50);
    expect(data.tiles.authority).toBe(3);
    expect(data.pubTotal).toBe(3);
    expect(data.pubMatched).toBe(1);
    expect(data.pubs.map((r) => r.pmid)).toEqual(["2"]);
    expect(data.people).toHaveLength(2);
    const { text, values } = call(2);
    expect(text.trim()).toMatch(
      /^SELECT STRAIGHT_JOIN p\.pmid FROM publication p JOIN publication_author pa ON pa\.pmid = p\.pmid JOIN scholar s ON s\.cwid = pa\.cwid WHERE \(p\.authority_count > 0 OR .*\) AND pa\.is_confirmed = 1 .* AND \(p\.pmid = \? OR p\.title LIKE \? OR s\.preferred_name LIKE \?\) GROUP BY p\.pmid$/,
    );
    // The viewer's department is in the search too, and LIKE wildcards in the text are literal.
    expect(values).toEqual(expect.arrayContaining(["N1", "50%_off", "%50\\%\\_off%"]));

    // On the By person tab the same box filters people by name or CWID, with no query.
    h.queryRaw.mockReset().mockResolvedValueOnce([pub("1")]).mockResolvedValueOnce(people).mockResolvedValue([]);
    const byPerson = await loadPolicyCitations({ ...parse("basis=cy&view=people&q=SAMPLE"), scope: null }, 0);
    expect(byPerson.people.map((r) => r.cwid)).toEqual(["def5678"]);
    expect(byPerson.pubMatched).toBe(1);
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect((await searchPublications({ ...parse(), scope: [] }, "x")).size).toBe(0);
    expect(call(2).text).toContain("AND 1 = 0");
  });

  it("people: x joined to authorships, papers counted per level, the person filter left out", async () => {
    h.queryRaw.mockResolvedValue([
      { cwid: "abc1234", preferred_name: "Example Person", primary_department: null, role_category: null, primary_org_code: null, authority: 0n, guideline: 2n, consensus: 0n, review: 1n },
      { cwid: "def5678", preferred_name: "Another Person", primary_department: null, role_category: null, primary_org_code: null, authority: 1n, guideline: 0n, consensus: 0n, review: 0n },
    ]);
    const people = await loadPersonCounts(P);
    expect(people.map((r) => [r.cwid, r.authority, r.guideline])).toEqual([
      ["def5678", 1, 0],
      ["abc1234", 0, 2],
    ]);
    const { text, values } = call(0);
    expect(text).toContain("COUNT(CASE WHEN x.authority > 0 THEN 1 END) AS authority");
    expect(text.trim()).toMatch(/^SELECT STRAIGHT_JOIN s\.cwid/);
    expect(text).toMatch(/\) x JOIN publication p ON p\.pmid = x\.pmid JOIN publication_author pa ON pa\.pmid = x\.pmid JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.is_confirmed = 1/);
    expect(values).not.toContain("abc1234");
  });

  it("citing documents: driven from the documents, never the reviews, the who clause behind an EXISTS", async () => {
    await loadDocLinks({ ...P, bodies: ["WHO"], hideExcluded: true, scope: ["dept:N1"] });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = call(0);
    expect(text.trim()).toMatch(
      /^SELECT STRAIGHT_JOIN d\.id, d\.dedup_key, d\.level, d\.year, d\.issuing_body, CASE WHEN d\.level = 'authority' THEN d\.title END AS title, l\.pmid FROM citing_document d JOIN publication_citing_document l ON l\.citing_document_id = d\.id JOIN publication p ON p\.pmid = l\.pmid WHERE d\.level IN \(\?,\?,\?\) AND d\.issuing_body IN \(\?\) AND COALESCE\(JSON_LENGTH\(JSON_SEARCH\(.*\) = 0 AND YEAR\(DATE_ADD\(p\.date_added_to_entrez, INTERVAL 6 MONTH\)\) BETWEEN \? AND \? AND EXISTS \(SELECT 1 FROM publication_author pa JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.pmid = l\.pmid AND .*\)$/,
    );
    expect(text).not.toMatch(/guideline_count|JOIN publication_author pa ON/);
    expect(values.slice(0, 3)).toEqual(["authority", "guideline", "consensus"]);
    expect(values).not.toContain("review");
    expect(values).toEqual(expect.arrayContaining(["N1", "WHO", "abc1234"]));
  });
});

describe("scope narrowing", () => {
  it("a superuser and a comms steward see everything: no scope clause", async () => {
    const p = await resolvePolicyCitationParams(parse("unit=dept:N2"), SUPER);
    expect(p.scope).toBeNull();
    expect(h.manageable).not.toHaveBeenCalled();
    const { text, values } = flat(policyScopeSql(p));
    expect(text.match(/s\.dept_code IN/g)).toHaveLength(1);
    expect(values).toEqual(["N2"]);
    const steward = await resolvePolicyCitationParams(parse(), { ...ADMIN, isCommsSteward: true });
    expect(steward.scope).toBeNull();
  });

  it("a unit administrator is pinned to their units, whatever the URL says", async () => {
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }], centers: [{ code: "C7" }] }));
    // No unit in the URL: still narrowed.
    const bare = await resolvePolicyCitationParams(parse(), ADMIN);
    expect(bare.scope).toEqual(["dept:N1", "center:C7"]);
    const own = flat(policyScopeSql(bare));
    expect(own.text).toContain("s.dept_code IN (?)");
    expect(own.text).toContain("FROM center_membership scm");
    expect(own.values).toEqual(expect.arrayContaining(["N1", "C7"]));

    // Someone else's department in the URL: AND-ed with the scope, so it can
    // only narrow. Both clauses are present; neither replaces the other.
    const other = await resolvePolicyCitationParams(parse("unit=dept:N2&scope=dept:N2"), ADMIN);
    expect(other.scope).toEqual(["dept:N1", "center:C7"]);
    const { text, values } = flat(policyScopeSql(other));
    expect(text.match(/s\.dept_code IN \(\?\)/g)).toHaveLength(2);
    expect(text).toMatch(/AND \(s\.dept_code IN \(\?\) OR s\.cwid IN \(SELECT scm\.cwid.*?\)\) AND \(s\.dept_code IN \(\?\)\)/);
    expect(values.indexOf("N1")).toBeLessThan(values.indexOf("N2"));

    // The Person facet's query (no `person` filter) keeps the scope too.
    const facet = flat(policyScopeSql({ ...other, people: ["zzz9999"] }, { people: false }));
    expect(facet.values).toContain("N1");
    expect(facet.values).not.toContain("zzz9999");
  });

  it("someone who administers no unit matches nothing", async () => {
    const p = await resolvePolicyCitationParams(parse(), ADMIN);
    expect(p.scope).toEqual([]);
    expect(flat(policyScopeSql(p)).text).toContain("AND 1 = 0");
  });

  it("the page gate opens for a viewer with something to see, and report 24 uses it", async () => {
    expect(await canViewPolicyCitationsReport(SUPER)).toBe(true);
    expect(await canViewPolicyCitationsReport(ADMIN)).toBe(false);
    // A core is not a unit this report can narrow to.
    h.manageable.mockResolvedValue(units({ cores: [{ code: "K1" }] }));
    expect(await canViewPolicyCitationsReport(ADMIN)).toBe(false);
    h.manageable.mockResolvedValue(units({ institutions: [{ code: "Q1" }] }));
    expect(await canViewPolicyCitationsReport(ADMIN)).toBe(true);
    const def = REPORTS["24"];
    expect(def.gate === "admin" && def.canView).toBe(canViewPolicyCitationsReport);
  });

  it("the download route pins the same scope and refuses a viewer with no unit", async () => {
    h.session.mockResolvedValue(null);
    const url = "http://localhost/api/edit/reports/policy-citations?unit=dept:N2&level=review";
    expect((await GET(new Request(url))).status).toBe(401);

    h.session.mockResolvedValue(ADMIN);
    expect((await GET(new Request(url))).status).toBe(403);
    expect(h.queryRaw).not.toHaveBeenCalled();

    h.manageable.mockResolvedValue(units({ divisions: [{ code: "N5" }] }));
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Both aggregate queries (publications, people) carry the viewer's division.
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    for (const n of [0, 1]) {
      const { text, values } = call(n);
      expect(text).toContain("s.div_code IN (?)");
      expect(values).toEqual(expect.arrayContaining(["N5", "N2"]));
    }

    // With publications to list: the author chips and the Citations sheet are narrowed too.
    h.queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ pmid: "111", year: 2021, latest: 2024, authority: 0, guideline: 0, consensus: 0, review: 2 }])
      .mockResolvedValue([]);
    expect((await GET(new Request(url))).status).toBe(200);
    // Publications, people, authors, bodies, citation pairs.
    expect(h.queryRaw).toHaveBeenCalledTimes(5);
    for (const n of [2, 4]) {
      const { text, values } = call(n);
      expect(text, String(n)).toContain("s.div_code IN (?)");
      expect(values).toEqual(expect.arrayContaining(["N5", "111"]));
    }
  });

  it("the Citations sheet's query: the listed publications re-tested against the scope, the ticked levels, capped", async () => {
    const pubs = [
      { pmid: "222", title: "Second <i>paper</i>" },
      { pmid: "111", title: "First paper" },
    ];
    const pair = (pmid: string, level: string, dedup_key: string, over: Record<string, unknown> = {}) => ({
      pmid,
      dedup_key,
      level,
      issuing_body: null,
      title: `Document ${dedup_key}`,
      authors: null,
      journal: null,
      volume: null,
      issue: null,
      pages: null,
      publisher: null,
      year: 2024,
      doi: null,
      url: `https://example.org/${dedup_key}`,
      locations: null,
      first_seen_at: new Date("2026-11-25T03:00:00Z"),
      ...over,
    });
    h.queryRaw.mockResolvedValue([
      pair("111", "authority", "a", { issuing_body: "WHO", publisher: "Geneva: World Health Organization; 2024 Jan.", locations: JSON.stringify([{ url: "https://www.ncbi.nlm.nih.gov/books/NBK000003/", label: "Chapter 4" }, { url: "https://www.ncbi.nlm.nih.gov/books/NBK000004/", label: "Annex 1" }]) }),
      pair("222", "guideline", "g"),
      pair("222", "guideline", "g"), // the same guideline in a second journal
      pair("111", "guideline", "g", { authors: "Doe J, Roe R", journal: "Example J", volume: "12", issue: "3", pages: "45-67", doi: "10.1000/example" }),
      pair("222", "review", "r"),
    ]);
    const p = { ...parse("basis=cy&level=authority&level=guideline&excl=1"), scope: ["dept:N1"] };
    const { rows, more } = await loadCitationPairs(p, pubs);
    expect(more).toBe(false);
    // The Publications sheet's order, then level; one row per paper and document.
    expect(rows.map((r) => [r.pmid, r.level, r.title])).toEqual([
      ["222", "guideline", "Document g"],
      ["222", "review", "Document r"],
      ["111", "authority", "Document a"],
      ["111", "guideline", "Document g"],
    ]);
    expect(rows[2]).toMatchObject({
      pubTitle: "First paper",
      body: "WHO",
      authors: null,
      source: "Geneva: World Health Organization; 2024 Jan.",
      where: "Chapter 4; Annex 1",
      url: "https://example.org/a",
      firstSeen: "2026-11-25",
    });
    expect(rows[3]).toMatchObject({ authors: "Doe J, Roe R", source: "Example J, 12(3):45-67", doi: "10.1000/example" });
    // A journal with no volume, issue or pages: the journal alone.
    expect(rows[0]).toMatchObject({ source: null, doi: null });
    const { text, values } = call(0);
    expect(text).toMatch(
      /FROM \(SELECT p\.pmid FROM publication p WHERE p\.pmid IN \(\?,\?\) AND EXISTS \(SELECT 1 FROM publication_author pa JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.pmid = p\.pmid AND .*s\.dept_code IN \(\?\).*\)\) ok JOIN publication_citing_document l ON l\.pmid = ok\.pmid JOIN citing_document d ON d\.id = l\.citing_document_id WHERE d\.level IN \(\?,\?\) .*JSON_SEARCH.* ORDER BY FIELD\(d\.level, 'authority', 'guideline', 'consensus', 'review'\), ok\.pmid, d\.year DESC, d\.id LIMIT \?$/,
    );
    expect(values).toEqual(expect.arrayContaining(["222", "111", "N1", "authority", "guideline", POLICY_CITATIONS_CAP + 1]));
    expect(values).not.toContain("review");

    // One row past the cap comes back: cut, and said so.
    const cut = await loadCitationPairs(p, pubs, 2);
    expect(cut.rows).toHaveLength(2);
    expect(cut.more).toBe(true);
    // No publications listed: no query at all.
    h.queryRaw.mockClear();
    expect(await loadCitationPairs(p, [])).toEqual({ rows: [], more: false });
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("the scope is a chip that cannot be removed, and a Criteria row", () => {
    const p = { ...parse("basis=cy"), scope: ["dept:N1"] };
    const labels = new Map([["dept:N1", "Department of Examples"]]);
    expect(policyCitationChips(p, labels)[0]).toEqual({
      group: "Unit",
      value: "Department of Examples",
      removeQuery: null,
    });
    expect(describePolicyCitationCriteria(p, new Date(0), labels)).toContainEqual([
      "Access",
      "Limited to the units you administer: Department of Examples",
    ]);
  });
});

describe("de-dup by dedupKey", () => {
  it("keeps the first of each key, in order", () => {
    const docs = [
      { id: 1, dedupKey: "a" },
      { id: 2, dedupKey: "b" },
      { id: 3, dedupKey: "a" },
    ];
    expect(dedupeDocs(docs).map((d) => d.id)).toEqual([1, 2]);
  });

  it("a guideline printed in two journals is listed once; documents sort highest level first", async () => {
    const doc = (id: number, level: string, dedup_key: string, over: Record<string, unknown> = {}) => ({
      pmid: "12345",
      id,
      dedup_key,
      level,
      title: `Document ${id}`,
      year: 2024,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      issuing_body: null,
      authors: "Example AB, Sample CD",
      journal: "Journal of Examples",
      journal_abbrev: "J Ex",
      volume: "83",
      issue: "4",
      pages: "500-510",
      doi: null,
      publisher: null,
      source: "pubmed",
      external_id: String(id),
      locations: null,
      ...over,
    });
    h.queryRaw.mockResolvedValue([
      doc(9, "review", "another paper's review", { pmid: "67890" }),
      doc(1, "review", "review 2024"),
      doc(2, "guideline", "same guideline 2024"),
      doc(3, "guideline", "same guideline 2024"),
      doc(4, "authority", "who report 2023", {
        source: "bookshelf",
        external_id: "NBK000001",
        issuing_body: "WHO",
        authors: null,
        journal: null,
        journal_abbrev: null,
        publisher: "Geneva: World Health Organization; 2023 Jan.",
        // MariaDB returns JSON as text through a raw query.
        locations: JSON.stringify([
          { url: "https://www.ncbi.nlm.nih.gov/books/NBK000002/", label: "Chapter 3" },
          { url: "https://example.org/elsewhere", label: "Not NCBI" },
        ]),
      }),
      doc(5, "unknown-level", "x"),
    ]);
    const byPmid = await loadCitingDocuments({ ...parse(), scope: null }, ["12345"]);
    expect([...byPmid.keys()].sort()).toEqual(["12345", "67890"]);
    const docs = byPmid.get("12345")!;
    expect(docs.map((d) => d.id)).toEqual([4, 2, 1]);
    expect(docs[0]).toMatchObject({
      bookshelfId: "NBK000001",
      pmid: null,
      publisher: "Geneva: World Health Organization; 2023 Jan.",
      locations: [{ url: "https://www.ncbi.nlm.nih.gov/books/NBK000002/", label: "Chapter 3" }],
    });
    expect(docs[1]).toMatchObject({ pmid: "2", journal: "J Ex", cite: "2024;83(4):500-510" });
    expect(byPmid.get("67890")!.map((d) => d.id)).toEqual([9]);
  });

  it("one query for the page's rows, the viewer's units tested again, reviews capped per paper", async () => {
    expect((await loadCitingDocuments({ ...parse(), scope: null }, [])).size).toBe(0);
    expect(h.queryRaw).not.toHaveBeenCalled();
    await loadCitingDocuments({ ...parse("basis=cy&excl=1&person=abc1234"), scope: ["dept:N1"] }, ["111", "222"]);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = call(0);
    expect(text).toMatch(
      /ROW_NUMBER\(\) OVER \(PARTITION BY ok\.pmid, d\.level ORDER BY d\.year DESC, d\.id\) AS rn FROM \(SELECT p\.pmid FROM publication p WHERE p\.pmid IN \(\?,\?\) AND EXISTS \(SELECT 1 FROM publication_author pa JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.pmid = p\.pmid AND .*s\.dept_code IN \(\?\).*\)\) ok JOIN publication_citing_document l ON l\.pmid = ok\.pmid JOIN citing_document d ON d\.id = l\.citing_document_id WHERE d\.level IN \(\?,\?,\?,\?\) .*JSON_SEARCH.*\) t WHERE t\.level <> 'review' OR t\.rn <= \? ORDER BY t\.year DESC, t\.id$/,
    );
    expect(values).toEqual(expect.arrayContaining(["111", "222", "N1", "abc1234", REVIEWS_SHOWN]));
    // No unit: nothing, whatever PMIDs are asked for.
    await loadCitingDocuments({ ...parse(), scope: [] }, ["111"]);
    expect(call(1).text).toContain("AND 1 = 0");
  });
});

describe("excluded-study citations", () => {
  const loc = (...labels: string[]) => labels.map((label) => ({ label }));

  it("a link is one when every location names an excluded-studies list, in any case", () => {
    expect(isExcludedStudyCitation(loc("Excluded Studies List"))).toBe(true);
    expect(isExcludedStudyCitation(loc("Appendix C. List of EXCLUDED studies", "excluded references"))).toBe(true);
    // Cited in a chapter as well: a real citation.
    expect(isExcludedStudyCitation(loc("Excluded Studies", "Chapter 3. Results"))).toBe(false);
    expect(isExcludedStudyCitation(loc("References"))).toBe(false);
    // No locations (every PubMed document): nothing says it was set aside.
    expect(isExcludedStudyCitation([])).toBe(false);
  });

  it("ticked, it is a chip that can be removed and a Criteria row; unticked, neither filter nor chip", () => {
    const on = { ...parse("basis=cy&excl=1"), scope: null };
    expect(policyCitationChips(on)).toContainEqual({ group: "Excluded-study citations", value: "Hidden", removeQuery: "basis=cy" });
    expect(Object.fromEntries(describePolicyCitationCriteria(on, new Date(0)))["Excluded-study citations"]).toMatch(/^Hidden/);
    const off = { ...parse("basis=cy"), scope: null };
    expect(policyCitationChips(off).map((c) => c.group)).not.toContain("Excluded-study citations");
    expect(Object.fromEntries(describePolicyCitationCriteria(off, new Date(0)))["Excluded-study citations"]).toBe("Counted");
  });

  it("how a document cites a paper, from its editions' locations", () => {
    const edition = (...labels: string[]) => ({ locations: loc(...labels) });
    expect(howCited([edition("Excluded Studies")])).toBe("listed as an excluded study.");
    expect(howCited([edition("Chapter 2"), edition("Chapter 2")])).toBe("cited in Chapter 2.");
    expect(howCited([edition("Evidence Summary", "Results")])).toBe("cited in Evidence Summary and Results.");
    expect(
      howCited([edition("Excluded Studies List"), edition("List of Excluded Studies"), edition("Report 1", "Report 2", "Report 3")]),
    ).toBe("listed as an excluded study in 2 editions, and cited in 3 chapters or sections.");
    expect(howCited([edition("Excluded Studies", "Results"), edition()])).toBe("cited in Results.");
    expect(howCited([edition()])).toBeNull();
  });
});

describe("editions", () => {
  it("the normalizer drops a trailing year or update phrase and folds case", () => {
    const same = [
      "Living Review of Example Treatments for Sample Pain",
      "Living Review of Example Treatments for Sample Pain: 2025 Update",
      "LIVING REVIEW OF EXAMPLE TREATMENTS FOR SAMPLE PAIN – Update 2019",
      "Living Review of Example  Treatments for Sample Pain: An Update",
      "Living Review of Example Treatments for Sample Pain (update)",
      "Living Review of Example Treatments for Sample Pain: Final Update.",
      "Living Review of Example Treatments for Sample Pain 2021",
      "Living review of example treatments for sample pain, 2022 Evidence Update",
    ];
    for (const t of same) expect(editionTitle(t), t).toBe("living review of example treatments for sample pain");
    // Only the tail goes: a year or "update" inside the title stays.
    expect(editionTitle("Update on 2020 Sample Guidance for Clinics")).toBe("update on 2020 sample guidance for clinics");
    expect(editionTitle("Sample Screening: An Updated Evidence Review")).toBe("sample screening: an updated evidence review");
    expect(editionTitle("Example Guidance, Part 2")).toBe("example guidance, part 2");
    expect(editionTitle("2020")).toBe("");
  });

  it("groups authority documents by body and normalized title, newest first; nothing else groups", () => {
    const d = (id: number, level: "authority" | "guideline", issuingBody: string | null, title: string, year: number | null) => ({
      id,
      level,
      issuingBody,
      title,
      year,
      dedupKey: `k${id}`,
    });
    const groups = groupEditions([
      d(1, "authority", "AHRQ", "Example Review: 2022 Update", 2022),
      d(2, "guideline", null, "Example Review", 2024),
      d(3, "authority", "AHRQ", "Example Review", 2021),
      d(4, "authority", "WHO", "Example Review: 2023 Update", 2023),
      d(5, "authority", "AHRQ", "Example Review: 2025 Update", 2025),
      d(6, "guideline", null, "Example Review", 2024),
      d(7, "authority", "AHRQ", "Another Example Review", null),
    ]);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([[5, 1, 3], [2], [4], [6], [7]]);
    expect(yearRange(2021, 2025)).toBe("2021–2025");
    expect(yearRange(2023, 2023)).toBe("2023");
    expect(yearRange(null, null)).toBe("");
  });
});

describe("by citing document", () => {
  const link = (id: number, pmid: string, over: Partial<DocLink> = {}): DocLink => ({
    id,
    dedupKey: `doc ${id}`,
    level: "guideline",
    year: 2024,
    issuingBody: null,
    title: null,
    pmid,
    ...over,
  });
  const authority = (id: number, pmid: string, title: string, year: number, issuingBody = "AHRQ") =>
    link(id, pmid, { level: "authority", issuingBody, title, year });
  const LINKS = [
    authority(1, "100", "Example Review", 2021),
    authority(2, "100", "Example Review: 2023 Update", 2023),
    authority(2, "200", "Example Review: 2023 Update", 2023),
    authority(3, "300", "A Different Report", 2022, "WHO"),
    link(4, "100"),
    // The same guideline printed in a second journal: one document.
    link(5, "200", { dedupKey: "doc 4" }),
    link(6, "100", { level: "consensus", year: 2020 }),
  ];

  it("one row per document, editions grouped, papers distinct over the editions", () => {
    const groups = groupDocLinks(LINKS);
    expect(groups.map((g) => [g.level, g.docs.map((d) => d.id), yearRange(g.yearMin, g.yearMax), g.pmids])).toEqual([
      ["authority", [2, 1], "2021–2023", ["100", "200"]],
      ["authority", [3], "2022", ["300"]],
      ["guideline", [4], "2024", ["100", "200"]],
      ["consensus", [6], "2020", ["100"]],
    ]);
    expect(sortDocGroups(groups, "recent").map((g) => g.docs[0].id)).toEqual([4, 2, 3, 6]);
    expect(sortDocGroups(groups, "papers").map((g) => g.docs[0].id)).toEqual([4, 2, 3, 6]);
    expect(sortDocGroups(groups, "body").map((g) => g.docs[0].id)).toEqual([2, 3, 4, 6]);
  });

  it("the cards: documents (editions grouped) and papers per body; documents per year per level, each edition in its year", () => {
    expect(policySummary(groupDocLinks(LINKS))).toEqual({
      bodies: [
        { body: "AHRQ", documents: 1, papers: 2 },
        { body: "WHO", documents: 1, papers: 1 },
      ],
      years: {
        authority: [
          { year: 2021, count: 1 },
          { year: 2022, count: 1 },
          { year: 2023, count: 1 },
        ],
        guideline: [{ year: 2024, count: 1 }],
        consensus: [{ year: 2020, count: 1 }],
      },
    });
  });

  it("the tab lists the ticked levels, a page at a time, and loads titles and papers for that page only, scoped", async () => {
    const raw = LINKS.map((l) => ({ id: l.id, dedup_key: l.dedupKey, level: l.level, year: l.year, issuing_body: l.issuingBody, title: l.title, pmid: l.pmid }));
    h.queryRaw.mockResolvedValueOnce(raw);
    // Off the tab: the count and the cards, no detail queries.
    const off = await loadPolicyDocuments({ ...parse("basis=cy&level=authority&level=review"), scope: ["dept:N1"] });
    expect(off.docTotal).toBe(2);
    expect(off.docs).toEqual([]);
    expect(off.summary.years.guideline).toHaveLength(1);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);

    h.queryRaw
      .mockReset()
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce([{ id: 2, title: "Example Review: 2023 Update", url: "https://www.ncbi.nlm.nih.gov/books/NBK000002/", journal: null, journal_abbrev: null, source: "bookshelf" }])
      .mockResolvedValueOnce([
        { pmid: "200", title: "Paper two", journal: "J Ex", year: 2021 },
        { pmid: "100", title: "Paper one", journal: "J Ex", year: 2022 },
      ]);
    const on = await loadPolicyDocuments({ ...parse("basis=cy&level=authority&view=documents&dsort=papers"), scope: ["dept:N1"] });
    expect(on.docTotal).toBe(2);
    expect(on.docs[0]).toMatchObject({ title: "Example Review: 2023 Update", bookshelf: true, body: "AHRQ", yearMin: 2021, yearMax: 2023 });
    expect(on.docs[0].papers.map((r) => r.pmid)).toEqual(["100", "200"]);
    expect(on.docs[1].papers).toEqual([]);
    // Every query that reads publications carries the viewer's department.
    for (const n of [0, 2]) {
      expect(call(n).text).toMatch(/EXISTS \(SELECT 1 FROM publication_author pa JOIN scholar s/);
      expect(call(n).values).toContain("N1");
    }
    expect(call(1).text.trim()).toBe("SELECT d.id, d.title, d.url, d.journal, d.journal_abbrev, d.source FROM citing_document d WHERE d.id IN (?,?)");
    expect(call(2).values).toEqual(expect.arrayContaining(["100", "200", "300"]));
  });
});

describe("the workbook", () => {
  const person = (i: number): PersonRow => ({
    cwid: `abc${String(1000 + i)}`,
    name: `Example Person ${i}`,
    orgUnit: "Department of Examples",
    personType: "Full-time faculty",
    institution: "Weill Cornell Medicine",
    authority: 2,
    guideline: 1,
    consensus: 0,
    review: 5,
  });
  const data = (people: number, pubTotal = 1): PolicyCitationData => ({
    cited: pubTotal,
    tiles: { authority: 1, guideline: 1, consensus: 1, review: 1 },
    pubTotal,
    pubMatched: pubTotal,
    pubs: [
      {
        pmid: "12345",
        title: "An <i>example</i> title",
        journal: "J Ex",
        doi: "10.1000/example",
        year: 2020,
        latest: 2024,
        authority: 3,
        guideline: 2,
        consensus: 1,
        review: 9,
        authors: [{ cwid: "abc1001", name: "Example Person 1", position: "first" }],
        bodies: [
          { body: "WHO", count: 2 },
          { body: "NICE", count: 1 },
        ],
      },
    ],
    people: Array.from({ length: people }, (_, i) => person(i + 1)),
    facetPeople: [],
  });
  const read = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  };

  it("Criteria states every filter, 'All' when unset, the who-filter rows from personFilterCriteria", async () => {
    const p = { ...parse("basis=cy"), scope: null };
    const rows = describePolicyCitationCriteria(p, new Date("2026-11-25T00:00:00Z"));
    expect(rows.slice(0, 3)).toEqual([
      ["Report", "24. Guideline and policy citations"],
      ["Generated", "2026-11-25T00:00:00.000Z"],
      ["Access", "All units"],
    ]);
    for (const k of [
      "Person type",
      "Department / division / center / institution",
      "Person (CWID)",
      "Author position",
      "Level",
      "Issuing body",
      "Publication years",
      "Citing document year",
    ]) {
      expect(rows.find(([label]) => label === k)?.[1], k).toBe("All");
    }
    const set = describePolicyCitationCriteria(
      { ...parse("type=full_time_faculty&unit=dept:N1&unit=center:C7&level=authority&body=WHO&pos=first&basis=fy&from=2020&cto=2025&person=abc1234"), scope: null },
      new Date(0),
      new Map([["dept:N1", "Department of Examples"]]),
    );
    expect(Object.fromEntries(set)).toMatchObject({
      "Person type": "Full-time faculty",
      "Department / division / center / institution": "Any of: Department of Examples; center:C7",
      "Person (CWID)": "abc1234",
      "Author position": "First author",
      "Issuing body": "WHO (including IARC)",
      "Publication years": "2020 or later",
      "Citing document year": "2025 or earlier",
    });
    expect(Object.fromEntries(set).Level).toMatch(/^Health authorities \(/);
    expect(Object.fromEntries(set)["Publication year basis"]).toMatch(/^Fiscal year/);

    const wb = await read(await buildPolicyCitationWorkbook(p, data(1), new Date(0)));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Publications", "People", "Citations", "Criteria"]);
    expect(wb.getWorksheet("Criteria")!.getRow(2).values).toEqual([
      undefined,
      "Report",
      "24. Guideline and policy citations",
    ]);
  });

  it("the People sheet lists everyone past the 50-scholar cap, with no contact column anywhere", async () => {
    const n = SCHOLAR_EXPORT_CAP + 25;
    const wb = await read(await buildPolicyCitationWorkbook({ ...parse(), scope: null }, data(n), new Date(0)));
    const people = wb.getWorksheet("People")!;
    expect(people.getRow(1).values).toEqual([
      undefined,
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
    expect(people.rowCount).toBe(n + 1);
    expect(people.getRow(2).values).toEqual([
      undefined,
      "Example Person 1",
      "abc1001",
      "Department of Examples",
      "Full-time faculty",
      "Weill Cornell Medicine",
      2,
      1,
      0,
      5,
    ]);
    for (const ws of wb.worksheets) {
      ws.eachRow((row) => row.eachCell((cell) => expect(String(cell.value)).not.toMatch(/e-?mail|@/i)));
    }
    const criteria = Object.fromEntries(
      wb.getWorksheet("Criteria")!.getSheetValues().slice(2).map((r) => (r as unknown[]).slice(1, 3)),
    );
    expect(criteria["People sheet"]).toContain(`Lists all ${n} people`);
    expect(criteria["People sheet"]).toContain("2026-11-24");
  });

  it("the Publications sheet prints plain titles, bodies with counts, and says when it is cut", async () => {
    const wb = await read(await buildPolicyCitationWorkbook({ ...parse(), scope: null }, data(1, 7000), new Date(0)));
    const pubs = wb.getWorksheet("Publications")!;
    expect(pubs.getRow(1).values).toEqual([
      undefined,
      "PMID",
      "Title",
      "Journal",
      "Year",
      "WCM authors",
      "Health authorities",
      "Health authority documents",
      "Clinical guidelines",
      "Consensus statements",
      "Systematic reviews",
      "DOI",
    ]);
    expect(pubs.getRow(2).values).toEqual([
      undefined,
      "12345",
      "An example title",
      "J Ex",
      2020,
      "Example Person 1 (first author)",
      "WHO (2); NICE (1)",
      3,
      2,
      1,
      9,
      "10.1000/example",
    ]);
    const criteria = Object.fromEntries(
      wb.getWorksheet("Criteria")!.getSheetValues().slice(2).map((r) => (r as unknown[]).slice(1, 3)),
    );
    expect(criteria["Publications sheet"]).toBe(
      "Lists the first 1 of 7,000 publications in the order above. Narrow the filters to list the rest.",
    );
  });

  it("the Citations sheet: one row per paper and citing document, plain titles, and the Criteria sheet states the cap", async () => {
    const p = { ...parse("basis=cy&level=authority"), scope: null };
    const citations = {
      rows: [
        {
          pmid: "12345",
          pubTitle: "An <i>example</i> title",
          level: "authority" as const,
          body: "WHO",
          title: "Example <i>Guidance</i>: 2024 Update",
          authors: null,
          source: "Geneva: World Health Organization; 2024 Jan.",
          year: 2024,
          where: "Chapter 4; Annex 1",
          doi: null,
          url: "https://www.ncbi.nlm.nih.gov/books/NBK000001/",
          firstSeen: "2026-11-25",
        },
      ],
      more: false,
    };
    const wb = await read(await buildPolicyCitationWorkbook(p, data(1), new Date(0), undefined, citations));
    const sheet = wb.getWorksheet("Citations")!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "PMID",
      "Paper title",
      "Level",
      "Issuing body",
      "Citing document",
      "Authors",
      "Journal or publisher",
      "Year",
      "Where cited",
      "DOI",
      "Link",
      "First seen",
    ]);
    expect(sheet.getRow(2).values).toEqual([
      undefined,
      "12345",
      "An example title",
      "Health authority",
      "WHO",
      "Example Guidance: 2024 Update",
      undefined,
      "Geneva: World Health Organization; 2024 Jan.",
      2024,
      "Chapter 4; Annex 1",
      undefined,
      "https://www.ncbi.nlm.nih.gov/books/NBK000001/",
      "2026-11-25",
    ]);
    const criteria = async (c: typeof citations) =>
      Object.fromEntries(
        (await read(await buildPolicyCitationWorkbook(p, data(1), new Date(0), undefined, c)))
          .getWorksheet("Criteria")!
          .getSheetValues()
          .slice(2)
          .map((r) => (r as unknown[]).slice(1, 3)),
      )["Citations sheet"];
    expect(await criteria(citations)).toBe(
      "One row per publication on the Publications sheet and citing document, at the levels above. Lists all 1 rows (the limit is 20,000).",
    );
    expect(await criteria({ ...citations, more: true })).toMatch(/Lists the first 20,000 rows, health authorities first and systematic reviews last\./);
    // Without citations (an older caller): the sheet is there, empty.
    const bare = await read(await buildPolicyCitationWorkbook(p, data(1), new Date(0)));
    expect(bare.getWorksheet("Citations")!.rowCount).toBe(1);
  });
});
