/**
 * #879 — pure-function tests for the MeSH curated-family-anchor ETL: the CSV
 * tokenizer/validator (loader) and the seed generator's ranking + CSV rendering.
 * The generator's co-occurrence SQL is integration-shaped (needs a populated
 * scholar_family) and is not exercised here.
 */
import { describe, expect, it } from "vitest";
import { parseFamilyAnchorCsv } from "@/etl/mesh-family-anchors/csv";
import {
  buildSeedRows,
  toCsv,
  type FamilySignals,
} from "@/etl/mesh-family-anchors/seed-rank";

describe("parseFamilyAnchorCsv (#879 loader)", () => {
  const HEADER = "supercategory,family_label,descriptor_ui,confidence,source_note";

  it("parses a quoted source note with embedded commas + a family label with spaces", () => {
    const rows = parseFamilyAnchorCsv(
      `${HEADER}\nmolecular_biochem_reagents,Flow cytometry assays,D005434,curated,"Flow Cytometry, exact method, hand-verified"`,
    );
    expect(rows).toEqual([
      {
        supercategory: "molecular_biochem_reagents",
        familyLabel: "Flow cytometry assays",
        descriptorUi: "D005434",
        confidence: "curated",
        sourceNote: "Flow Cytometry, exact method, hand-verified",
      },
    ]);
  });

  it("empty source note → null", () => {
    const rows = parseFamilyAnchorCsv(`${HEADER}\nsc,Fam,D000001,derived,`);
    expect(rows[0].sourceNote).toBeNull();
  });

  it("header-only file → [] (valid no-op)", () => {
    expect(parseFamilyAnchorCsv(`${HEADER}\n`)).toEqual([]);
  });

  it("rejects an unknown confidence value", () => {
    expect(() => parseFamilyAnchorCsv(`${HEADER}\nsc,Fam,D000001,guess,note`)).toThrow(
      /confidence must be 'curated' or 'derived'/,
    );
  });

  it("rejects a wrong column count", () => {
    expect(() => parseFamilyAnchorCsv(`${HEADER}\nsc,Fam,D000001`)).toThrow(/expected 5 columns/);
  });

  it("rejects a header mismatch", () => {
    expect(() => parseFamilyAnchorCsv("a,b,c,d,e\nsc,Fam,D1,curated,n")).toThrow(/header mismatch/);
  });
});

describe("buildSeedRows (#879 seed generator)", () => {
  const fam = (over: Partial<FamilySignals>): FamilySignals => ({
    supercategory: "sc",
    familyLabel: "Fam",
    derived: [],
    nameMatch: null,
    ...over,
  });

  it("emits the name-match descriptor first, tagged 'name-match:' when it doesn't co-occur", () => {
    const rows = buildSeedRows(
      [
        fam({
          nameMatch: {
            descriptorUi: "D005434",
            descriptorName: "Flow Cytometry",
            confidence: "exact",
            matchedForm: "Flow Cytometry",
          },
        }),
      ],
      3,
    );
    expect(rows[0].descriptorUi).toBe("D005434");
    expect(rows[0].confidence).toBe("derived"); // always derived — a human promotes it
    expect(rows[0].sourceNote).toMatch(/^name-match:/);
  });

  it("tags the name-match 'both:' when it also co-occurs, and does not duplicate it", () => {
    const rows = buildSeedRows(
      [
        fam({
          nameMatch: {
            descriptorUi: "D005434",
            descriptorName: "Flow Cytometry",
            confidence: "exact",
            matchedForm: "Flow Cytometry",
          },
          derived: [
            { descriptorUi: "D005434", descriptorName: "Flow Cytometry", ratio: 0.41, nBoth: 18, nDesc: 44 },
            { descriptorUi: "D009369", descriptorName: "Neoplasms", ratio: 0.33, nBoth: 12, nDesc: 36 },
          ],
        }),
      ],
      3,
    );
    expect(rows.map((r) => r.descriptorUi)).toEqual(["D005434", "D009369"]);
    expect(rows[0].sourceNote).toMatch(/^both:/);
    expect(rows[1].sourceNote).toMatch(/^derived:/);
  });

  it("caps at topN candidates per family", () => {
    const rows = buildSeedRows(
      [
        fam({
          derived: [
            { descriptorUi: "D1", descriptorName: "A", ratio: 0.9, nBoth: 9, nDesc: 10 },
            { descriptorUi: "D2", descriptorName: "B", ratio: 0.8, nBoth: 8, nDesc: 10 },
            { descriptorUi: "D3", descriptorName: "C", ratio: 0.7, nBoth: 7, nDesc: 10 },
            { descriptorUi: "D4", descriptorName: "D", ratio: 0.6, nBoth: 6, nDesc: 10 },
          ],
        }),
      ],
      2,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.descriptorUi)).toEqual(["D1", "D2"]);
  });

  it("flags the (c) disease-not-method failure mode in every derived note", () => {
    const rows = buildSeedRows(
      [fam({ derived: [{ descriptorUi: "D9", descriptorName: "Neoplasms", ratio: 0.5, nBoth: 5, nDesc: 10 }] })],
      3,
    );
    expect(rows[0].sourceNote).toMatch(/REVIEW: top co-occurring descriptor may be the disease/);
  });
});

describe("toCsv (#879 seed generator)", () => {
  it("quotes fields with commas/spaces and round-trips through the loader parser", () => {
    const csv = toCsv([
      {
        supercategory: "sc",
        familyLabel: "Flow cytometry assays",
        descriptorUi: "D005434",
        confidence: "derived",
        sourceNote: "both: name-match, ratio=0.41",
      },
    ]);
    expect(csv.split("\n")[0]).toBe(
      "supercategory,family_label,descriptor_ui,confidence,source_note",
    );
    // The generator's output is re-parseable by the loader's CSV parser.
    const reparsed = parseFamilyAnchorCsv(csv);
    expect(reparsed).toEqual([
      {
        supercategory: "sc",
        familyLabel: "Flow cytometry assays",
        descriptorUi: "D005434",
        confidence: "derived",
        sourceNote: "both: name-match, ratio=0.41",
      },
    ]);
  });
});
