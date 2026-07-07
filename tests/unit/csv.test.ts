/**
 * lib/csv — RFC 4180 quoting (current behavior pinned) + #1514 formula-injection
 * guard: a cell a spreadsheet would evaluate as a formula gets a leading `'`,
 * while legitimate numbers / numeric strings / plain text stay byte-identical to
 * the pre-guard output.
 */
import { describe, it, expect } from "vitest";
import { toCsv } from "@/lib/csv";

// toCsv appends a trailing CRLF and separates rows with CRLF.
const rows = (csv: string) => csv.replace(/\r\n$/, "").split("\r\n");
const cell = (v: unknown) => rows(toCsv(["h"], [[v as never]]))[1];

describe("toCsv — RFC 4180 quoting (current behavior)", () => {
  it("quotes commas / quotes / newlines and doubles embedded quotes", () => {
    expect(cell("x,y")).toBe('"x,y"');
    expect(cell('has "q"')).toBe('"has ""q"""');
    expect(cell("a\nb")).toBe('"a\nb"');
  });

  it("passes numbers, nulls, and plain strings through unchanged", () => {
    expect(cell(5)).toBe("5");
    expect(cell(null)).toBe("");
    expect(cell(undefined)).toBe("");
    expect(cell("Journal of Things")).toBe("Journal of Things");
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2\r\n");
  });
});

describe("toCsv — #1514 formula-injection guard", () => {
  it("prefixes formula-leading string cells with a single quote", () => {
    expect(cell("=1+1")).toBe("'=1+1");
    expect(cell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(cell("+1-212-555")).toBe("'+1-212-555"); // Excel would evaluate this
    expect(cell("-cmd")).toBe("'-cmd");
    expect(cell("\tTAB")).toBe("'\tTAB");
  });

  it("still quotes a guarded cell that also contains a comma", () => {
    expect(cell("=1,2")).toBe('"\'=1,2"');
  });

  it("does NOT touch legitimate numbers or numeric strings", () => {
    expect(cell(-5)).toBe("-5"); // number type
    expect(cell("-5")).toBe("-5"); // numeric string
    expect(cell("+3.2")).toBe("+3.2"); // signed numeric string
    expect(cell("3")).toBe("3");
  });

  it("does NOT touch plain text starting with a safe character", () => {
    expect(cell("Alpha")).toBe("Alpha");
    expect(cell("(212) 555-1212")).toBe("(212) 555-1212"); // paren-led, safe
  });
});
