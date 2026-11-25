/** Report 24 (Guideline and policy citations): the param parser, the ranked
 *  sort, what Level lists, the scope narrowing for a unit administrator (in
 *  the lib and through the download route), de-dup by `dedupKey`, and the
 *  workbook's Criteria sheet and People sheet (no cap, no contact column).
 *  Fixture people and units are invented. */
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
  isPolicyCitationDefault,
  listedAt,
  loadCitingDocuments,
  loadPersonCounts,
  loadPolicyCitations,
  loadPolicySummary,
  loadPublicationCounts,
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
  it("a bare URL lists everything above systematic reviews, by publication, ranked", () => {
    expect(parse()).toMatchObject({
      types: [],
      units: [],
      people: [],
      positions: [],
      levels: ["authority", "guideline", "consensus"],
      bodies: [],
      basis: "cy",
      from: null,
      to: null,
      cfrom: null,
      cto: null,
      view: "publications",
      sort: "ranked",
      pub: null,
    });
    // View state alone is still a bare URL.
    expect(parse("view=people&sort=reviews&pub=12345")).toMatchObject({
      levels: ["authority", "guideline", "consensus"],
      view: "people",
      sort: "reviews",
      pub: "12345",
    });
    expect(isPolicyCitationDefault(parse("view=people"))).toBe(true);
  });

  it("a submitted form is taken as-is: no level ticked means every level, not the default", () => {
    expect(parse("basis=cy").levels).toEqual([]);
    expect(parse("basis=cy&level=review&level=authority").levels).toEqual(["authority", "review"]);
    expect(isPolicyCitationDefault(parse("basis=cy"))).toBe(false);
  });

  it("drops what it does not know and keeps ranges in order", () => {
    const p = parse(
      "level=bogus&body=WHO&body=Nobody&pos=last&pos=senior&person=abc1234&person=x'--&basis=fy&from=2020&to=2010&cfrom=abc&cto=2025&sort=score&view=grid&pub=1;drop",
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
      view: "publications",
      pub: null,
    });
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

  it("the query string round-trips, always carries basis, and carries pub only when asked", () => {
    const p = parse("type=full_time_faculty&unit=div:N2&person=abc1234&pos=first&level=guideline&body=NICE&basis=fy&from=2019&to=2024&cfrom=2023&view=people&sort=recent");
    expect(parse(policyCitationQueryString(p))).toEqual(p);
    expect(policyCitationQueryString(parse())).toContain("basis=cy");
    expect(policyCitationQueryString(parse("pub=123"))).not.toContain("pub=");
    expect(policyCitationQueryString(parse(), { pub: "123" })).toContain("pub=123");
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
    expect(sortPublications(rows, "reviews").map((r) => r.pmid)).toEqual(["c", "b", "a"]);
    expect(sortPublications(rows, "recent").map((r) => r.pmid)).toEqual(["b", "c", "a"]);
    expect(sortPublications(rows, "year").map((r) => r.pmid)).toEqual(["b", "c", "a"]);
  });

  it("Level picks what is listed; the tiles cover every level", () => {
    const rows = [row("a", 1, 0, 0, 3), row("b", 0, 2, 0, 0), row("c", 0, 0, 0, 7), row("d", 1, 1, 0, 0)];
    expect(listedAt(rows, ["authority", "guideline"]).map((r) => r.pmid)).toEqual(["a", "b", "d"]);
    expect(listedAt(rows, ["review"]).map((r) => r.pmid)).toEqual(["a", "c"]);
    expect(listedAt(rows, [])).toHaveLength(4);
    expect(policyTiles(rows)).toEqual({ authority: 2, guideline: 2, either: 3, review: 2 });
  });
});

