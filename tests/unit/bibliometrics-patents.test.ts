/**
 * Patents citing one scholar's work, on the Bibliometrics tab: the count of
 * citing inventions the tab load adds, the Excel download (which papers it
 * covers, its sheets, its route's flag and access rule) and the link to report
 * 25. Every query must stay inside the scholar's visible PMIDs: access here is
 * the CV-export rule on one scholar, with no unit scope behind it. All people,
 * papers, patents and assignees are invented.
 */
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  identity: vi.fn(),
  authz: vi.fn(),
  denial: vi.fn(),
  scholar: vi.fn(),
  authorships: vi.fn(),
  queryRaw: vi.fn(),
  suppressions: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: h.scholar },
      publicationAuthor: { findMany: h.authorships },
      $queryRaw: h.queryRaw,
    },
    write: {},
  },
}));
vi.mock("@/lib/edit/request", async () => {
  const { NextResponse } = await import("next/server");
  return {
    resolveEditIdentity: h.identity,
    editOk: (payload: Record<string, unknown>) => NextResponse.json({ ok: true, ...payload }),
    editError: (status: number, error: string) => NextResponse.json({ ok: false, error }, { status }),
    logEditFailure: vi.fn(),
  };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeCvExport: h.authz }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: h.denial }));
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: h.suppressions,
  isAuthorHidden: (s: { hidden: Set<string> }, pmid: string) => s.hidden.has(pmid),
}));
vi.mock("@/lib/api/publication-detail", () => ({ readPolicyCitations: vi.fn(async () => null) }));
vi.mock("@/lib/edit/report-meta", () => ({ reportMetaFor: vi.fn(async () => ({ slug: "patent-citations" })) }));

import { GET } from "@/app/api/edit/bibliometrics/patents/route";
import { OWN_PATENTS_NOTE } from "@/lib/edit/bibliometrics";
import { loadBibliometricsReport } from "@/lib/edit/bibliometrics-loader";
import {
  buildScholarPatentWorkbook,
  loadScholarPatentCitations,
  patentReportHref,
} from "@/lib/edit/bibliometrics-patents";
import { Prisma } from "@/lib/generated/prisma/client";

const CWID = "zzz9001";
/** Rollup counts: two visible cited papers, three cited papers the tab does
 *  not show, one visible paper no patent cites. */
const PAPERS = [
  { pmid: "90000101", publicationType: "Academic Article", patentFamilyCount: 2, year: 2012, isLast: true },
  { pmid: "90000102", publicationType: "Review", patentFamilyCount: 1, year: 2015 },
  { pmid: "90000103", publicationType: "Academic Article", patentFamilyCount: 3 }, // the scholar hid it
  { pmid: "90000104", publicationType: "Academic Article", patentFamilyCount: 1 }, // taken down whole
  { pmid: "90000105", publicationType: "Erratum", patentFamilyCount: 1 }, // never displayed
  { pmid: "90000106", publicationType: "Academic Article", patentFamilyCount: 0 },
];
const VISIBLE_CITED = ["90000101", "90000102"];
const NOT_SHOWN = ["90000103", "90000104", "90000105"];

const authorship = (p: (typeof PAPERS)[number]) => ({
  position: 3,
  isFirst: false,
  isLast: p.isLast ?? false,
  publication: {
    pmid: p.pmid,
    title: `Invented <i>paper</i> ${p.pmid}`,
    authorsString: "Quill A, Marsh T, Vale J",
    journal: "Journal of Examples",
    year: p.year ?? 2010,
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    publicationType: p.publicationType,
    citationCount: 5,
    citedByCount: 5,
    nihPercentile: null,
    relativeCitationRatio: null,
    dateAddedToEntrez: null,
    authorityBodies: null,
    authorityCount: 0,
    guidelineCount: 0,
    consensusCount: 0,
    reviewCount: 0,
    patentFamilyCount: p.patentFamilyCount,
  },
});

