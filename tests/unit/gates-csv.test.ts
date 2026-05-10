import { describe, expect, it } from "vitest";
import { parseCsv } from "@/etl/gates/fetcher";

describe("parseCsv (Gates fetcher)", () => {
  it("parses a simple comma-separated record", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("respects double-quoted fields with embedded commas", () => {
    expect(parseCsv('id,desc\nINV-1,"hello, world"\n')).toEqual([
      ["id", "desc"],
      ["INV-1", "hello, world"],
    ]);
  });

  it("handles doubled quotes inside quoted fields", () => {
    expect(parseCsv('id,desc\nINV-1,"she said ""hi"""\n')).toEqual([
      ["id", "desc"],
      ["INV-1", 'she said "hi"'],
    ]);
  });

  it("preserves embedded newlines within quoted fields", () => {
    expect(parseCsv('id,desc\nINV-1,"line1\nline2"\n')).toEqual([
      ["id", "desc"],
      ["INV-1", "line1\nline2"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("﻿a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles trailing record without newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("ignores empty lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses the Gates CSV prologue + header shape", () => {
    const sample =
      '﻿"Updated 4 May, 2026"\nGRANT ID,GRANTEE,PURPOSE,DIVISION,DATE COMMITTED\nINV-003934,Smithsonian,"to endow the museum",Executive,2021-02\n';
    const rows = parseCsv(sample);
    expect(rows.length).toBe(3);
    expect(rows[1][0]).toBe("GRANT ID");
    expect(rows[2]).toEqual([
      "INV-003934",
      "Smithsonian",
      "to endow the museum",
      "Executive",
      "2021-02",
    ]);
  });
});
