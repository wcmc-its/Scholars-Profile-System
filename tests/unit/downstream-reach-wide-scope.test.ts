/** Report 27 (Downstream reach) on wide selections: the scope total is counted
 *  from `publication` (the same joins and conditions as before, with the join
 *  order pinned), and the Citing documents view is withheld above
 *  `REACH_DOCS_PAPER_CEILING` cited papers: the grouped query is not run, the
 *  tab shows a message and no count of citing documents, and the download's
 *  sheet carries a note. At or below the ceiling, and on a view filtered to
 *  one paper, nothing changes.
 *
 *  `$queryRaw` is answered by a small model of the tables (`answer`), as in
 *  `downstream-reach-report.test.ts`; the loaders, the page body and the
 *  download route are the real ones. Nothing here runs SQL: the text is
 *  asserted. Fixture people and papers are invented. */
import { createElement, Fragment } from "react";
import { cleanup, render, within } from "@testing-library/react";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      topic: { findMany: vi.fn(async () => []) },
      suppression: { findMany: vi.fn(async () => []) },
      publicationAuthor: { findMany: vi.fn(async () => []) },
    },
    write: {},
  },
}));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: vi.fn() }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({ roleCategories: [], departments: [], centers: [], institutions: [] })),
}));
vi.mock("@/lib/edit/bibliometrics-access", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/bibliometrics-access")>()),
  loadBibliometricsAccess: vi.fn(async () => new Set<string>()),
}));

import { GET } from "@/app/api/edit/reports/downstream-reach/route";
import { renderDownstreamReachReport } from "@/components/edit/reports/downstream-reach-body";
import {
  buildReachWorkbook,
  docsTooWide,
  docsWithheldNote,
  loadReach,
  loadScopeTotal,
  parseReachParams,
  REACH_DOCS_CAP,
  REACH_DOCS_PAPER_CEILING,
  REACH_LIST_CAP,
  reachLinks,
  reachPubSql,
  resolveReachParams,
  type ReachParams,
  type ReachView,
} from "@/lib/edit/downstream-reach-report";
import { policyScopeSql } from "@/lib/edit/policy-citations-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";
import { Prisma } from "@/lib/generated/prisma/client";

const SUPER = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false };
const BASE = "/edit/reports/downstream-reach";
const parse = (qs = "") => parseReachParams(new URLSearchParams(qs));

// ---------------------------------------------------------------------------
// The in-memory dataset: every paper is T0, and cites clinical study 1 unless
// it says otherwise.
// ---------------------------------------------------------------------------

type Author = { cwid: string; confirmed?: boolean; active?: boolean };
type Pub = { pmid: string; year: number; authors: Author[]; cited: boolean };

const SMALL: Pub[] = [
  { pmid: "101", year: 2021, authors: [{ cwid: "aaa1001" }], cited: true },
  // Two matching authors: two rows of the join, one paper.
  { pmid: "102", year: 2022, authors: [{ cwid: "aaa1001" }, { cwid: "bbb1002" }], cited: true },
  // In scope, cited by nothing.
  { pmid: "103", year: 2022, authors: [{ cwid: "bbb1002" }], cited: false },
  // An unconfirmed authorship, and an author who is no longer active: out of scope.
  { pmid: "104", year: 2022, authors: [{ cwid: "aaa1001", confirmed: false }], cited: true },
  { pmid: "105", year: 2022, authors: [{ cwid: "ccc1003", active: false }], cited: true },
  // Before the default years.
  { pmid: "106", year: 2018, authors: [{ cwid: "aaa1001" }], cited: true },
];
/** `n` cited papers by one author, 2021. */
const wide = (n: number): Pub[] =>
  Array.from({ length: n }, (_, i) => ({ pmid: String(1_000_000 + i), year: 2021, authors: [{ cwid: "aaa1001" }], cited: true }));

let pubs: Pub[] = SMALL;
/** The params of the loader call being answered. */
let cur: ReachParams = parse();

/** The rows of `publication p JOIN publication_author pa JOIN scholar s` that
 *  pass the scope: one per matching authorship. */
