/**
 * Unit tests for the pure-function part of the MeSH curated-alias ETL (#642):
 *
 *   - parseAliasCsv — CSV → AliasRow[] with header validation and
 *                     RFC-4180 quoted-cell handling.
 *
 * The truncate+insert itself is integration-tested via the smoke run in
 * `npm run etl:mesh-aliases`; unit tests stop at the pure boundary.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parseAliasCsv } from "@/etl/mesh-aliases/csv";
import { normalizeForMatch } from "@/lib/api/normalize";

describe("parseAliasCsv", () => {
  it("parses a header-only file as empty", () => {
    expect(parseAliasCsv("alias,descriptor_ui,source_note\n")).toEqual([]);
  });

  it("parses a single quoted-source-note row", () => {
    const text =
      "alias,descriptor_ui,source_note\n" +
      'Cardiothoracic Surgery,D013903,"Thoracic Surgery — entry terms incl. Cardiac/Heart Surgery"\n';
    expect(parseAliasCsv(text)).toEqual([
      {
        alias: "Cardiothoracic Surgery",
        descriptorUi: "D013903",
        sourceNote: "Thoracic Surgery — entry terms incl. Cardiac/Heart Surgery",
      },
    ]);
  });

  it("treats an empty source_note as null", () => {
    const text = "alias,descriptor_ui,source_note\nNeurological Surgery,D009493,\n";
    expect(parseAliasCsv(text)).toEqual([
      { alias: "Neurological Surgery", descriptorUi: "D009493", sourceNote: null },
    ]);
  });

  it("handles embedded double quotes per RFC 4180 (escape by doubling)", () => {
    const text =
      "alias,descriptor_ui,source_note\n" +
      'Oral and Maxillofacial Surgery,D013515,"closest descriptor: ""Surgery, Oral"""\n';
    const rows = parseAliasCsv(text);
    expect(rows[0].sourceNote).toBe('closest descriptor: "Surgery, Oral"');
  });

  it("throws on a header mismatch", () => {
    expect(() => parseAliasCsv("descriptor_ui,alias,source_note\n")).toThrow(/header mismatch/);
  });

  it("throws when a required cell is missing", () => {
    expect(() => parseAliasCsv("alias,descriptor_ui,source_note\n,D013903,note\n")).toThrow(
      /required/,
    );
  });

  it("throws on a wrong column count", () => {
    expect(() => parseAliasCsv("alias,descriptor_ui,source_note\nfoo,D013903\n")).toThrow(
      /expected 3 columns/,
    );
  });
});

describe("curated.csv (the real shipped file)", () => {
  const rows = parseAliasCsv(readFileSync(resolve("etl/mesh-aliases/curated.csv"), "utf8"));

  it("parses cleanly and is non-trivial", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it("every descriptor_ui is a well-formed MeSH UI (D followed by digits)", () => {
    expect(rows.filter((r) => !/^D\d+$/.test(r.descriptorUi))).toEqual([]);
  });

  it("normalized aliases are unique — no two rows collide on the resolver key", () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const r of rows) {
      const k = normalizeForMatch(r.alias);
      const prev = seen.get(k);
      if (prev) dups.push(`${r.alias} <> ${prev}`);
      else seen.set(k, r.alias);
    }
    expect(dups).toEqual([]);
  });

  it("includes the search-resolution hero-chip aliases", () => {
    const aliases = new Set(rows.map((r) => r.alias));
    for (const a of [
      "Causal inference",
      "Robotic surgery",
      "Single-cell RNA sequencing",
      "PSMA PET imaging",
      "Mendelian randomization",
    ]) {
      expect(aliases.has(a)).toBe(true);
    }
  });
});
