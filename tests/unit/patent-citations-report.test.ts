/** Report 25 (Patent citations): the param parser and its defaults, the flag
 *  gate (index, page, download), where the counts come from, the scope
 *  narrowing for a unit administrator in every query and through the download
 *  route, grouping patent documents into inventions with the "related patents"
 *  label and the no-assignee fallback, and the workbook's sheets and caps
 *  (People: no cap, no contact column). Fixture people, units, papers, patents
 *  and assignees are invented. */
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { GET } from "@/app/api/edit/reports/patent-citations/route";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  buildPatentCitationWorkbook,
  canViewPatentCitationsReport,
  describePatentCitationCriteria,
  INVENTIONS_SHOWN,
  inventionYears,
  isPatentCitationDefault,
  isPatentCitationsReportEnabled,
  loadAssigneeCounts,
  loadCitingInventions,
  loadInventionCounts,
  loadPatentCitations,
  loadPatentDocs,
  loadPatentPersonCounts,
  loadPatentPublicationCounts,
  loadPersonInventions,
  loadScopeTotals,
  parsePatentCitationParams,
  PATENT_INVENTIONS_CAP,
  PATENT_LIST_CAP,
  patentCitationChips,
  patentCitationQueryString,
  patentHolder,
  patentYearLabel,
  relatedPatentsLabel,
  resolvePatentCitationParams,
  searchInventions,
  sortInventions,
  sortPatentPublications,
  withInventionDetails,
  withPublicationDetails,
  type InventionCounts,
  type InventionRow,
  type PatentPersonRow,
  type PatentPubRow,
} from "@/lib/edit/patent-citations-report";
import { POLICY_CITATIONS_ACCESS_RULE } from "@/lib/edit/policy-citations-report";
import { REPORT_META_DEFAULTS } from "@/lib/edit/report-meta";
import { REPORTS } from "@/lib/edit/report-registry";
import { Prisma } from "@/lib/generated/prisma/client";

const parse = (qs = "") => parsePatentCitationParams(new URLSearchParams(qs));
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
/** Every `$queryRaw` tagged-template call so far, re-composed: one-spaced text plus bound values. */
const calls = () =>
  h.queryRaw.mock.calls.map((c) => {
    const [strings, ...values] = c as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...values);
    return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
  });
const call = (n: number) => calls()[n];
/** A query that names a person, an authorship or a publication. */
const readsPeopleOrPapers = (text: string) => /\b(scholar|publication_author|publication) [a-z]+\b/.test(text);
/** `rep`, as `REP_SQL` builds it: application flag, year, document id. */
const rep = (application: boolean, year: number, id: number) =>
  `${application ? 1 : 0}${year}${String(id).padStart(10, "0")}`;