function joinRows(p: ReachParams): { pmid: string; cwid: string }[] {
  return pubs
    .filter((pub) => (p.from === null || pub.year >= p.from) && (p.to === null || pub.year <= p.to))
    .filter((pub) => !p.pmid || pub.pmid === p.pmid)
    .flatMap((pub) =>
      pub.authors
        .filter((a) => a.confirmed !== false && a.active !== false)
        .filter((a) => p.people.length === 0 || p.people.includes(a.cwid))
        .map((a) => ({ pmid: pub.pmid, cwid: a.cwid })),
    );
}
/** The scope total as it was first defined: `COUNT(DISTINCT p.pmid)` over the join. */
const distinctPapers = (p: ReachParams) => new Set(joinRows(p).map((r) => r.pmid)).size;
const inScope = (p: ReachParams) => {
  const pmids = new Set(joinRows(p).map((r) => r.pmid));
  return pubs.filter((pub) => pmids.has(pub.pmid));
};
const citedInScope = (p: ReachParams) => inScope(p).filter((pub) => pub.cited);
/** The Citing documents listing: the one clinical study, citing every cited paper in scope. */
const docGroups = (p: ReachParams) => {
  const papers = citedInScope(p).length;
  return papers > 0 ? [{ level: "clinical", unit: "1", papers, rep: "020220000000001" }] : [];
};

const GROUPED = "SELECT g.level, g.unit, g.papers, g.rep";

/** What the database would return for one `$queryRaw`, under `cur`. */
function answer(text: string, values: unknown[]): unknown[] {
  const p = cur;
  if (text.includes("d.external_id, d.journal")) {
    return values.includes(1)
      ? [{ id: 1, title: "A trial of an example", url: "https://example.org/doc/1", level: "clinical", external_id: "x1", journal: "Journal of Examples", journal_abbrev: null, issuing_body: null }]
      : [];
  }
  if (text.includes("AS reviews")) return [];
  if (text.includes("SELECT p.pmid, p.title, p.journal, p.doi, s.cwid")) return [];
  if (text.includes("HAVING COUNT(*) >=")) return [];
  if (text.includes("SELECT COUNT(*) AS n FROM (")) return [{ n: docGroups(p).length }];
  if (text.includes(GROUPED)) {
    const [limit, offset] = values.slice(-2).map(Number);
    const groups = docGroups(p);
    return groups.slice(offset, offset + limit).map((g) => ({ ...g, total: groups.length }));
  }
  if (text.includes("COUNT(DISTINCT p.pmid) AS n")) return [{ n: distinctPapers(p) }];
  if (text.includes("MAX(p.translational_stage) AS stage")) {
    return citedInScope(p).map((pub) => ({ pmid: pub.pmid, year: pub.year, stage: "T0", confidence: "high", n_clinical: 1, n_trial: 0, n_policy: 0, n_patent: 0 }));
  }
  throw new Error(`unmodelled query: ${text.slice(0, 160)}`);
}

const flat = (sql: Prisma.Sql) => ({ text: sql.sql.replace(/\s+/g, " ").trim(), values: sql.values });
/** Every `$queryRaw` call so far: one-spaced text plus bound values. */
const calls = () =>
  h.queryRaw.mock.calls.map((c) => {
    const [strings, ...values] = c as [TemplateStringsArray, ...unknown[]];
    return flat(Prisma.sql(strings, ...values));
  });
/** The queries that read the link table to group it into citing documents. */
const groupedCalls = () => calls().filter((c) => c.text.includes("publication_citing_document") && c.text.includes("GROUP BY d.level, unit"));

async function open(qs: string, views?: readonly ReachView[]) {
  const p = await resolveReachParams(parse(qs), SUPER);
  cur = p;
  return { p, data: await loadReach(p, { views: views ?? [p.view], limit: 50 }) };
}

async function page(query: Record<string, string | string[]>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) sp.append(k, x);
  cur = { ...parse(sp.toString()), scope: null, docRefs: [] };
  const props = { n: "27", session: SUPER, searchParams: query, basePath: BASE };
  const out = await renderDownstreamReachReport(props as unknown as AdminReportProps);
  return render(
    createElement(Fragment, null, createElement("div", { "data-testid": "aside" }, out.aside), out.main),
  );
}