describe("where the per-publication counts come from", () => {
  const ROLLUP =
    "(SELECT pmid, latest_citing_year AS latest, authority_count AS authority, guideline_count AS guideline, consensus_count AS consensus, review_count AS review FROM publication WHERE authority_count > 0 OR guideline_count > 0 OR consensus_count > 0 OR review_count > 0) x";
  // The live aggregate: links and documents only, the document filters inside.
  const LIVE =
    /^\(SELECT l\.pmid, MAX\(d\.year\) AS latest, COUNT\(DISTINCT CASE WHEN d\.level = \? THEN d\.dedup_key END\) AS authority, .*? FROM publication_citing_document l JOIN citing_document d ON d\.id = l\.citing_document_id WHERE 1 = 1 .*GROUP BY l\.pmid\) x$/;
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
    }
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
    expect(data.tiles).toEqual({ authority: 1, guideline: 1, either: 2, review: 2 });
    // The default levels leave the review-only paper out of the listing.
    expect(data.pubTotal).toBe(2);
    expect(data.pubs.map((r) => r.pmid)).toEqual(["1", "2"]);
    // Publications + people, then authors + bodies for the listed rows: no second pass over x.
    expect(h.queryRaw).toHaveBeenCalledTimes(4);
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

  it("summary cards: the who clause is tested per publication; newly cited starts from the recent links", async () => {
    const first = new Date("2026-11-24T21:00:00Z");
    h.queryRaw.mockResolvedValueOnce([{ first }]).mockResolvedValue([]);
    const now = new Date("2026-11-27T00:00:00Z");
    const summary = await loadPolicySummary({ ...P, bodies: ["WHO"], scope: ["dept:N1"] }, now);
    // The first import bounds the window: it starts a day after it, so the backfill is not "new".
    expect(summary.newly).toMatchObject({ firstImport: first, sinceFirstImport: true, documents: 0, items: [] });
    expect(summary.newly.since.toISOString()).toBe("2026-11-25T21:00:00.000Z");

    expect(call(0).text.trim()).toBe("SELECT MIN(first_seen_at) AS first FROM publication_citing_document");
    {
      // Bodies: the who clause tested once per publication the rollup says an authority cites.
      const { text, values } = call(1);
      expect(text).toMatch(
        /FROM \(SELECT p\.pmid FROM publication p WHERE p\.authority_count > 0 AND EXISTS \(SELECT 1 FROM publication_author pa JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.pmid = p\.pmid AND .*\) ok JOIN publication_citing_document l ON l\.pmid = ok\.pmid JOIN citing_document d ON d\.id = l\.citing_document_id WHERE d\.level = 'authority' AND d\.issuing_body IN \(\?\)/,
      );
      expect(text).not.toMatch(/JOIN publication_author pa ON/);
      expect(values).toEqual(expect.arrayContaining(["N1", "WHO"]));
    }
    {
      // Guideline years: driven from the documents, the who clause behind an EXISTS.
      const { text, values } = call(2);
      expect(text.trim()).toMatch(
        /^SELECT STRAIGHT_JOIN d\.year AS y, COUNT\(DISTINCT d\.dedup_key\) AS n FROM citing_document d JOIN publication_citing_document l ON l\.citing_document_id = d\.id JOIN publication p ON p\.pmid = l\.pmid WHERE d\.level = 'guideline' AND d\.year IS NOT NULL AND d\.issuing_body IN \(\?\) AND YEAR\(DATE_ADD\(p\.date_added_to_entrez, INTERVAL 6 MONTH\)\) BETWEEN \? AND \? AND EXISTS \(SELECT 1 FROM publication_author pa JOIN scholar s ON s\.cwid = pa\.cwid WHERE pa\.pmid = l\.pmid AND .*\) GROUP BY d\.year ORDER BY d\.year$/,
      );
      expect(text).not.toMatch(/guideline_count|JOIN publication_author pa ON/);
      expect(values).toEqual(expect.arrayContaining(["N1", "WHO"]));
    }
    for (const n of [3, 4]) {
      const { text, values } = call(n);
      expect(text).toMatch(
        /FROM \(SELECT pmid, citing_document_id, first_seen_at FROM publication_citing_document WHERE first_seen_at >= \?\) l JOIN citing_document d ON d\.id = l\.citing_document_id JOIN publication p ON p\.pmid = l\.pmid WHERE d\.level IN \(\?\)/,
      );
      expect(values[0]).toEqual(summary.newly.since);
      expect(values).toContain("N1");
    }

    // A long-running import: the plain 30-day window.
    h.queryRaw.mockReset().mockResolvedValueOnce([{ first: new Date("2026-01-01T00:00:00Z") }]).mockResolvedValue([]);
    const later = await loadPolicySummary(P, now);
    expect(later.newly.sinceFirstImport).toBe(false);
    expect(later.newly.since.toISOString()).toBe("2026-10-28T00:00:00.000Z");
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
    const docs = await loadCitingDocuments({ ...parse(), scope: null }, "12345");
    expect(docs.map((d) => d.id)).toEqual([4, 2, 1]);
    expect(docs[0]).toMatchObject({
      bookshelfId: "NBK000001",
      pmid: null,
      publisher: "Geneva: World Health Organization; 2023 Jan.",
      locations: [{ url: "https://www.ncbi.nlm.nih.gov/books/NBK000002/", label: "Chapter 3" }],
    });
    expect(docs[1]).toMatchObject({ pmid: "2", journal: "J Ex", cite: "2024;83(4):500-510" });
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
    tiles: { authority: 1, guideline: 1, either: 1, review: 1 },
    pubTotal,
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
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Publications", "People", "Criteria"]);
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
});
