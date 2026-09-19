/**
 * `lib/edit/mentored-publications-xlsx.ts` — builds the three-sheet workbook
 * and reads it back with exceljs: sheet names, header rows, a data row per
 * sheet, the frozen + bold header, Arial 12, the Yes/No window column, the
 * Mentor CWIDs + Mentorship types columns, the Raw Data "Type of mentorship"
 * column, and the "all learner publications" mode's headers /
 * mentor-on-paper columns / filename suffix / assumptions.
 * `@/lib/db` is stubbed only because the report module (imported for its
 * types/constants) pulls it in at module scope; nothing here reads it.
 */
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import type { MentoredPublicationsReport } from "@/lib/edit/mentored-publications-report";
import {
  ASSUMPTIONS_SHEET,
  buildMentoredPublicationsWorkbook,
  downloadFilename,
  RAW_HEADERS,
  RAW_HEADERS_ALL,
  RAW_SHEET,
  SUMMARY_HEADERS,
  SUMMARY_HEADERS_ALL,
  SUMMARY_SHEET,
} from "@/lib/edit/mentored-publications-xlsx";

const MD_ROSTER = { program: "md", source: "roster", tier: "confirmed" } as const;
const ZED = { cwid: "men0001", name: "Zed Mentor", mentorship: MD_ROSTER };
const YAN = { cwid: "men0002", name: "Yan Other", mentorship: { ...MD_ROSTER, program: "mdphd" } };

const REPORT: MentoredPublicationsReport = {
  generatedAt: new Date("2026-09-18T15:04:05Z"),
  filters: { scopes: ["md"], gradYears: [2025, 2024], tail: 1, pubs: "mentored" },
  allPubsLoaded: null,
  droppedNonPubmed: 0,
  droppedUnresolved: 0,
  publications: [],
  summary: [
    {
      gradYear: 2025,
      entryYear: 2021,
      entryYearSource: "fallback",
      cwid: "stu0001",
      firstName: "Ada",
      lastName: "Learner",
      program: "MD",
      mentors: [YAN, ZED],
      pubsInWindow: 1,
      withMentorInWindow: 1,
      pubsAllTime: 2,
      highImpactInWindow: 1,
      firstAuthorInWindow: 0,
    },
  ],
  detail: [
    {
      gradYear: 2025,
      entryYear: 2021,
      program: "MD",
      learnerCwid: "stu0001",
      learnerFirstName: "Ada",
      learnerLastName: "Learner",
      mentorCwid: "men0001",
      mentorName: "Zed Mentor",
      mentorship: "MD · roster",
      paperMentors: [ZED],
      withMentor: true,
      pmid: 7,
      title: "A very long title ".repeat(10),
      journal: "N Engl J Med",
      jif: 96.2,
      year: 2023,
      dateAdded: new Date("2023-05-01T00:00:00Z"),
      citations: 12,
      learnerAuthorPosition: 2,
      authorCount: 3,
      inWindow: true,
    },
    {
      gradYear: 2025,
      entryYear: 2021,
      program: "MD",
      learnerCwid: "stu0001",
      learnerFirstName: "Ada",
      learnerLastName: "Learner",
      mentorCwid: "men0001",
      mentorName: "Zed Mentor",
      mentorship: "MD · roster",
      paperMentors: [ZED],
      withMentor: true,
      pmid: 8,
      title: "Older",
      journal: null,
      jif: null,
      year: 2019,
      dateAdded: null,
      citations: null,
      learnerAuthorPosition: null,
      authorCount: 0,
      inWindow: false,
    },
  ],
};

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

function rowValues(ws: ExcelJS.Worksheet, n: number): unknown[] {
  const values = ws.getRow(n).values as unknown[];
  return values.slice(1); // exceljs row values are 1-indexed (index 0 is empty)
}