async function download(qs: string) {
  h.session.mockResolvedValue(SUPER);
  cur = await resolveReachParams({ ...parse(qs), showAll: false }, SUPER);
  const res = await GET(new Request(`https://scholars.example/api/edit/reports/downstream-reach?${qs}`));
  expect(res.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}
const criteriaOf = (wb: ExcelJS.Workbook) =>
  new Map((wb.getWorksheet("Criteria")!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => [String(r[1]), String(r[2])]));

beforeEach(() => {
  pubs = SMALL;
  cur = parse();
  h.queryRaw.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = flat(Prisma.sql(strings, ...values));
    return answer(sql.text, sql.values);
  });
  h.session.mockReset();
  vi.stubEnv("DOWNSTREAM_REACH_REPORT", "on");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("the scope total", () => {
  it("is the number of distinct publications in scope: a paper with two matching authors counts once", async () => {
    for (const qs of ["", "stage=any&basis=cy", "person=bbb1002&stage=any&basis=cy", "pmid=102"]) {
      cur = { ...parse(qs), scope: null };
      const n = await loadScopeTotal(cur);
      expect(n, qs).toBe(distinctPapers(cur));
      expect(n, qs).toBe(inScope(cur).length);
    }
    // 101, 102 and 103 since 2020; 106 too with no year filter. 102's two authorships are one paper.
    cur = { ...parse(), scope: null };
    expect(joinRows(cur)).toHaveLength(4);
    expect(await loadScopeTotal(cur)).toBe(3);
    cur = { ...parse("stage=any&basis=cy"), scope: null };
    expect(await loadScopeTotal(cur)).toBe(4);
  });

  it("is driven from publication: STRAIGHT_JOIN, FROM publication, the authorships joined and never a subquery", async () => {
    const p = { ...parse(), scope: null };
    cur = p;
    await loadScopeTotal(p);
    const [{ text }] = calls();
    expect(text).toMatch(
      /^SELECT STRAIGHT_JOIN COUNT\(DISTINCT p\.pmid\) AS n FROM publication p JOIN publication_author pa ON pa\.pmid = p\.pmid JOIN scholar s ON s\.cwid = pa\.cwid WHERE /,
    );
    // The authorship test is the join: no EXISTS or IN (subquery) on the authorships.
    expect(text.match(/publication_author/g)).toHaveLength(1);
    expect(text).not.toMatch(/EXISTS/);
  });

  it("is the first definition's query with the join order pinned, and nothing else changed", async () => {
    for (const qs of ["", "stage=any&basis=cy", "person=bbb1002&pos=first&from=2019&to=2023", "area=area_a&pmid=102&own=in"]) {
      const p = { ...parse(qs), scope: null };
      cur = p;
      h.queryRaw.mockClear();
      await loadScopeTotal(p);
      const [now] = calls();
      const before = flat(Prisma.sql`
        SELECT COUNT(DISTINCT p.pmid) AS n
          FROM publication p
          JOIN publication_author pa ON pa.pmid = p.pmid
          JOIN scholar s ON s.cwid = pa.cwid
         WHERE ${policyScopeSql(p)}
           ${reachPubSql(p)}`);
      expect(now.text.replace("SELECT STRAIGHT_JOIN ", "SELECT "), qs).toBe(before.text);
      expect(now.values, qs).toEqual(before.values);
    }
  });

  it("the first tile's M is that total, through the loader", async () => {
    const { data } = await open("");
    expect([data.pubTotal, data.scopeTotal]).toEqual([2, 3]);
  });
});

describe("the Citing documents ceiling", () => {
  it("is 20,000 cited papers: at it the view is listed, one over it is not", () => {
    expect(REACH_DOCS_PAPER_CEILING).toBe(20_000);
    expect([docsTooWide(0), docsTooWide(20_000), docsTooWide(20_001)]).toEqual([false, false, true]);
    // The ceiling is on cited papers, and is not the download's row cap.
    expect(REACH_DOCS_CAP).toBe(20_000);
  });

  it("above it: the grouped query is not run, there is no list and no count, and the cited papers are reported", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    const { data } = await open("view=documents");
    expect(groupedCalls()).toHaveLength(0);
    expect(calls().some((c) => c.text.includes("publication_citing_document"))).toBe(false);
    expect(data.pubTotal).toBe(20_001);
    expect(data.docsWithheld).toBe(20_001);
    expect(data.docTotal).toBeNull();
    expect(data.docs).toEqual([]);
    // The check cost nothing: the counts and the scope total, as on any tab.
    expect(calls()).toHaveLength(2);
  });

  it("at it: the grouped query runs once and the view is whole", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING);
    const { data } = await open("view=documents");
    expect(groupedCalls()).toHaveLength(1);
    expect(data.docsWithheld).toBeNull();
    expect(data.docTotal).toBe(1);
    expect(data.docs).toEqual([{ docId: 1, level: "clinical", type: "clinical", year: 2022, application: false, papers: 20_000 }]);
  });

  it("well below it nothing changes: the listing, its total and its paging", async () => {
    const { p, data } = await open("view=documents");
    expect(groupedCalls()).toHaveLength(1);
    expect(groupedCalls()[0].values.slice(-2)).toEqual([50, 0]);
    expect([data.docsWithheld, data.docTotal, data.docs.map((d) => d.papers)]).toEqual([null, 1, [2]]);
    // A page past the end still asks for the total on its own.
    h.queryRaw.mockClear();
    const past = await loadReach(p, { views: ["documents"], limit: 50, offset: 50 });
    expect([past.docTotal, past.docs, past.docsWithheld]).toEqual([1, [], null]);
    expect(calls().filter((c) => c.text.includes("SELECT COUNT(*) AS n FROM (")).length).toBe(1);
  });

  it("a view that was not asked for is neither loaded nor withheld, however wide", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    for (const view of ["publications", "people"] as const) {
      h.queryRaw.mockClear();
      const { data } = await open(`view=${view}`);
      expect([data.docTotal, data.docsWithheld], view).toEqual([null, null]);
      expect(groupedCalls()).toHaveLength(0);
    }
  });

  it("a view filtered to one paper works where the unfiltered selection is over the ceiling", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    const unfiltered = await open("view=documents");
    expect(unfiltered.data.docsWithheld).toBe(20_001);
    // The link a Publications cell carries (`reachLinks.paperDocs`).
    h.queryRaw.mockClear();
    const { p, data } = await open(reachLinks(unfiltered.p).paperDocs("1000007", "clinical"));
    expect([p.view, p.pmid, p.ctypes]).toEqual(["documents", "1000007", ["clinical"]]);
    expect(groupedCalls()).toHaveLength(1);
    expect(groupedCalls()[0].values).toContain("1000007");
    expect([data.pubTotal, data.docsWithheld, data.docTotal]).toEqual([1, null, 1]);
    expect(data.docs.map((d) => [d.docId, d.papers])).toEqual([[1, 1]]);
  });

  it("a view filtered to one person works too, when that person's papers are few", async () => {
    pubs = [...wide(REACH_DOCS_PAPER_CEILING + 1), { pmid: "201", year: 2022, authors: [{ cwid: "bbb1002" }], cited: true }];
    expect((await open("view=documents")).data.docsWithheld).toBe(20_002);
    h.queryRaw.mockClear();
    const { data } = await open("view=documents&person=bbb1002");
    expect(groupedCalls()).toHaveLength(1);
    expect([data.docsWithheld, data.docTotal, data.docs.map((d) => d.papers)]).toEqual([null, 1, [1]]);
  });

  it("with own work counted the ceiling is the same test on the same number", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    const { data } = await open("view=documents&own=in");
    expect(data.docsWithheld).toBe(20_001);
    // The live counts read the links per paper; the grouping into documents is not run.
    expect(groupedCalls()).toHaveLength(0);
  });
});

