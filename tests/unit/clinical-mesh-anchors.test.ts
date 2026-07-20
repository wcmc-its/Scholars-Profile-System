import { describe, it, expect } from "vitest";
import { treeNumberPrefixes } from "@/lib/mesh-tree-ancestors";
import {
  anchorKey,
  isDiseaseTree,
  parseSpecialtyAnchors,
  buildClinicalAnchors,
  clinicalMeshMatch,
  loadSpecialtyAnchorMap,
} from "@/lib/clinical-mesh-anchors";

/** The query descriptor's ancestor closure — what the resolver stamps onto
 *  `MeshResolution.ancestorTreeNumbers` and threads into searchPeople. */
const closureOf = (...treeNumbers: string[]) => [
  ...new Set(treeNumbers.flatMap((tn) => treeNumberPrefixes(tn))),
];

describe("anchorKey", () => {
  it("is casing/punctuation/whitespace insensitive", () => {
    expect(anchorKey("Cardiovascular Disease")).toBe("cardiovasculardisease");
    expect(anchorKey("cardiovascular-disease")).toBe(anchorKey("Cardiovascular Disease"));
    expect(anchorKey("  Interventional Cardiology ")).toBe("interventionalcardiology");
  });
});

describe("isDiseaseTree", () => {
  it("accepts C (Diseases) and F03 (Mental Disorders), rejects other axes", () => {
    expect(isDiseaseTree("C14.280")).toBe(true);
    expect(isDiseaseTree("F03.600")).toBe(true);
    expect(isDiseaseTree("H01.158")).toBe(false); // discipline tree
    expect(isDiseaseTree("F01.100")).toBe(false); // behavior, not disorder
    expect(isDiseaseTree("E04.100")).toBe(false); // procedure tree
  });
});

describe("parseSpecialtyAnchors", () => {
  it("skips header/comments/blanks and keeps the D-code column", () => {
    const map = parseSpecialtyAnchors(
      [
        "# a comment",
        "specialty,descriptor_ui,note",
        "",
        "Cardiovascular Disease,D002318,C14",
        "Cardiology,D002318,discipline override",
      ].join("\n"),
    );
    expect(map.get(anchorKey("Cardiovascular Disease"))).toBe("D002318");
    expect(map.get(anchorKey("Cardiology"))).toBe("D002318");
    expect(map.has(anchorKey("specialty"))).toBe(false); // header not ingested
    expect(map.size).toBe(2);
  });

  it("locates the descriptor column even when the specialty contains a comma", () => {
    const map = parseSpecialtyAnchors("Surgery, Vascular,D014656,C14 vessels\n");
    expect(map.get(anchorKey("Surgery, Vascular"))).toBe("D014656");
  });

  it("first row wins on a duplicate key", () => {
    const map = parseSpecialtyAnchors("Cardiology,D002318,first\nCardiology,D006331,second\n");
    expect(map.get(anchorKey("Cardiology"))).toBe("D002318");
  });
});

describe("buildClinicalAnchors", () => {
  const anchorMap = new Map([
    [anchorKey("Cardiology"), "D002318"],
    [anchorKey("Nephrology"), "D007674"], // Kidney Diseases (curated H→C override)
  ]);
  const treeNumbersByUi = new Map([
    ["D002318", ["C14"]],
    ["D007674", ["C12.777.419.780", "C13.351.968.419.780"]],
    ["D009398", ["H01.158.273.180"]], // if a discipline UI ever leaked in — non-disease
  ]);

  it("emits disease-tree anchors + a flat deduped tree set", () => {
    const { tree, anchors } = buildClinicalAnchors(
      ["Cardiology", "Nephrology"],
      [],
      anchorMap,
      treeNumbersByUi,
    );
    expect(anchors).toHaveLength(2);
    expect(tree).toEqual(
      expect.arrayContaining(["C14", "C12.777.419.780", "C13.351.968.419.780"]),
    );
  });

  it("drops a non-disease anchor (the discipline-axis guard)", () => {
    const map = new Map([[anchorKey("Nephrology"), "D009398"]]); // resolves to H tree
    const { tree, anchors } = buildClinicalAnchors(["Nephrology"], [], map, treeNumbersByUi);
    expect(tree).toEqual([]);
    expect(anchors).toEqual([]);
  });

  it("marks boardCertified from the board set (case/space-insensitive)", () => {
    const { anchors } = buildClinicalAnchors(
      ["Cardiology"],
      [" cardiology "],
      anchorMap,
      treeNumbersByUi,
    );
    expect(anchors[0].boardCertified).toBe(true);
  });

  it("ignores specialties absent from the map (no regression)", () => {
    const { tree, anchors } = buildClinicalAnchors(
      ["Dermatology"],
      [],
      anchorMap,
      treeNumbersByUi,
    );
    expect(tree).toEqual([]);
    expect(anchors).toEqual([]);
  });
});

describe("the committed specialty-anchors.csv loads + resolves", () => {
  // Loads etl/clinical-mesh/specialty-anchors.csv from the repo root (cwd), the
  // same path the index build uses. Guards the real data file's format + parsing
  // (incl. the comma-in-note rows) and its ABMS coverage.
  const map = loadSpecialtyAnchorMap();

  it("parses without error and covers the core specialties", () => {
    expect(map.size).toBeGreaterThanOrEqual(40);
    expect(map.get(anchorKey("Cardiology"))).toBe("D002318");
    expect(map.get(anchorKey("Nephrology"))).toBe("D007674"); // case-insensitive
    expect(map.get(anchorKey("Psychiatry"))).toBe("D001523");
  });

  it("parses a row whose NOTE column contains a comma", () => {
    // `Clinical Cardiac Electrophysiology,D001145,"Arrhythmias, Cardiac (…)"`
    expect(map.get(anchorKey("Clinical Cardiac Electrophysiology"))).toBe("D001145");
  });

  it("distinguishes the 'and' vs '&' specialty wording variants", () => {
    expect(map.get(anchorKey("Endocrinology Diabetes and Metabolism"))).toBe("D004700");
    expect(map.get(anchorKey("Endocrinology Diabetes & Metabolism"))).toBe("D004700");
  });

  it("every descriptor_ui is a well-formed MeSH D-code", () => {
    for (const ui of map.values()) expect(ui).toMatch(/^D\d+$/);
  });
});

describe("clinicalMeshMatch (cap-free subsumption)", () => {
  const anchors = [{ specialty: "Cardiology", boardCertified: true, tree: ["C14"] }];

  it("a disease query UNDER the anchor subsumes (sensitivity)", () => {
    // heart failure D006333 → C14.280.434 ; afib D001281 → C14.280.067.198
    expect(clinicalMeshMatch(closureOf("C14.280.434"), anchors)).toEqual({
      specialty: "Cardiology",
      boardCertified: true,
    });
    expect(clinicalMeshMatch(closureOf("C14.280.067.198"), anchors)).not.toBeNull();
  });

  it("an off-area disease does NOT subsume (specificity)", () => {
    // diabetes D003920 → C18.452.394.750 / C19.246 — no C14 in the closure
    expect(clinicalMeshMatch(closureOf("C18.452.394.750", "C19.246"), anchors)).toBeNull();
  });

  it("a sibling tree number does not false-match (dot-boundary)", () => {
    // C140 must not be treated as under C14
    expect(clinicalMeshMatch(closureOf("C140.999"), anchors)).toBeNull();
  });

  it("returns null on empty inputs", () => {
    expect(clinicalMeshMatch([], anchors)).toBeNull();
    expect(clinicalMeshMatch(closureOf("C14.280"), [])).toBeNull();
  });
});