/** `rep`, as report 25's `REP_SQL` builds it: application flag, year, document id. */
const rep = (application: boolean, year: number, id: number) =>
  `${application ? 1 : 0}${year}${String(id).padStart(10, "0")}`;
const docRow = (id: number, external_id: string, details: object) => ({
  id,
  title: `Example composition ${id}`,
  url: `https://patents.example.org/${external_id}`,
  external_id,
  details: JSON.stringify(details),
});

/** Every `$queryRaw` call so far: one-spaced text plus bound values. */
const calls = () =>
  h.queryRaw.mock.calls.map((c) => {
    const [strings, ...values] = c as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...values);
    return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
  });
const linkQueries = () => calls().filter((c) => c.text.includes("publication_citing_document"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EDIT_BIBLIOMETRICS", "on");
  h.identity.mockResolvedValue({ session: { cwid: CWID, isSuperuser: false }, realCwid: CWID, impersonatedCwid: null });
  h.authz.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  h.scholar.mockResolvedValue({ cwid: CWID, preferredName: "Jordan Vale", hIndex: 9 });
  h.authorships.mockImplementation(async (args: { where: { cwid?: string } }) =>
    args.where.cwid ? PAPERS.map(authorship) : [],
  );
  h.suppressions.mockResolvedValue({ hidden: new Set(["90000103"]), darkPmids: new Set(["90000104"]) });
  h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    if (text.includes("GROUP BY ok.pmid, d.dedup_key")) {
      return [
        // One family of three documents cites both papers; an application cites the first alone.
        { pmid: "90000101", dedup_key: "15000001", docs: 3n, rep: rep(false, 2019, 2), latest: 2023, front: 1n, body: 1n },
        { pmid: "90000101", dedup_key: "17000002", docs: 1n, rep: rep(true, 2022, 1), latest: 2022, front: 0n, body: 1n },
        { pmid: "90000102", dedup_key: "15000001", docs: 1n, rep: rep(false, 2019, 2), latest: 2019, front: 1n, body: 0n },
      ];
    }
    if (text.includes("GROUP BY d.dedup_key")) {
      return [
        { dedup_key: "15000001", papers: 2n, docs: 3n, rep: rep(false, 2019, 2) },
        { dedup_key: "17000002", papers: 1n, docs: 1n, rep: rep(true, 2022, 1) },
      ];
    }
    if (text.includes("WHERE d.id IN")) {
      return [
        docRow(1, "us-2022000001-a1", { kind: "application", assignees: [], inventors: [{ first: "Ada", last: "Sample" }] }),
        docRow(2, "us-90000002-b2", { kind: "grant", assignees: ["Example Biotech, Inc."], inventors: [{ first: "Ben", last: "Fixture" }] }),
      ];
    }
    if (text.includes("AS n FROM")) return [{ n: 2n }];
    return [];
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("the tab load", () => {
  it("adds one count of citing inventions, over the scholar's visible cited papers only", async () => {
    const report = await loadBibliometricsReport(CWID, { authorship: "all", yearFrom: null, yearTo: null });
    expect(report!.patents).toEqual({
      papers: 2,
      inventions: 2,
      dataEnd: "31 December 2025", // nothing stored: the fallback
      reportHref: null,
    });
    const patentQueries = calls().filter((c) => c.text.includes("'patent'"));
    expect(patentQueries).toHaveLength(1);
    expect(patentQueries[0]!.text).toContain("WHERE l.pmid IN (?,?) AND d.level = 'patent'");
    expect(patentQueries[0]!.values).toEqual(VISIBLE_CITED);
    expect(report!.papers.rows.find((p) => p.pmid === "90000101")!.patents).toBe(2);
  });

  it("asks nothing about patents when no visible paper is cited in one", async () => {
    h.authorships.mockImplementation(async (args: { where: { cwid?: string } }) =>
      args.where.cwid ? PAPERS.slice(2).map(authorship) : [],
    );
    const report = await loadBibliometricsReport(CWID, { authorship: "all", yearFrom: null, yearTo: null });
    expect(report!.patents).toMatchObject({ papers: 0, inventions: 0, dataEnd: null });
    expect(calls().filter((c) => c.text.includes("'patent'"))).toHaveLength(0);
  });
});

describe("loadScholarPatentCitations", () => {
  it("restricts every read of the citation links to the scholar's visible cited PMIDs", async () => {
    await loadScholarPatentCitations(CWID);
    const queries = linkQueries();
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      // No unit scope stands behind these queries: the PMID list is the only restriction.
      expect(q.text).toContain("FROM (SELECT p.pmid FROM publication p WHERE p.pmid IN (?,?)) ok");
      expect(q.text).toContain("ON l.pmid = ok.pmid");
      expect(q.values).toEqual(VISIBLE_CITED);
    }
    // Papers the tab does not show never reach a query, of any kind.
    const bound = calls().flatMap((c) => c.values);
    for (const pmid of NOT_SHOWN) expect(bound).not.toContain(pmid);
  });

  it("reads no citation link for a scholar with no visible cited paper", async () => {
    h.authorships.mockImplementation(async (args: { where: { cwid?: string } }) =>
      args.where.cwid ? PAPERS.slice(2).map(authorship) : [],
    );
    const data = await loadScholarPatentCitations(CWID);
    expect(data).toMatchObject({ pubs: [], inventions: [] });
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("lists every publication type, each paper's inventions in full, and each invention once", async () => {
    const data = (await loadScholarPatentCitations(CWID))!;
    expect(data.scholar).toEqual({ cwid: CWID, name: "Jordan Vale" });
    // The review is covered too; most citing inventions first.
    expect(data.pubs.map((p) => [p.pmid, p.inventions, p.latest, p.position])).toEqual([
      ["90000101", 2, 2023, "Senior"],
      ["90000102", 1, 2019, "Co-author"],
    ]);
    expect(data.pubs[0]!.citing.map((d) => d.key)).toEqual(["17000002", "15000001"]);
    expect(data.inventions.map((r) => [r.key, r.papers, r.docs, r.number])).toEqual([
      ["15000001", 2, 3, "US90000002B2"],
      ["17000002", 1, 1, "US20220000001A1"],
    ]);
  });

  it("is null for a cwid with no scholar", async () => {
    h.scholar.mockResolvedValue(null);
    expect(await loadScholarPatentCitations("nobody1")).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe("buildScholarPatentWorkbook", () => {
  const open = async () => {
    const buffer = await buildScholarPatentWorkbook(
      (await loadScholarPatentCitations(CWID))!,
      new Date("2026-11-26T15:00:00Z"),
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  };
  const rows = (ws: ExcelJS.Worksheet) => {
    const out: unknown[][] = [];
    ws.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
    return out;
  };

  it("has the four sheets, with one Citations row per paper and invention", async () => {
    const wb = await open();
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Citations", "Publications", "Inventions", "Criteria"]);
    const [header, ...pairs] = rows(wb.getWorksheet("Citations")!);
    expect(header).toEqual([
      "PMID",
      "Paper title",
      "Journal",
      "Year",
      "Author position",
      "Patent",
      "Patent title",
      "Assignees",
      "First inventor",
      "Granted or published",
      "Patent year",
      "Where cited",
      "Related patents",
      "Link",
    ]);
    expect(pairs).toHaveLength(3);
    // The paper's title as plain text; the family by its earliest granted patent.
    expect(pairs[1]).toEqual([
      "90000101",
      "Invented paper 90000101",
      "Journal of Examples",
      2012,
      "Senior",
      "US90000002B2",
      "Example composition 2",
      "Example Biotech, Inc.",
      "Ben Fixture",
      "Granted",
      2019,
      "cited in the text and on the front page",
      2,
      "https://patents.example.org/us-90000002-b2",
    ]);
    expect(pairs[0]!.slice(5, 10)).toEqual(["US20220000001A1", "Example composition 1", "", "Ada Sample", "Application published"]);
    expect(pairs[2]!.slice(0, 1)).toEqual(["90000102"]);
  });

  it("counts inventions per paper and papers per invention", async () => {
    const wb = await open();
    expect(rows(wb.getWorksheet("Publications")!)).toEqual([
      ["PMID", "Title", "Journal", "Year", "Author position", "Citing inventions", "Latest citing patent year"],
      ["90000101", "Invented paper 90000101", "Journal of Examples", 2012, "Senior", 2, 2023],
      ["90000102", "Invented paper 90000102", "Journal of Examples", 2015, "Co-author", 1, 2019],
    ]);
    const inventions = rows(wb.getWorksheet("Inventions")!);
    expect(inventions[0]![7]).toBe("Papers cited");
    expect(inventions.slice(1).map((r) => [r[0], r[6], r[7]])).toEqual([
      ["US90000002B2", 2, 2],
      ["US20220000001A1", 0, 1],
    ]);
  });

  it("names the scholar, the cut-off and the limit of the data, and no other person", async () => {
    const wb = await open();
    const criteria = new Map(rows(wb.getWorksheet("Criteria")!).map((r) => [r[0], r[1]] as [string, string]));
    expect(criteria.get("Scholar")).toBe("Jordan Vale");
    expect(criteria.get("Generated")).toBe("2026-11-26T15:00:00.000Z");
    expect(criteria.get("Reading the numbers")).toContain("The patent data ends at 31 December 2025.");
    expect(criteria.get("Sources")).toContain("Reliance on Science");
    expect(criteria.get("The scholar's own patents")).toBe(OWN_PATENTS_NOTE);
    // The paper's other authors are in the fixture; none of them is in the file.
    const everything = JSON.stringify(wb.worksheets.flatMap(rows));
    expect(everything).not.toContain("Quill");
    expect(everything).not.toContain("@");
  });
});

describe("GET /api/edit/bibliometrics/patents", () => {
  const get = (qs = "") => GET(new NextRequest(`http://localhost/api/edit/bibliometrics/patents?${qs}`));

  it("404s before any session or database work unless the flag is exactly on", async () => {
    for (const value of ["off", "true", ""]) {
      vi.stubEnv("EDIT_BIBLIOMETRICS", value);
      expect((await get()).status).toBe(404);
    }
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.scholar).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    h.identity.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(h.scholar).not.toHaveBeenCalled();
  });

  it("refuses a target the CV-export rule refuses, logs it and reads nothing", async () => {
    h.authz.mockResolvedValue({ ok: false, reason: "not_self" });
    const res = await get("cwid=zzz9002");
    expect(res.status).toBe(403);
    expect(h.authz.mock.calls[0]![0]).toMatchObject({ entityId: "zzz9002", realCwid: CWID });
    expect(h.denial).toHaveBeenCalledWith(
      expect.objectContaining({ targetCwid: "zzz9002", path: "/api/edit/bibliometrics/patents" }),
    );
    expect(h.scholar).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("gives the scholar their own workbook", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(h.authz.mock.calls[0]![0]).toMatchObject({ entityId: CWID });
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="patents-citing-zzz9001.xlsx"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.getWorksheet("Citations")!.rowCount).toBe(4);
  });

  it("gives an authorized viewer another scholar's workbook, read for that scholar", async () => {
    const res = await get("cwid=zzz9002");
    expect(res.status).toBe(200);
    expect(h.scholar.mock.calls[0]![0]).toMatchObject({ where: { cwid: "zzz9002" } });
  });

  it("404s for a cwid with no scholar", async () => {
    h.scholar.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});

describe("patentReportHref", () => {
  const SUPER = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false };

  it("is report 25 filtered to the scholar, for a viewer who may open it", async () => {
    vi.stubEnv("PATENT_CITATIONS_REPORT", "on");
    expect(await patentReportHref(SUPER, CWID)).toBe("/edit/reports/patent-citations?person=zzz9001&basis=cy");
  });

  it("is null while report 25 is off", async () => {
    vi.stubEnv("PATENT_CITATIONS_REPORT", "off");
    expect(await patentReportHref(SUPER, CWID)).toBeNull();
  });
});