describe("the Citing documents tab above the ceiling", () => {
  it("shows the message, no count of citing documents, no table and no pager", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    const view = await page({ view: "documents" });
    expect(groupedCalls()).toHaveLength(0);
    const note = view.getByTestId("downstream-reach-docs-too-wide");
    expect(note.textContent).toBe(
      "This selection is too wide to list citing documents. It covers 20,001 cited papers, and citing documents are listed for at most 20,000. Narrow it by unit, years, stage, research area or person.",
    );
    // The one count in it opens the list of exactly those papers.
    const link = within(note).getByRole("link", { name: "20,001 publications cited downstream in this selection" });
    expect(link.textContent).toBe("20,001");
    expect(link.getAttribute("href")).toBe(`${BASE}?${reachLinks({ ...parse("view=documents"), scope: null }).cited()}`);
    expect(new URLSearchParams(link.getAttribute("href")!.split("?")[1]).get("view")).toBeNull();
    // No number without its list: the tab carries no count.
    expect(view.getByTestId("downstream-reach-view-documents").textContent).toBe("Citing documents");
    expect(view.getByTestId("downstream-reach-view-publications").textContent).toBe("Publications (20,001)");
    expect(view.queryByTestId("downstream-reach-documents")).toBeNull();
    expect(view.queryByTestId("downstream-reach-doc-row")).toBeNull();
    expect(view.queryByTestId("downstream-reach-pager")).toBeNull();
    expect(view.queryByTestId("downstream-reach-toolbar")).toBeNull();
    expect(view.queryByText(/No citing documents match/)).toBeNull();
    expect(view.getByTestId("aside").textContent).toContain("Citing documents is not listed for a selection this wide");
  });

  it("the export note says so on the other tabs too, from the count they already have", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    const view = await page({ view: "people" });
    expect(view.queryByTestId("downstream-reach-docs-too-wide")).toBeNull();
    expect(view.getByTestId("downstream-reach-view-documents").textContent).toBe("Citing documents");
    expect(view.getByTestId("aside").textContent).toContain("Citing documents is not listed for a selection this wide");
  });

  it("at or below the ceiling the tab is as before: the count, the table and its rows", async () => {
    const view = await page({ view: "documents" });
    expect(groupedCalls()).toHaveLength(1);
    expect(view.queryByTestId("downstream-reach-docs-too-wide")).toBeNull();
    expect(view.getByTestId("downstream-reach-view-documents").textContent).toBe("Citing documents (1)");
    const row = within(view.getByTestId("downstream-reach-doc-row"));
    expect(row.getByRole("link", { name: "2 papers cited by this document" }).textContent).toBe("2");
    expect(view.getByTestId("downstream-reach-toolbar")).toBeTruthy();
    expect(view.getByTestId("aside").textContent).not.toContain("not listed");
  });
});