beforeEach(() => {
  h.queryRaw.mockReset().mockResolvedValue([]);
  h.manageable.mockReset().mockResolvedValue(units());
  h.session.mockReset();
  vi.stubEnv("PATENT_CITATIONS_REPORT", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("parsePatentCitationParams", () => {
  it("a bare URL is every paper of any year, by publication, most citing inventions first", () => {
    expect(parse()).toEqual({
      types: [],
      units: [],
      people: [],
      positions: [],
      basis: "cy",
      from: null,
      to: null,
      cfrom: null,
      cto: null,
      assignees: [],
      where: "any",
      view: "publications",
      sort: "inventions",
      inventionSort: "papers",
      q: "",
      page: 1,
      scope: [],
    });
    expect(isPatentCitationDefault(parse())).toBe(true);
    // View state is not a filter.
    expect(isPatentCitationDefault(parse("view=people&sort=recent&isort=recent&q=abc&page=3"))).toBe(true);
    expect(isPatentCitationDefault(parse("from=2010"))).toBe(false);
    expect(isPatentCitationDefault(parse("where=front"))).toBe(false);
  });

  it("reads each filter, drops what it does not know, and keeps ranges in order", () => {
    const p = parse(
      "type=full_time_faculty&unit=dept:N1&person=abc1001&person=bad%20one&pos=last&pos=nope&basis=fy" +
        "&from=2012&to=2001&cfrom=2018&cto=2021&assignee=%20Example%20Biotech%2C%20Inc.%20&assignee=Example%20Biotech%2C%20Inc." +
        "&assignee=&where=front&view=inventions&sort=year&isort=recent&q=%20kinase%20&page=4",
    );
    expect(p).toMatchObject({
      types: ["full_time_faculty"],
      units: ["dept:N1"],
      people: ["abc1001"],
      positions: ["last"],
      basis: "fy",
      from: 2012,
      to: 2012,
      cfrom: 2018,
      cto: 2021,
      assignees: ["Example Biotech, Inc."],
      where: "front",
      view: "inventions",
      sort: "year",
      inventionSort: "recent",
      q: "kinase",
      page: 4,
    });
    expect(parse("where=sideways&view=documents&sort=ranked&isort=x&page=-2&cfrom=abc")).toMatchObject({
      where: "any",
      view: "publications",
      sort: "inventions",
      inventionSort: "papers",
      page: 1,
      cfrom: null,
    });
  });

  it("never reads a scope from the URL: unresolved params match nothing", () => {
    expect(parse("scope=dept:N1").scope).toEqual([]);
  });

  it("the query string round-trips, always carries basis, and carries page only when asked", () => {
    const qs = "unit=dept%3AN1&person=abc1001&assignee=Example+Biotech%2C+Inc.&where=body&basis=cy&from=2001&cfrom=2015&view=inventions&sort=recent&isort=recent&q=kinase";
    const p = parse(`${qs}&page=3`);
    expect(patentCitationQueryString(p)).toBe(qs);
    expect(patentCitationQueryString(p, { page: 3 })).toBe(`${qs}&page=3`);
    expect(parse(patentCitationQueryString(p, { page: 3 }))).toEqual(p);
    expect(patentCitationQueryString(parse())).toBe("basis=cy");
  });
});

describe("the flag", () => {
  it("is on only at exactly 'on'", () => {
    for (const v of ["off", "ON", "true", "1", ""]) {
      vi.stubEnv("PATENT_CITATIONS_REPORT", v);
      expect(isPatentCitationsReportEnabled()).toBe(false);
    }
    vi.stubEnv("PATENT_CITATIONS_REPORT", "on");
    expect(isPatentCitationsReportEnabled()).toBe(true);
  });

  it("off: nobody can view it, so the index omits it and the page 404s, a superuser included", async () => {
    vi.stubEnv("PATENT_CITATIONS_REPORT", "off");
    expect(await canViewPatentCitationsReport(SUPER)).toBe(false);
    h.manageable.mockResolvedValue(units({ departments: [{ code: "N1" }] }));
    expect(await canViewPatentCitationsReport(ADMIN)).toBe(false);
    expect(h.manageable).not.toHaveBeenCalled();
  });

  it("off: the download route 404s before it looks at the session", async () => {
    vi.stubEnv("PATENT_CITATIONS_REPORT", "off");
    h.session.mockResolvedValue(SUPER);
    const res = await GET(new Request("http://localhost/api/edit/reports/patent-citations"));
    expect(res.status).toBe(404);
    expect(h.session).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("on: report 24's access rule, and report 25 is registered with this gate", async () => {
    expect(await canViewPatentCitationsReport(SUPER)).toBe(true);
    expect(await canViewPatentCitationsReport({ ...ADMIN, isCommsSteward: true })).toBe(true);
    expect(await canViewPatentCitationsReport(ADMIN)).toBe(false);
    // A core is not a unit this report can narrow to.
    h.manageable.mockResolvedValue(units({ cores: [{ code: "K1" }] }));
    expect(await canViewPatentCitationsReport(ADMIN)).toBe(false);
    h.manageable.mockResolvedValue(units({ centers: [{ code: "C7" }] }));
    expect(await canViewPatentCitationsReport(ADMIN)).toBe(true);
    const def = REPORTS["25"];
    expect(def.gate).toBe("admin");
    expect(def.gate === "admin" && def.canView).toBe(canViewPatentCitationsReport);
    expect(def.gate === "admin" && def.accessRule).toBe(POLICY_CITATIONS_ACCESS_RULE);
    expect(REPORT_META_DEFAULTS["25"]).toMatchObject({ slug: "patent-citations", name: "Patent citations" });
  });
});

describe("where the per-publication counts come from", () => {
  it("no filter on the patents: the rollup column on publication, the link table not read", async () => {
    await loadPatentPublicationCounts({ ...parse("from=2010&unit=dept:N1"), scope: null });
    const { text } = call(0);
    expect(text).toContain("MAX(p.patent_family_count) AS inventions");
    expect(text).toContain("WHERE p.patent_family_count > 0");
    expect(text).not.toContain("publication_citing_document");
    expect(text).toContain("GROUP BY p.pmid");
  });

  it.each<[string, string, RegExp, unknown[]]>([
    ["a patent year", "cfrom=2018", /d\.year >= \?/, [2018]],
    ["an assignee", "assignee=Example+Biotech", /JSON_CONTAINS\(d\.details, JSON_QUOTE\(\?\), '\$\.assignees'\)/, ["Example Biotech"]],
    ["where cited", "where=front", /JSON_EXTRACT\(l\.evidence, '\$\.where'\)\) IN \(\?, 'both'\)/, ["front"]],
  ])("%s: the live aggregate over patent links, filtered inside", async (_what, qs, clause, bound) => {
    await loadPatentPublicationCounts({ ...parse(qs), scope: null });
    const { text, values } = call(0);
    expect(text).toContain("COUNT(DISTINCT d.dedup_key) AS inventions, MAX(d.year) AS latest");
    expect(text).toContain("WHERE d.level = 'patent'");
    expect(text).toMatch(clause);
    expect(values).toEqual(expect.arrayContaining(bound));
    expect(text).toContain("GROUP BY l.pmid) x");
    expect(text).not.toContain("patent_family_count");
  });

  it("the latest patent year needs the links: the Most recently cited sort and the download ask for it", async () => {
    await loadPatentPublicationCounts({ ...parse(), scope: null }, { latest: true });
    expect(call(0).text).toContain("MAX(d.year) AS latest");
    h.queryRaw.mockClear();
    await loadPatentCitations({ ...parse("sort=recent"), scope: null });
    expect(calls().filter((c) => c.text.includes("MAX(x.latest) AS latest"))).toHaveLength(1);
    h.queryRaw.mockClear();
    // The default page: nothing counts per publication over the links.
    await loadPatentCitations({ ...parse(), scope: null });
    expect(calls().filter((c) => c.text.includes("GROUP BY l.pmid"))).toHaveLength(0);
  });

  it("every count is of patent documents only, grouped into inventions by dedup_key", async () => {
    const p = { ...parse("cfrom=2001"), scope: null };
    await Promise.all([
      loadPatentPublicationCounts(p),
      loadPatentPersonCounts(p),
      loadInventionCounts(p),
      loadAssigneeCounts(p),
      loadPersonInventions(p, ["abc1001"]),
      loadCitingInventions(p, ["111"]),
    ]);
    for (const { text } of calls()) {
      expect(text).toContain("d.level = 'patent'");
      expect(text).toContain("d.dedup_key");
    }
  });

  it("sorts: most inventions, most recently cited, publication year; ties go to the newer paper", () => {
    const rows = [
      { pmid: "1", year: 2001, inventions: 5, latest: 2010 },
      { pmid: "2", year: 2015, inventions: 5, latest: 2024 },
      { pmid: "3", year: 1999, inventions: 9, latest: 2005 },
    ];
    expect(sortPatentPublications(rows, "inventions").map((r) => r.pmid)).toEqual(["3", "2", "1"]);
    expect(sortPatentPublications(rows, "recent").map((r) => r.pmid)).toEqual(["2", "1", "3"]);
    expect(sortPatentPublications(rows, "year").map((r) => r.pmid)).toEqual(["2", "1", "3"]);
  });
});

describe("scope narrowing", () => {
  const scoped = async (qs = "") => {
    h.manageable.mockResolvedValue(units({ divisions: [{ code: "N5" }] }));
    return resolvePatentCitationParams(parse(qs), ADMIN);
  };
  /** Every query either carries the viewer's division, or reads patent facts alone. */
  const expectEveryQueryScoped = (expected: { scoped: number; patentFactsOnly: number }) => {
    const seen = { scoped: 0, patentFactsOnly: 0 };
    for (const { text, values } of calls()) {
      if (readsPeopleOrPapers(text)) {
        expect(text, text).toContain("s.div_code IN (?)");
        expect(values, text).toContain("N5");
        seen.scoped += 1;
      } else {
        // Nothing but the patent table: no link, no paper, no person.
        expect(text, text).toMatch(/ FROM citing_document d WHERE /);
        expect(text, text).not.toContain("publication_citing_document");
        seen.patentFactsOnly += 1;
      }
    }
    expect(seen).toEqual(expected);
  };

  it("a superuser and a comms steward see everything: no scope clause", async () => {
    const p = await resolvePatentCitationParams(parse("unit=dept:N2"), SUPER);
    expect(p.scope).toBeNull();
    expect(h.manageable).not.toHaveBeenCalled();
    await loadPatentPublicationCounts(p);
    expect(call(0).text.match(/s\.dept_code IN/g)).toHaveLength(1);
    expect((await resolvePatentCitationParams(parse(), { ...ADMIN, isCommsSteward: true })).scope).toBeNull();
  });

  it("a unit administrator is pinned to their units, whatever the URL says", async () => {
    const p = await scoped("unit=dept:N2&scope=dept:N2");
    expect(p.scope).toEqual(["div:N5"]);
    await loadPatentPublicationCounts(p);
    const { text, values } = call(0);
    // Both clauses are present; neither replaces the other.
    expect(text).toContain("s.div_code IN (?)");
    expect(text).toContain("s.dept_code IN (?)");
    expect(values.indexOf("N5")).toBeLessThan(values.indexOf("N2"));
  });

  it("someone who administers no unit matches nothing", async () => {
    const p = await resolvePatentCitationParams(parse(), ADMIN);
    expect(p.scope).toEqual([]);
    await loadPatentPublicationCounts(p);
    expect(call(0).text).toContain("AND 1 = 0");
  });

  it("the counts: every query of the default page carries the scope", async () => {
    await loadPatentCitations(await scoped());
    // Scope totals, publications, people, inventions, assignees.
    expectEveryQueryScoped({ scoped: 5, patentFactsOnly: 0 });
  });

  it("with patent filters, a search and the recent sort: still every query", async () => {
    const qs = "cfrom=2015&where=body&assignee=Example+Biotech&sort=recent";
    await loadPatentCitations(await scoped(`${qs}&q=kinase`));
    // The five above, the rail's assignee options, and the publication search.
    expectEveryQueryScoped({ scoped: 7, patentFactsOnly: 0 });
    h.queryRaw.mockClear();
    await loadPatentCitations(await scoped(`${qs}&q=kinase&view=inventions`));
    // The invention search reads patent titles, numbers and assignees, and nothing else.
    expectEveryQueryScoped({ scoped: 6, patentFactsOnly: 1 });
    expect(calls().filter((c) => !readsPeopleOrPapers(c.text))[0].text).toContain("SELECT DISTINCT d.dedup_key");
  });

  it("the Person facet's counts keep the scope and leave the person filter out", async () => {
    await loadPatentPersonCounts(await scoped("person=zzz9999"));
    expect(call(0).values).toContain("N5");
    expect(call(0).values).not.toContain("zzz9999");
  });

  it("one page's details: the rows are tested against the scope again", async () => {
    const p = await scoped("unit=dept:N2");
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("GROUP BY ok.pmid, d.dedup_key")
        ? [{ pmid: "111", dedup_key: "15000001", docs: 1, rep: rep(false, 2020, 7), latest: 2020, front: 1, body: 0 }]
        : [],
    );
    await withPublicationDetails(p, [{ pmid: "111", year: 2001, inventions: 1, latest: null }], { inventions: true });
    // Authors and citing inventions carry the scope; the patent's own facts are read by id.
    expectEveryQueryScoped({ scoped: 2, patentFactsOnly: 1 });
    expect(calls().every((c) => !readsPeopleOrPapers(c.text) || c.values.includes("111"))).toBe(true);

    h.queryRaw.mockReset().mockResolvedValue([]);
    const invention: InventionCounts = { key: "15000001", docId: 7, year: 2020, application: false, docs: 1, papers: 3 };
    await withInventionDetails(p, [invention], { papers: true });
    expectEveryQueryScoped({ scoped: 1, patentFactsOnly: 1 });
    const papers = calls().find((c) => readsPeopleOrPapers(c.text))!;
    expect(papers.text).toContain("d.dedup_key IN (?)");
    expect(papers.values).toEqual(expect.arrayContaining(["15000001", "N5", "N2"]));

    h.queryRaw.mockReset().mockResolvedValue([]);
    await loadPersonInventions(p, ["abc1001"]);
    await loadPersonInventions(p, null);
    expectEveryQueryScoped({ scoped: 2, patentFactsOnly: 0 });
    expect(call(0).values).toContain("abc1001");
    // Nobody on the page: no query at all.
    h.queryRaw.mockClear();
    expect(await loadPersonInventions(p, [])).toEqual(new Map());
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("the share-of-scope totals join publication only for a year window, scoped either way", async () => {
    await loadScopeTotals(await scoped());
    await loadScopeTotals(await scoped("from=2010"));
    expect(call(0).text).not.toContain("JOIN publication p");
    expect(call(1).text).toContain("JOIN publication p");
    for (const n of [0, 1]) expect(call(n).values).toContain("N5");
  });

  it("the download route pins the same scope and refuses a viewer with no unit", async () => {
    const url = "http://localhost/api/edit/reports/patent-citations?unit=dept:N2&cfrom=2015";
    h.session.mockResolvedValue(null);
    expect((await GET(new Request(url))).status).toBe(401);

    h.session.mockResolvedValue(ADMIN);
    expect((await GET(new Request(url))).status).toBe(403);
    expect(h.queryRaw).not.toHaveBeenCalled();

    h.manageable.mockResolvedValue(units({ divisions: [{ code: "N5" }] }));
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("MAX(x.inventions) AS inventions")) return [{ pmid: "111", year: 2001, inventions: 2, latest: 2020 }];
      if (text.includes("MIN(") && text.includes("GROUP BY d.dedup_key")) {
        return [{ dedup_key: "15000001", papers: 1, docs: 2, rep: rep(false, 2020, 7) }];
      }
      if (text.includes("COUNT(*) AS papers")) {
        return [{ cwid: "abc1001", preferred_name: "Example Person", primary_department: null, role_category: null, primary_org_code: null, papers: 1 }];
      }
      return [];
    });
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Patent citations \d{4}-\d{2}-\d{2}\.xlsx"$/);
    // Counts (5), then authors and everyone's inventions; the patent facts by id.
    expectEveryQueryScoped({ scoped: 7, patentFactsOnly: 1 });
    // The Publications sheet's latest year comes from the links.
    expect(calls().some((c) => c.text.includes("MAX(x.latest) AS latest"))).toBe(true);
  });

  it("the scope is a chip that cannot be removed, and a Criteria row", async () => {
    const p = await scoped("cfrom=2015&cto=2020&assignee=Example+Biotech&where=front&from=2001");
    const chips = patentCitationChips(p, new Map([["div:N5", "Division of Examples"]]));
    expect(chips[0]).toEqual({ group: "Unit", value: "Division of Examples", removeQuery: null });
    expect(chips.slice(1).map((c) => `${c.group}: ${c.value}`)).toEqual([
      "Published: 2001 or later",
      "Patent year: 2015 to 2020",
      "Assignee: Example Biotech",
      "Where cited: Front page",
    ]);
    expect(chips[3].removeQuery).not.toContain("assignee=");
    expect(chips[4].removeQuery).not.toContain("where=");
    const criteria = new Map(describePatentCitationCriteria(p, new Date("2026-11-26T12:00:00Z"), new Map([["div:N5", "Division of Examples"]])));
    expect(criteria.get("Report")).toBe("25. Patent citations");
    expect(criteria.get("Access")).toBe("Limited to the units you administer: Division of Examples");
    expect(criteria.get("Patent year granted or published")).toBe("2015 to 2020");
    expect(criteria.get("Assignee")).toBe("Example Biotech");
    expect(criteria.get("Where cited")).toBe("Front page");
    expect(criteria.get("Publication years")).toBe("2001 or later");
    expect(describePatentCitationCriteria({ ...parse(), scope: null }, new Date(0))).toEqual(
      expect.arrayContaining([
        ["Access", "All units"],
        ["Publication years", "All"],
        ["Patent year granted or published", "All"],
        ["Assignee", "All"],
        ["Where cited", "Front page or text"],
      ]),
    );
  });
});

describe("inventions: patent documents grouped by family", () => {
  const P = { ...parse(), scope: null };
  const docRow = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    title: `Example composition ${id}`,
    url: `https://patents.google.com/patent/US9000000${id}B2/en`,
    external_id: `us-9000000${id}-b2`,
    details: { kind: "grant", assignees: ["Example Biotech, Inc."], inventors: [{ first: "Ada", last: "Sample" }, { first: "Ben", last: "Fixture" }] },
    ...over,
  });

  it("the related-patents label counts the group's other documents", () => {
    expect(relatedPatentsLabel(1)).toBe("");
    expect(relatedPatentsLabel(2)).toBe("and 1 related patent");
    expect(relatedPatentsLabel(4)).toBe("and 3 related patents");
    expect(relatedPatentsLabel(1492)).toBe("and 1,491 related patents");
  });

  it("the holder is the assignee, or the first inventor et al. when the document names none", () => {
    expect(patentHolder({ assignees: ["Example Biotech, Inc.", "Sample University"], firstInventor: "Ada Sample", inventors: 3 })).toBe(
      "Example Biotech, Inc.; Sample University",
    );
    expect(patentHolder({ assignees: [], firstInventor: "Ada Sample", inventors: 3 })).toBe("Ada Sample et al.");
    expect(patentHolder({ assignees: [], firstInventor: "Ada Sample", inventors: 1 })).toBe("Ada Sample");
    expect(patentHolder({ assignees: [], firstInventor: null, inventors: 0 })).toBe("");
  });

  it("a granted patent says granted, a published application says so", () => {
    expect(patentYearLabel(2019, false)).toBe("granted 2019");
    expect(patentYearLabel(2021, true)).toBe("application published 2021");
    expect(patentYearLabel(null, false)).toBe("granted");
  });

  it("patent facts: the display number, assignees and first inventor, from JSON as text (MariaDB) or an object (MySQL)", async () => {
    h.queryRaw.mockResolvedValueOnce([
      docRow(1, { details: JSON.stringify({ kind: "grant", assignees: [], inventors: [{ first: "Ada", last: "Sample" }] }) }),
      docRow(2),
      docRow(3, { external_id: "us-2021000003-a1", details: null }),
    ]);
    const docs = await loadPatentDocs([1, 2, 3]);
    expect(docs.get(1)).toMatchObject({ number: "US90000001B2", assignees: [], firstInventor: "Ada Sample", inventors: 1 });
    expect(docs.get(2)).toMatchObject({ assignees: ["Example Biotech, Inc."], firstInventor: "Ada Sample", inventors: 2 });
    // The dataset's ten-digit application number gets its zero back.
    expect(docs.get(3)).toMatchObject({ number: "US20210000003A1", assignees: [], firstInventor: null, inventors: 0 });
    expect(call(0).text).toMatch(/FROM citing_document d WHERE d\.id IN \(\?,\?,\?\)$/);
  });

  it("under a publication: one entry per invention, shown by the document `rep` names, newest first", async () => {
    h.queryRaw
      .mockResolvedValueOnce([
        // Three documents of one family; the earliest granted one stands for it.
        { pmid: "111", dedup_key: "15000001", docs: 3n, rep: rep(false, 2019, 2), latest: 2023, front: 1n, body: 1n },
        // No granted patent, and no assignee on the application.
        { pmid: "111", dedup_key: "17000002", docs: 1n, rep: rep(true, 2022, 1), latest: 2022, front: 0n, body: 1n },
        { pmid: "222", dedup_key: "15000001", docs: 1n, rep: rep(false, 2019, 2), latest: 2019, front: 1n, body: 0n },
      ])
      .mockResolvedValueOnce([
        docRow(1, { external_id: "us-2022000001-a1", details: { kind: "application", assignees: [], inventors: [{ first: "Ada", last: "Sample" }, { first: "Ben", last: "Fixture" }] } }),
        docRow(2),
      ]);
    const out = await loadCitingInventions(P, ["111", "222"]);
    expect(call(0).text).toContain("GROUP BY ok.pmid, d.dedup_key");
    expect(call(1).values).toEqual([1, 2]);
    const first = out.get("111")!;
    expect(first.total).toBe(2);
    expect(first.latest).toBe(2023);
    expect(first.shown.map((d) => d.key)).toEqual(["17000002", "15000001"]);
    const [application, family] = first.shown;
    expect(application).toMatchObject({ id: 1, year: 2022, application: true, docs: 1, where: "body", number: "US20220000001A1" });
    expect(patentHolder(application)).toBe("Ada Sample et al.");
    expect(relatedPatentsLabel(application.docs)).toBe("");
    expect(family).toMatchObject({ id: 2, year: 2019, application: false, docs: 3, where: "both", title: "Example composition 2" });
    expect(patentHolder(family)).toBe("Example Biotech, Inc.");
    expect(relatedPatentsLabel(family.docs)).toBe("and 2 related patents");
    expect(out.get("222")!.shown[0]).toMatchObject({ key: "15000001", docs: 1, where: "front" });
  });

  it("a heavily cited paper lists its newest inventions only; the total is the full number", async () => {
    const many = Array.from({ length: INVENTIONS_SHOWN + 5 }, (_, i) => ({
      pmid: "111",
      dedup_key: `k${i}`,
      docs: 1,
      rep: rep(false, 1990 + i, i + 1),
      latest: 1990 + i,
      front: 1,
      body: 0,
    }));
    h.queryRaw.mockResolvedValueOnce(many).mockResolvedValueOnce([]);
    const pub = (await loadCitingInventions(P, ["111"])).get("111")!;
    expect(pub.total).toBe(INVENTIONS_SHOWN + 5);
    expect(pub.shown).toHaveLength(INVENTIONS_SHOWN);
    expect(pub.shown[0].year).toBe(1990 + INVENTIONS_SHOWN + 4);
    // Patent facts are asked for the shown documents alone.
    expect(call(1).values).toHaveLength(INVENTIONS_SHOWN);
  });

  it("a row with no latest year of its own takes it from its citing inventions", async () => {
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("GROUP BY ok.pmid, d.dedup_key")) {
        return [{ pmid: "111", dedup_key: "15000001", docs: 1, rep: rep(false, 2019, 2), latest: 2021, front: 1, body: 0 }];
      }
      if (text.includes("pa.is_first")) {
        return [{ pmid: "111", title: "An example paper", journal: "J Ex", doi: null, cwid: "abc1001", preferred_name: "Example Person", is_first: 1, is_last: 0 }];
      }
      return [];
    });
    const [row] = await withPublicationDetails(P, [{ pmid: "111", year: 2001, inventions: 1, latest: null }], { inventions: true });
    expect(row).toMatchObject({ title: "An example paper", latest: 2021, authors: [{ cwid: "abc1001", position: "first" }] });
    expect(row.shown).toHaveLength(1);
    // The sheet's rows: no citing inventions loaded.
    h.queryRaw.mockClear();
    await withPublicationDetails(P, [{ pmid: "111", year: 2001, inventions: 1, latest: 2020 }], { inventions: false });
    expect(calls().some((c) => c.text.includes("citing_document"))).toBe(false);
  });

  it("the invention listing: one row per dedup_key, sorted, and counted per year for the chart", async () => {
    h.queryRaw.mockResolvedValueOnce([
      { dedup_key: "15000001", papers: 4n, docs: 3n, rep: rep(false, 2019, 2) },
      { dedup_key: "17000002", papers: 9n, docs: 1n, rep: rep(true, 2022, 1) },
      { dedup_key: "09000003", papers: 4n, docs: 1n, rep: rep(false, 2025, 5) },
      { dedup_key: "08000004", papers: 1n, docs: 1n, rep: rep(false, 2001, 6) },
    ]);
    const rows = await loadInventionCounts(P);
    expect(call(0).text).toContain("GROUP BY d.dedup_key");
    expect(rows[1]).toEqual({ key: "17000002", docId: 1, year: 2022, application: true, docs: 1, papers: 9 });
    expect(sortInventions(rows, "papers").map((r) => r.key)).toEqual(["17000002", "09000003", "15000001", "08000004"]);
    expect(sortInventions(rows, "recent").map((r) => r.key)).toEqual(["09000003", "17000002", "15000001", "08000004"]);
    const years = inventionYears(rows);
    expect(years.map((y) => y.year)).toEqual([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
    expect(years.filter((y) => y.count > 0)).toEqual([
      { year: 2019, count: 1 },
      { year: 2022, count: 1 },
      { year: 2025, count: 1 },
    ]);
  });

  it("an invention's papers: the newest 25, each paper once", async () => {
    const invention: InventionCounts = { key: "15000001", docId: 2, year: 2019, application: false, docs: 3, papers: 30 };
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("GROUP BY d.dedup_key, p.pmid")
        ? Array.from({ length: 30 }, (_, i) => ({ dedup_key: "15000001", pmid: String(100 + i), year: 1990 + i, title: `Paper ${i}`, journal: "J Ex" }))
        : [docRow(2)],
    );
    const [row] = await withInventionDetails(P, [invention], { papers: true });
    expect(row).toMatchObject({ key: "15000001", docs: 3, papers: 30, number: "US90000002B2", assignees: ["Example Biotech, Inc."] });
    expect(row.shown).toHaveLength(25);
    expect(row.shown[0]).toEqual({ pmid: "129", year: 2019, title: "Paper 29", journal: "J Ex" });
  });

  it("the invention search matches a title, a patent number however it is typed, or an assignee", async () => {
    h.queryRaw.mockResolvedValueOnce([{ dedup_key: "15000001" }]);
    expect(await searchInventions("US 9,000,001 B2")).toEqual(new Set(["15000001"]));
    expect(call(0).values).toEqual(["%US 9,000,001 B2%", "%9000001%", "%us 9,000,001 b2%"]);
    await searchInventions("Example Biotech");
    expect(call(1).text).not.toContain("d.external_id LIKE");
  });

  it("the assignee card counts inventions and papers per printed name; the rail's options ignore the assignee filter", async () => {
    h.queryRaw.mockResolvedValue([
      { name: "Example Biotech, Inc.", inventions: 12n, papers: 30n },
      { name: null, inventions: 1n, papers: 1n },
    ]);
    const p = { ...parse("assignee=Example+Biotech%2C+Inc."), scope: null };
    expect(await loadAssigneeCounts(p)).toEqual([{ name: "Example Biotech, Inc.", inventions: 12, papers: 30 }]);
    expect(call(0).text).toContain("JSON_TABLE(d.details, '$.assignees[*]'");
    expect(call(0).text).toContain("JSON_CONTAINS");
    await loadAssigneeCounts(p, { assignees: false });
    expect(call(1).text).not.toContain("JSON_CONTAINS");
  });
});

