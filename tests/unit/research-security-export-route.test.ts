/**
 * GET /edit/research-security/export — the gate, in order, and the response
 * headers. The dashboard is sensitive: nothing may be loaded for a caller who
 * fails the gate, and the log line may carry counts only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  enabled: vi.fn(),
  canView: vi.fn(),
  loadFacts: vi.fn(),
  loadStrings: vi.fn(),
  loadCategories: vi.fn(),
  realSession: vi.fn(),
}));

vi.mock("@/lib/auth/session-server", () => ({ getSession: h.realSession }));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/dashboard-access", () => ({ canViewDashboard: h.canView }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/edit/research-security-dashboard", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/research-security-dashboard")>()),
  isResearchSecurityDashboardEnabled: h.enabled,
}));
vi.mock("@/lib/api/research-security-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/research-security-report")>()),
  loadResearchSecurityFacts: h.loadFacts,
  loadMatchedStrings: h.loadStrings,
  loadCategories: h.loadCategories,
}));

import ExcelJS from "exceljs";

import { GET } from "@/app/edit/research-security/export/route";
import {
  buildEntityRows,
  buildFundingRows,
  buildPaperRows,
  buildPersonRows,
  buildUnattributedRows,
  type ResearchSecurityFacts,
} from "@/lib/api/research-security-report";

const SECRET_NAME = "Liqun Tan";
const ARTICLE = (articleId: string) => ({
  articleId,
  pmid: Number(articleId),
  title: "A paper",
  journal: "J",
  publicationDate: new Date("2024-01-01T00:00:00Z"),
  publicationType: "Academic Article",
  totalAuthors: 5,
  doi: null,
  source: "pubmed",
});
const FACTS = {
  articles: new Map([
    ["1", ARTICLE("1")],
    ["2", ARTICLE("2")],
  ]),
  people: [
    {
      articleId: "1",
      cwid: "lqt9002",
      displayName: SECRET_NAME,
      firstName: "Liqun",
      lastName: "Tan",
      campus: "wcm",
      department: "Medicine",
      title: null,
      attribution: "confirmed",
      inReviewQueue: false,
      reciterScore: null,
    },
    {
      articleId: "2",
      cwid: "abc2001",
      displayName: "Ann Chen",
      firstName: "Ann",
      lastName: "Chen",
      campus: "ithaca",
      department: "ECE",
      title: null,
      attribution: "pending",
      inReviewQueue: true,
      reciterScore: 40,
    },
  ],
  matches: [
    {
      articleId: "1",
      listCode: "house-1286-nominations",
      category: "SASTIND university",
      listNo: 1,
      entity: "Soochow University",
      authorRank: 2,
      authorName: "Co Author",
      isInstitutionAuthor: false,
      ourAuthorCwids: null,
    },
    {
      articleId: "2",
      listCode: "house-1286-nominations",
      category: "SASTIND university",
      listNo: 2,
      entity: "Harbin Institute of Technology",
      authorRank: 1,
      authorName: "Other Author",
      isInstitutionAuthor: false,
      ourAuthorCwids: null,
    },
  ],
  flags: [{ articleId: "1", program: "Qiming Plan", agency: null, grantId: null }],
  dataAsOf: new Date("2026-11-17T08:00:00Z"),
};

const get = (qs = "") => GET(new Request(`https://scholars.test/edit/research-security/export${qs}`));

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  h.enabled.mockReturnValue(true);
  h.session.mockResolvedValue({ cwid: "viewer1", isSuperuser: false, isCommsSteward: false });
  h.canView.mockResolvedValue(true);
  h.loadFacts.mockResolvedValue(FACTS);
  h.loadStrings.mockResolvedValue([]);
  h.loadCategories.mockResolvedValue(["SASTIND university"]);
  h.realSession.mockResolvedValue({ cwid: "viewer1" });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("gate", () => {
  it("flag off → 404 before the session is even read", async () => {
    h.enabled.mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(h.session).not.toHaveBeenCalled();
    expect(h.loadFacts).not.toHaveBeenCalled();
  });

  it("no session → 401, nothing loaded", async () => {
    h.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(h.loadFacts).not.toHaveBeenCalled();
  });

  it("signed in without the role → 404, nothing loaded", async () => {
    h.canView.mockResolvedValue(false);
    const res = await get("?view=person");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(h.loadFacts).not.toHaveBeenCalled();
    expect(h.loadStrings).not.toHaveBeenCalled();
  });

  it("asks the shared gate about this dashboard", async () => {
    await get();
    expect(h.canView).toHaveBeenCalledWith(expect.objectContaining({ cwid: "viewer1" }), "research-security");
  });
});

describe("allowed", () => {
  it.each(["entity", "person", "paper", "funding", "unattributed"])("view=%s is an xlsx attachment, never cached", async (view) => {
    const res = await get(`?view=${view}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("Content-Disposition")).toMatch(
      new RegExp(`^attachment; filename="research-security-${view}-\\d{4}-\\d{2}-\\d{2}\\.xlsx"$`),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // A zip (xlsx) starts "PK".
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
  });

  it("passes the page's filters to the loader", async () => {
    await get("?view=person&campus=ithaca&list=country-of-concern&from=2023-01-01&consortia=exclude");
    expect(h.loadFacts.mock.calls[0][1]).toEqual({
      campus: "ithaca",
      list: "country-of-concern",
      category: undefined,
      dateFrom: "2023-01-01",
      dateTo: undefined,
      excludeConsortia: true,
    });
  });

  it("drops a category the selected list does not have, before loading, as the page does", async () => {
    // The form submits the old category when only the list is changed.
    h.loadCategories.mockResolvedValue(["Country"]);
    await get("?list=country-of-concern&category=CAS%20institute");
    expect(h.loadCategories.mock.calls[0][1]).toMatchObject({ list: "country-of-concern" });
    expect(h.loadFacts.mock.calls[0][1]).toMatchObject({ list: "country-of-concern", category: undefined });
    await get("?list=country-of-concern&category=Country");
    expect(h.loadFacts.mock.calls[1][1]).toMatchObject({ category: "Country" });
  });

  // The workbook is the page's view, every row of it: the data rows of the
  // first sheet are exactly what the page builds (and pages through) for the
  // same filters, which is also what the page's tab count is taken from.
  it.each([
    ["entity", (f: ResearchSecurityFacts) => buildEntityRows(f, "both").length, 2],
    ["person", (f: ResearchSecurityFacts) => buildPersonRows(f, "both").length, 1],
    ["paper", (f: ResearchSecurityFacts) => buildPaperRows(f, "both").length, 1],
    ["funding", (f: ResearchSecurityFacts) => buildFundingRows(f, "both").length, 1],
    ["unattributed", (f: ResearchSecurityFacts) => buildUnattributedRows(f, "both").length, 1],
  ] as const)("view=%s: the workbook has one row per on-screen row", async (view, onScreen, expected) => {
    const res = await get(`?view=${view}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const dataRows = wb.worksheets[0].actualRowCount - 1; // minus the header
    expect(onScreen(FACTS)).toBe(expected);
    expect(dataRows).toBe(expected);
    const logged = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(logged.rows).toBe(expected);
  });

  it("the campus filter reaches the workbook: Ithaca has no confirmed paper here", async () => {
    const res = await get("?view=paper&campus=ithaca");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets[0].actualRowCount - 1).toBe(buildPaperRows(FACTS, "ithaca").length);
    expect(buildPaperRows(FACTS, "ithaca")).toHaveLength(0);
  });

  it("By paper also loads the matched strings for its papers", async () => {
    await get("?view=paper");
    expect(h.loadStrings.mock.calls[0][1]).toEqual(["1"]);
    await get("?view=entity");
    expect(h.loadStrings).toHaveBeenCalledTimes(1);
  });

  it("section=methods is a markdown attachment", async () => {
    const res = await get("?section=methods");
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toContain("screening results, not determinations");
  });

  it("logs the viewer and counts only: no name, id or entity from the data", async () => {
    await get("?view=person");
    const lines = log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "export_research_security",
      realCwid: "viewer1",
      impersonatedCwid: null,
      view: "person",
      rows: 1,
    });
    expect(lines[0]).not.toContain(SECRET_NAME);
    expect(lines[0]).not.toContain("lqt9002");
    expect(lines[0]).not.toContain("Soochow");
  });

  it("under View as, both log lines name the person signed in and the person viewed as", async () => {
    h.realSession.mockResolvedValue({ cwid: "su001" });
    await get("?view=person");
    await get("?section=methods");
    const lines = log.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({ realCwid: "su001", impersonatedCwid: "viewer1" });
      expect(line).not.toHaveProperty("cwid");
    }
  });
});