describe("the download above the ceiling", () => {
  it("the Citing documents sheet carries one note and no rows, the Criteria sheet says so, and the grouped query is not run", async () => {
    pubs = wide(REACH_DOCS_PAPER_CEILING + 1);
    const wb = await download("view=documents");
    expect(groupedCalls()).toHaveLength(0);
    const note = docsWithheldNote(20_001);
    expect(note).toBe(
      "Not listed: this selection is too wide to list citing documents. It covers 20,001 cited publications (the Publications sheet), and citing documents are listed for at most 20,000. Narrow it by unit, years, stage, research area or person.",
    );
    const docs = wb.getWorksheet("Citing documents")!;
    expect(docs.rowCount).toBe(2);
    expect(docs.getRow(1).getCell(1).value).toBe("Citing document");
    expect(docs.getRow(2).getCell(1).value).toBe(note);
    expect(docs.getRow(2).actualCellCount).toBe(1);
    expect(criteriaOf(wb).get("Citing documents sheet")).toBe(note);
    // The other sheets are untouched: the Publications sheet is cut at its own cap.
    expect(wb.getWorksheet("Publications")!.rowCount - 1).toBe(REACH_LIST_CAP);
    expect(criteriaOf(wb).get("Publications sheet")).toMatch(/^Lists the first 5,000 of 20,001 publications/);
  });

  it("at or below the ceiling the sheet lists the citing documents, as before", async () => {
    const wb = await download("view=documents");
    expect(groupedCalls()).toHaveLength(1);
    expect(groupedCalls()[0].values.slice(-2)).toEqual([REACH_DOCS_CAP, 0]);
    const docs = wb.getWorksheet("Citing documents")!;
    expect(docs.rowCount).toBe(2);
    expect((docs.getRow(2).values as unknown[]).slice(1)).toEqual(["A trial of an example", "Clinical study", "Journal of Examples", 2022, 2, "https://example.org/doc/1"]);
    expect(criteriaOf(wb).get("Citing documents sheet")).toMatch(/^One row per citing document of the types above\. Lists all 1 citing documents/);
  });

  it("the workbook, built directly: a note in place of the rows it was given none of", async () => {
    const p = { ...parse(), scope: null };
    const wb = new ExcelJS.Workbook();
    const buffer = await buildReachWorkbook(p, { pubs: [], pubTotal: 30_000, docs: [], docTotal: 0, docsWithheld: 30_000, people: [] }, new Date("2026-01-01T00:00:00Z"));
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Publications", "Citing documents", "People", "Criteria"]);
    expect(wb.getWorksheet("Citing documents")!.getRow(2).getCell(1).value).toBe(docsWithheldNote(30_000));
    expect(criteriaOf(wb).get("Citing documents sheet")).not.toMatch(/Lists (all|the first)/);
  });
});
