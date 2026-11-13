/**
 * The Matcha export workbook, read back with ExcelJS: bold frozen header with an autofilter,
 * widths clamped to 8..60, wrapped long columns, estimated row heights, the Name hyperlink, and
 * no formula cells even for a pasted `=` payload.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import type { MatchaExportRow } from "@/lib/edit/matcha-export";
import {
  buildMatchaWorkbook,
  wrappedLines,
  XLSX_LINE_HEIGHT_PT,
  XLSX_MAX_WIDTH,
  XLSX_MIN_WIDTH,
} from "@/lib/edit/matcha-xlsx";

const ROW: MatchaExportRow = {
  rank: 1,
  cwid: "aaa1001",
  name: "Alice Alpha",
  title: "Professor of Medicine",
  department: "Medicine",
  fit: "Strong fit",
  matchedConcepts: ["systemic sclerosis", "pulmonary fibrosis"],
  personType: "Full-time faculty",
  careerStage: "Senior",
  clinician: "Yes",
  researcherType: "Physician-scientist",
  researchKind: "Laboratory research",
  technologyCount: 2,
  profileUrl: "https://example.org/alice-alpha",
};

async function read(rows: MatchaExportRow[], opts = {}) {
  const buf = await buildMatchaWorkbook(rows, opts, new Date("2026-11-13T12:00:00Z"));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.getWorksheet("Researchers")!;
}

function colOf(ws: ExcelJS.Worksheet, header: string): number {
  let found = 0;
  ws.getRow(1).eachCell((c, n) => {
    if (c.value === header) found = n;
  });
  if (!found) throw new Error(`no column ${header}`);
  return found;
}

describe("buildMatchaWorkbook", () => {
  it("bolds and freezes the header row, with an autofilter across it", async () => {
    const ws = await read([ROW]);
    expect(ws.getRow(1).getCell(1).value).toBe("Rank");
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(ws.getRow(1).getCell(14).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(JSON.stringify(ws.autoFilter)).toMatch(/A1/);
    expect(JSON.stringify(ws.autoFilter)).toMatch(/N1/);
  });

  it("fits widths to the longest value, clamped to 8..60, and wraps a capped column", async () => {
    const long = "x".repeat(200);
    const ws = await read([{ ...ROW, title: long, cwid: "a" }]);
    // CWID: header (4) and value (1) are short ⇒ the floor.
    expect(ws.getColumn(colOf(ws, "CWID")).width).toBe(XLSX_MIN_WIDTH);
    // Name: "Alice Alpha" (11) + 2.
    expect(ws.getColumn(colOf(ws, "Name")).width).toBe(13);
    // Title: 200 chars ⇒ the cap, and its cells wrap.
    const title = colOf(ws, "Title");
    expect(ws.getColumn(title).width).toBe(XLSX_MAX_WIDTH);
    expect(ws.getRow(2).getCell(title).alignment?.wrapText).toBe(true);
    // A short column does not wrap.
    expect(ws.getRow(2).getCell(colOf(ws, "Fit")).alignment?.wrapText).toBeFalsy();
  });

  it("estimates the row height from the most wrapped lines in any cell", async () => {
    const ws = await read([
      { ...ROW, title: "y".repeat(150) }, // 150 chars in a 60-wide column ⇒ 3 lines
      { ...ROW, cwid: "bbb2002", name: "Bob Beta" },
    ]);
    expect(ws.getRow(2).height).toBe(3 * XLSX_LINE_HEIGHT_PT);
    expect(ws.getRow(3).height).toBe(XLSX_LINE_HEIGHT_PT);
    expect(ws.getRow(1).height).toBe(XLSX_LINE_HEIGHT_PT);
  });

  it("wraps the long-text brief columns even when short", async () => {
    const ws = await read([{ ...ROW, briefWhy: "Short.", briefAngle: "", briefTopics: "" }], {
      brief: true,
    });
    expect(ws.getRow(2).getCell(colOf(ws, "Why this PI")).alignment?.wrapText).toBe(true);
    expect(ws.getRow(2).getCell(colOf(ws, "Matched concepts")).alignment?.wrapText).toBe(true);
  });

  it("links the Name cell to the profile and keeps the URL column as text", async () => {
    const ws = await read([ROW]);
    const name = ws.getRow(2).getCell(colOf(ws, "Name")).value as ExcelJS.CellHyperlinkValue;
    expect(name.text).toBe("Alice Alpha");
    expect(name.hyperlink).toBe("https://example.org/alice-alpha");
    expect(ws.getRow(2).getCell(colOf(ws, "Profile URL")).value).toBe(
      "https://example.org/alice-alpha",
    );
  });

  it("links only http(s) URLs (the rows come from the browser)", async () => {
    const ws = await read([{ ...ROW, profileUrl: "javascript:alert(1)" }]);
    expect(ws.getRow(2).getCell(colOf(ws, "Name")).value).toBe("Alice Alpha");
  });

  /**
   * Concept terms come from a pasted sponsor email. A string cell is never a formula in a
   * workbook, and the CSV guard still prefixes a leading `=`, `+`, `-` or `@`.
   */
  it("writes no formula cells, even for an injection payload", async () => {
    const ws = await read([
      { ...ROW, matchedConcepts: ["=cmd|'/c calc'!A1"], name: "@SUM(1+1)", title: "+1-2" },
    ]);
    ws.eachRow((row) =>
      row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)),
    );
    expect(ws.getRow(2).getCell(colOf(ws, "Matched concepts")).value).toBe("'=cmd|'/c calc'!A1");
    const name = ws.getRow(2).getCell(colOf(ws, "Name")).value as ExcelJS.CellHyperlinkValue;
    expect(name.text).toBe("'@SUM(1+1)");
  });

  it("keeps numbers numeric", async () => {
    const ws = await read([ROW]);
    expect(ws.getRow(2).getCell(colOf(ws, "Rank")).value).toBe(1);
    expect(ws.getRow(2).getCell(colOf(ws, "CTL technologies")).value).toBe(2);
  });
});

describe("wrappedLines", () => {
  it("counts newline segments, wrapped by width", () => {
    expect(wrappedLines("abc", 10, false)).toBe(1);
    expect(wrappedLines("a\nb", 10, false)).toBe(1);
    expect(wrappedLines("x".repeat(25), 10, true)).toBe(3);
    expect(wrappedLines(`${"x".repeat(15)}\n\nshort`, 10, true)).toBe(4);
  });
});
