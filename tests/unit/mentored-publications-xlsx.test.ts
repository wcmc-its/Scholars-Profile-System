/**
 * `lib/edit/mentored-publications-xlsx.ts` — builds the three-sheet workbook
 * and reads it back with exceljs: sheet names, header rows, a data row per
 * sheet, the frozen + bold header, Arial 12, and the Yes/No window column.
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
  RAW_SHEET,
  SUMMARY_HEADERS,
  SUMMARY_SHEET,
} from "@/lib/edit/mentored-publications-xlsx";

const REPORT: MentoredPublicationsReport = {
  generatedAt: new Date("2026-09-18T15:04:05Z"),
  filters: { scopes: ["md"], gradYears: [2025, 2024], tail: 1 },
  summary: [
    {
      gradYear: 2025,
      entryYear: 2021,
      entryYearSource: "fallback",
      cwid: "stu0001",
      firstName: "Ada",
      lastName: "Learner",
      program: "MD",
      mentors: ["Zed Mentor"],
      pubsInWindow: 1,
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
    expect(rowValues(ws, 2)).toEqual([2025, 2021, "MD", "stu0001", "Ada", "Learner", "Zed Mentor", 1, 2, 1, 0]);
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
    const first = rowValues(ws, 2);
    expect(first.slice(0, 13)).toEqual([
      2025, 2021, "MD", "stu0001", "Ada", "Learner", "men0001", "Zed Mentor", 7,
      "A very long title ".repeat(10), "N Engl J Med", 96.2, 2023,
    ]);
    expect((first[13] as Date).toISOString().slice(0, 10)).toBe("2023-05-01");
    expect(first.slice(14)).toEqual([12, 2, 3, "Yes"]);
    const second = rowValues(ws, 3);
    expect(second[17]).toBe("No");
    // Nulls are blank cells, not the string "null".
    expect(ws.getCell("K3").value).toBeNull();
    expect(ws.getCell("L3").value).toBeNull();
    // Title column: longest content is 180 chars → capped at 60; PMID column: header wins.
    expect(ws.getColumn(10).width).toBe(60);
    expect(ws.getColumn(9).width).toBe("PMID".length + 3);
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

  it("downloadFilename: program or All, years joined by -, ISO day", () => {
    const d = new Date("2026-09-18T23:59:59Z");
    expect(downloadFilename("md", [2024, 2025], d)).toBe("Mentored Publications MD 2024-2025 - 2026-09-18.xlsx");
    expect(downloadFilename(null, [2025], d)).toBe("Mentored Publications All 2025 - 2026-09-18.xlsx");
    expect(downloadFilename("mdphd", [], d)).toBe("Mentored Publications MD-PhD all-years - 2026-09-18.xlsx");
  });
});