describe("the workbook", () => {
  const P = { ...parse("cfrom=2015"), scope: null };
  const person = (i: number): PatentPersonRow => ({
    cwid: `abc${String(1000 + i)}`,
    name: `Example Person ${i}`,
    orgUnit: "Department of Examples",
    personType: "Full-time faculty",
    institution: "Weill Cornell Medicine",
    papers: 3,
    inventions: 7,
  });
  const pub: PatentPubRow = {
    pmid: "12345",
    title: "An <i>example</i> title",
    journal: "J Ex",
    doi: "10.1000/example",
    year: 2004,
    inventions: 6,
    latest: 2021,
    authors: [{ cwid: "abc1001", name: "Example Person 1", position: "last" }],
    shown: [],
  };
  const invention: InventionRow = {
    key: "15000001",
    docId: 2,
    year: 2019,
    application: false,
    docs: 3,
    papers: 4,
    title: "Example composition",
    url: "https://patents.google.com/patent/US90000002B2/en",
    number: "US90000002B2",
    assignees: ["Example Biotech, Inc.", "Sample University"],
    firstInventor: "Ada Sample",
    inventors: 2,
    shown: [],
  };
  const build = (over: Partial<Parameters<typeof buildPatentCitationWorkbook>[1]> = {}) =>
    buildPatentCitationWorkbook(
      P,
      { pubs: [pub], pubTotal: 1, inventions: [invention], inventionTotal: 1, people: [person(1)], ...over },
      new Date("2026-11-26T12:00:00Z"),
    );
  const read = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  };
  const rowValues = (ws: ExcelJS.Worksheet, n: number) => (ws.getRow(n).values as unknown[]).slice(1);
  const criteria = (wb: ExcelJS.Workbook) => {
    const out = new Map<string, string>();
    wb.getWorksheet("Criteria")!.eachRow((r) => out.set(String(r.getCell(1).value), String(r.getCell(2).value)));
    return out;
  };

  it("four sheets, in order, with plain titles and one row per invention", async () => {
    const wb = await read(await build());
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Publications", "Inventions", "People", "Criteria"]);
    const pubs = wb.getWorksheet("Publications")!;
    expect(rowValues(pubs, 1)).toEqual([
      "PMID",
      "Title",
      "Journal",
      "Year",
      "WCM authors",
      "Citing inventions",
      "Latest citing patent year",
      "DOI",
    ]);
    expect(rowValues(pubs, 2)).toEqual([
      "12345",
      "An example title",
      "J Ex",
      2004,
      "Example Person 1 (last author)",
      6,
      2021,
      "10.1000/example",
    ]);
    const inventions = wb.getWorksheet("Inventions")!;
    expect(rowValues(inventions, 1)).toEqual([
      "Patent",
      "Title",
      "Assignees",
      "First inventor",
      "Granted or published",
      "Year",
      "Related patents",
      "WCM papers cited",
      "Link",
    ]);
    expect(rowValues(inventions, 2)).toEqual([
      "US90000002B2",
      "Example composition",
      "Example Biotech, Inc.; Sample University",
      "Ada Sample",
      "Granted",
      2019,
      2,
      4,
      "https://patents.google.com/patent/US90000002B2/en",
    ]);
  });

  it("the People sheet lists everyone past the 50-scholar cap, with report 24's columns and no contact column", async () => {
    const n = SCHOLAR_EXPORT_CAP + 25;
    const wb = await read(await build({ people: Array.from({ length: n }, (_, i) => person(i + 1)) }));
    const people = wb.getWorksheet("People")!;
    expect(people.rowCount).toBe(n + 1);
    expect(rowValues(people, 1)).toEqual([
      "Name",
      "CWID",
      "Org unit",
      "Person type",
      "Primary institution",
      "Papers cited in a patent",
      "Citing inventions",
    ]);
    expect(rowValues(people, 2)).toEqual([
      "Example Person 1",
      "abc1001",
      "Department of Examples",
      "Full-time faculty",
      "Weill Cornell Medicine",
      3,
      7,
    ]);
    for (const ws of wb.worksheets) {
      ws.eachRow((r) => expect(JSON.stringify(r.values)).not.toMatch(/e-?mail|phone|@/i));
    }
    expect(criteria(wb).get("People sheet")).toBe(
      `Lists all ${n} people, with no contact details. This report follows report 24's exemption from the 50-person limit on scholar exports.`,
    );
  });

  it("Criteria states the filters, the caveat, the sources and each sheet's cap", async () => {
    const all = criteria(await read(await build()));
    expect(all.get("Report")).toBe("25. Patent citations");
    expect(all.get("Patent year granted or published")).toBe("2015 or later");
    expect(all.get("Counting rule")).toContain("related patents (one patent family) count once");
    expect(all.get("Reading the numbers")).toContain("seven or more years later");
    expect(all.get("Reading the numbers")).toContain("The patent data ends at 31 December 2025.");
    expect(all.get("Sources")).toContain("Reliance on Science (Marx and Fuegi), CC BY-NC 4.0");
    expect(all.get("Publications sheet")).toBe("Lists all 1 publications (the limit is 5,000).");
    expect(all.get("Inventions sheet")).toBe(
      "One row per invention, shown by its earliest granted patent. Lists all 1 inventions (the limit is 20,000).",
    );

    const cut = criteria(await read(await build({ pubTotal: 24366, inventionTotal: 68730 })));
    expect(cut.get("Publications sheet")).toBe(
      "Lists the first 1 of 24,366 publications in the order above (the limit is 5,000). Narrow the filters to list the rest.",
    );
    expect(cut.get("Inventions sheet")).toContain("Lists the first 1 of 68,730 inventions in the order above (the limit is 20,000).");
  });

  it("the download cuts each sheet at its cap and still lists every person", async () => {
    h.session.mockResolvedValue(SUPER);
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("MAX(x.inventions) AS inventions")) {
        return Array.from({ length: PATENT_LIST_CAP + 10 }, (_, i) => ({ pmid: String(100000 + i), year: 2001, inventions: 1, latest: 2020 }));
      }
      if (text.includes("MIN(") && text.includes("GROUP BY d.dedup_key")) {
        return Array.from({ length: PATENT_INVENTIONS_CAP + 10 }, (_, i) => ({ dedup_key: `k${i}`, papers: 1, docs: 1, rep: rep(false, 2020, i + 1) }));
      }
      if (text.includes("COUNT(*) AS papers")) {
        return Array.from({ length: SCHOLAR_EXPORT_CAP + 5 }, (_, i) => ({
          cwid: `abc${1000 + i}`,
          preferred_name: `Example Person ${i}`,
          primary_department: null,
          role_category: null,
          primary_org_code: null,
          papers: 1,
        }));
      }
      return [];
    });
    const res = await GET(new Request("http://localhost/api/edit/reports/patent-citations"));
    expect(res.status).toBe(200);
    const wb = await read(Buffer.from(await res.arrayBuffer()));
    expect(wb.getWorksheet("Publications")!.rowCount).toBe(PATENT_LIST_CAP + 1);
    expect(wb.getWorksheet("Inventions")!.rowCount).toBe(PATENT_INVENTIONS_CAP + 1);
    expect(wb.getWorksheet("People")!.rowCount).toBe(SCHOLAR_EXPORT_CAP + 5 + 1);
    const notes = criteria(wb);
    expect(notes.get("Publications sheet")).toContain(`Lists the first 5,000 of ${(PATENT_LIST_CAP + 10).toLocaleString()} publications`);
    expect(notes.get("Inventions sheet")).toContain(`Lists the first 20,000 of ${(PATENT_INVENTIONS_CAP + 10).toLocaleString()} inventions`);
    // Authors are asked for the listed publications alone.
    const authors = calls().find((c) => c.text.includes("pa.is_first"))!;
    expect(authors.values).toHaveLength(PATENT_LIST_CAP);
  }, 30_000);
});