describe("buildMentoredPublicationsWorkbook", () => {
  it("returns a Buffer with the three sheets, in order", async () => {
    const buffer = await buildMentoredPublicationsWorkbook(REPORT);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const wb = await load(buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, RAW_SHEET, ASSUMPTIONS_SHEET]);
  });

  it("Summary: business-case headers, one row per learner, bold frozen header in Arial 12", async () => {
    const wb = await load(await buildMentoredPublicationsWorkbook(REPORT));
    const ws = wb.getWorksheet(SUMMARY_SHEET)!;
    expect(rowValues(ws, 1)).toEqual([...SUMMARY_HEADERS]);
    expect(SUMMARY_HEADERS[8]).toBe("Mentorship types");
    expect(rowValues(ws, 2)).toEqual([
      2025, 2021, "MD", "stu0001", "Ada", "Learner", "Yan Other; Zed Mentor", "men0002; men0001",
      "MD-PhD · roster; MD · roster", 1, 2, 1, 0,
    ]);
    expect(ws.rowCount).toBe(2);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.getCell("A1").font).toMatchObject({ name: "Arial", size: 12, bold: true });
    expect(ws.getCell("A2").font).toMatchObject({ name: "Arial", size: 12 });
    expect(ws.getCell("A2").font.bold).toBeFalsy();
  });

  it("Raw Data: one row per (learner, mentor, pub), Yes/No window flag, nulls blank, widths capped at 60", async () => {
    const wb = await load(await buildMentoredPublicationsWorkbook(REPORT));
    const ws = wb.getWorksheet(RAW_SHEET)!;
    expect(rowValues(ws, 1)).toEqual([...RAW_HEADERS]);
    expect(RAW_HEADERS[8]).toBe("Type of mentorship");
    const first = rowValues(ws, 2);
    expect(first.slice(0, 14)).toEqual([
      2025, 2021, "MD", "stu0001", "Ada", "Learner", "men0001", "Zed Mentor", "MD · roster", 7,
      "A very long title ".repeat(10), "N Engl J Med", 96.2, 2023,
    ]);
    expect((first[14] as Date).toISOString().slice(0, 10)).toBe("2023-05-01");
    expect(first.slice(15)).toEqual([12, 2, 3, "Yes"]);
    const second = rowValues(ws, 3);
    expect(second[18]).toBe("No");
    // Nulls are blank cells, not the string "null".
    expect(ws.getCell("L3").value).toBeNull();
    expect(ws.getCell("M3").value).toBeNull();
    // Title column: longest content is 180 chars → capped at 60; PMID column: header wins.
    expect(ws.getColumn(11).width).toBe(60);
    expect(ws.getColumn(10).width).toBe("PMID".length + 3);
  });

  it("Query & Assumptions names the window rule, counting rule, JIF and iCite sources", async () => {
    const wb = await load(await buildMentoredPublicationsWorkbook(REPORT));
    const ws = wb.getWorksheet(ASSUMPTIONS_SHEET)!;
    const items = new Map<string, unknown>();
    ws.eachRow((row, n) => {
      if (n > 1) items.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    expect(items.get("Generated")).toBe("2026-09-18");
    expect(items.get("Graduation years")).toBe("2024, 2025");
    expect(items.get("Programs")).toBe("MD");
    expect(String(items.get("Window rule"))).toContain("entry year <= publication year <= graduation year + 1");
    expect(String(items.get("Entry year"))).toContain("1 of 1 learner used the fallback");
    expect(String(items.get("Counting rule"))).toContain("counts once");
    expect(String(items.get("Citations"))).toContain("iCite");
    expect(String(items.get("Citations"))).toContain("not Scopus");
    expect(String(items.get("Journal impact factor"))).toContain("Journal Citation Reports");
  });

  it("an unknowable window: null counts and a null flag are blank cells; 'Unknown' in the years line", async () => {
    const wb = await load(
      await buildMentoredPublicationsWorkbook({
        ...REPORT,
        filters: { ...REPORT.filters, gradYears: [2025, null] },
        summary: [
          {
            ...REPORT.summary[0],
            gradYear: null,
            entryYear: null,
            entryYearSource: null,
            pubsInWindow: null,
            withMentorInWindow: null,
            highImpactInWindow: null,
            firstAuthorInWindow: null,
          },
        ],
        detail: [{ ...REPORT.detail[0], gradYear: null, entryYear: null, inWindow: null }],
      }),
    );
    const summary = wb.getWorksheet(SUMMARY_SHEET)!;
    expect(summary.getCell("J2").value).toBeNull();
    expect(summary.getCell("K2").value).toBe(2);
    expect(summary.getCell("L2").value).toBeNull();
    expect(summary.getCell("M2").value).toBeNull();
    expect(wb.getWorksheet(RAW_SHEET)!.getCell("S2").value).toBeNull();
    expect(wb.getWorksheet(ASSUMPTIONS_SHEET)!.getRow(3).getCell(2).value).toBe("2025, Unknown");
  });

  it("downloadFilename: program or All, years joined by -, ' All Pubs' in all mode, ISO day", () => {
    const d = new Date("2026-09-18T23:59:59Z");
    expect(downloadFilename("md", [2024, 2025], d)).toBe("Mentored Publications MD 2024-2025 - 2026-09-18.xlsx");
    expect(downloadFilename("md", [2026, null], d)).toBe("Mentored Publications MD 2026-unknown - 2026-09-18.xlsx");
    expect(downloadFilename(null, [2025], d)).toBe("Mentored Publications All 2025 - 2026-09-18.xlsx");
    expect(downloadFilename("mdphd", [], d)).toBe("Mentored Publications MD-PhD all-years - 2026-09-18.xlsx");
    expect(downloadFilename("md", [2025], d, "all")).toBe("Mentored Publications MD 2025 All Pubs - 2026-09-18.xlsx");
    expect(downloadFilename("md", [2025], d, "mentored")).toBe("Mentored Publications MD 2025 - 2026-09-18.xlsx");
  });

  describe("pubs: 'all' mode", () => {
    const ALL: MentoredPublicationsReport = {
      ...REPORT,
      filters: { ...REPORT.filters, pubs: "all" },
      allPubsLoaded: true,
      summary: [{ ...REPORT.summary[0], pubsInWindow: 3, withMentorInWindow: 1, firstAuthorInWindow: 2, pubsAllTime: 5 }],
      detail: [
        { ...REPORT.detail[0], mentorCwid: null, mentorName: null, mentorship: null, paperMentors: [YAN, ZED], withMentor: true },
        { ...REPORT.detail[1], mentorCwid: null, mentorName: null, mentorship: null, paperMentors: [], withMentor: false },
      ],
    };

    it("Summary: the all-mode headers and column order", async () => {
      const wb = await load(await buildMentoredPublicationsWorkbook(ALL));
      const ws = wb.getWorksheet(SUMMARY_SHEET)!;
      expect(rowValues(ws, 1)).toEqual([...SUMMARY_HEADERS_ALL]);
      expect(SUMMARY_HEADERS_ALL[8]).toBe("Mentorship types");
      expect(SUMMARY_HEADERS_ALL.slice(9)).toEqual([
        "All publications in program window",
        "Publications with a mentor in window",
        "First-author publications in window",
        "High-impact publications in window (JIF ≥ 10)",
        "Publications (all years)",
      ]);
      expect(rowValues(ws, 2)).toEqual([
        2025, 2021, "MD", "stu0001", "Ada", "Learner", "Yan Other; Zed Mentor", "men0002; men0001",
        "MD-PhD · roster; MD · roster", 3, 1, 2, 1, 5,
      ]);
    });

    it("Raw Data: one row per (learner, pub) with the mentor(s) on the paper, blank when none", async () => {
      const wb = await load(await buildMentoredPublicationsWorkbook(ALL));
      const ws = wb.getWorksheet(RAW_SHEET)!;
      expect(rowValues(ws, 1)).toEqual([...RAW_HEADERS_ALL]);
      expect(RAW_HEADERS_ALL).not.toContain("Type of mentorship");
      expect(RAW_HEADERS_ALL[6]).toBe("Mentor(s) on this paper");
      expect(rowValues(ws, 2).slice(6, 9)).toEqual(["Yan Other; Zed Mentor", "men0002; men0001", 7]);
      expect(ws.getCell("G3").value).toBeNull();
      expect(ws.getCell("H3").value).toBeNull();
      expect(rowValues(ws, 3)[8]).toBe(8);
    });

    it("Query & Assumptions names the mode and the mentored-subset rule", async () => {
      const wb = await load(await buildMentoredPublicationsWorkbook(ALL));
      const ws = wb.getWorksheet(ASSUMPTIONS_SHEET)!;
      const items = new Map<string, unknown>();
      ws.eachRow((row, n) => {
        if (n > 1) items.set(String(row.getCell(1).value), row.getCell(2).value);
      });
      expect(String(items.get("Publication set"))).toMatch(/^All learner publications/);
      expect(String(items.get("Publication set"))).toContain("subset");
      expect(String(items.get("Mentor names"))).toContain("Scholars profile");
      const mentored = await load(await buildMentoredPublicationsWorkbook(REPORT));
      const row = [...Array(20).keys()]
        .map((i) => mentored.getWorksheet(ASSUMPTIONS_SHEET)!.getRow(i + 1))
        .find((r) => String(r.getCell(1).value) === "Publication set");
      expect(String(row?.getCell(2).value)).toMatch(/^Mentored co-publications/);
    });
  });
});
