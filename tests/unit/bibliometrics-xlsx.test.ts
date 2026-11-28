/**
 * The Bibliometrics spreadsheet download (`format=xlsx`): its sheets, the
 * Papers rows (PMID, DOI, impact counts), and the Citing documents read (own
 * work left out in SQL, a patent family once per paper, the row cap). All
 * people, papers and documents are invented.
 */
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { read: { $queryRaw: h.queryRaw }, write: {} } }));

import { buildBibliometricsReport, rankPapers, type BibliometricsPubRow } from "@/lib/edit/bibliometrics";
import { CITING_ROWS_CAP, buildBibliometricsWorkbook, loadCitingDocRows } from "@/lib/edit/bibliometrics-xlsx";
import { Prisma } from "@/lib/generated/prisma/client";

const pub = (pmid: string, over: Partial<BibliometricsPubRow> = {}): BibliometricsPubRow => ({
  pmid,
  title: `Invented <i>paper</i> ${pmid}`,
  authorsString: "Quill A, Vale J",
  journal: "Journal of Examples",
  year: 2021,
  volume: null,
  issue: null,
  pages: null,
  doi: `10.0000/${pmid}`,
  publicationType: "Academic Article",
  citationCount: 12,
  citedByCount: 9,
  nihPercentile: 60,
  relativeCitationRatio: 1.2,
  dateAddedToEntrez: new Date("2021-06-01T00:00:00Z"),
  authorityBodies: null,
  authorityCount: 0,
  guidelineCount: 0,
  consensusCount: 0,
  reviewCount: 0,
  patentFamilyCount: 0,
  position: 1,
  isFirst: true,
  isLast: false,
  ...over,
});

const raw = (r: Partial<{ pmid: string; level: string; body: string | null; journal: string | null; assignees: string | null; title: string; year: number | null; url: string; dedup: string }>) => ({
  pmid: "90000201",
  level: "guideline",
  body: null,
  journal: null,
  assignees: null,
  title: "An invented guideline",
  year: 2024,
  url: "https://example.org/doc",
  dedup: "k",
  ...r,
});

describe("loadCitingDocRows", () => {
  it("reads only the given papers, leaves own work out in SQL, and lists a patent family once per paper", async () => {
    h.queryRaw.mockResolvedValueOnce([
      raw({ level: "authority", body: "AHRQ", journal: "Ignored" }),
      raw({ level: "patent", assignees: '["Example Corp","Sample LLC"]', dedup: "fam1", title: "Patent A1" }),
      raw({ level: "patent", assignees: '["Example Corp"]', dedup: "fam1", title: "Patent A2" }),
      raw({ level: "review", journal: "Reviews of Examples" }),
    ]);
    const rows = await loadCitingDocRows(["90000201"]);
    const sql = h.queryRaw.mock.calls[0]![0] as TemplateStringsArray;
    const text = sql.join("?");
    expect(text).toContain("l.pmid IN");
    expect(text).toContain("NOT ((d.level = 'clinical'");
    expect(h.queryRaw.mock.calls[0]!.slice(1)).toContainEqual(Prisma.join(["90000201"]));
    expect(rows!.map((r) => [r.level, r.source, r.title])).toEqual([
      ["authority", "AHRQ", "An invented guideline"],
      ["patent", "Example Corp; Sample LLC", "Patent A1"],
      ["review", "Reviews of Examples", "An invented guideline"],
    ]);
  });

  it("reads nothing with no papers, and answers null over the cap", async () => {
    h.queryRaw.mockClear();
    expect(await loadCitingDocRows([])).toEqual([]);
    expect(h.queryRaw).not.toHaveBeenCalled();
    h.queryRaw.mockResolvedValueOnce(Array.from({ length: CITING_ROWS_CAP + 1 }, () => raw({})));
    expect(await loadCitingDocRows(["90000201"])).toBeNull();
  });
});

describe("buildBibliometricsWorkbook", () => {
  const visible = [
    pub("90000201", { guidelineCount: 2, nihPercentile: 95 }),
    pub("90000202", { isFirst: false, isLast: true, year: 2019, reviewCount: 4, patentFamilyCount: 1 }),
    pub("90000203", { publicationType: "Review" }), // not a research article: not a row
  ];
  const report = buildBibliometricsReport({
    scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: null },
    visible,
    all: visible,
    filters: { authorship: "all", yearFrom: null, yearTo: null },
    now: new Date("2026-11-25T12:00:00Z"),
  });
  const articles = rankPapers(visible.filter((p) => p.publicationType === "Academic Article"));

  const read = async (citing: Parameters<typeof buildBibliometricsWorkbook>[2]) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildBibliometricsWorkbook(report, articles, citing)) as unknown as ArrayBuffer);
    return wb;
  };

  it("has a sheet per section, one Papers row per research article, and the citing documents", async () => {
    const wb = await read([
      // The top-ranked paper's review, the second paper's guideline.
      { pmid: "90000201", level: "review", source: "Reviews of Examples", title: "A review", year: 2023, url: "https://example.org/r" },
      { pmid: "90000202", level: "guideline", source: null, title: "A guideline", year: 2022, url: "https://example.org/g" },
    ]);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Output",
      "Papers",
      "Downstream impact",
      "Citing documents",
      "Definitions",
    ]);
    const papers = wb.getWorksheet("Papers")!;
    expect(papers.getRow(1).getCell(2).value).toBe("PMID");
    expect(papers.rowCount).toBe(3);
    expect(papers.getRow(2).values).toEqual(
      expect.arrayContaining(["90000201", "10.0000/90000201", "Invented paper 90000201", "First", 95, 12, 2]),
    );
    const docs = wb.getWorksheet("Citing documents")!;
    // Guidelines before reviews, as the tab orders the levels, whatever the paper's rank.
    expect(docs.getRow(2).getCell(1).value).toBe("90000202");
    expect(docs.getRow(2).getCell(3).value).toBe("Clinical practice guidelines");
    expect(docs.getRow(3).getCell(2).value).toBe("Invented paper 90000201");
    expect(wb.getWorksheet("Summary")!.getRow(3).values).toEqual(expect.arrayContaining(["Calculated", "2026-11-25"]));
  });

  it("says so on the Citing documents sheet over the cap", async () => {
    const docs = (await read(null)).getWorksheet("Citing documents")!;
    expect(String(docs.getRow(2).getCell(1).value)).toMatch(/^More than 50,000 citing documents/);
  });
});
