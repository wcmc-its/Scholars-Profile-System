import { describe, it, expect } from "vitest";
import {
  buildCodeByUi,
  buildTaxonomyDetail,
  isCancerRelated,
  matchedCodes,
  parseCsv,
  type Descriptor,
  type Row,
} from "@/lib/cancer-center-mesh-taxonomy";

const descriptors: Descriptor[] = [
  { ui: "D001943", name: "Breast Neoplasms", treeNumbers: ["C04.588.180"] },
  { ui: "D001944", name: "Breast Neoplasms, Male", treeNumbers: ["C04.588.180.500"] },
  { ui: "D008175", name: "Lung Neoplasms", treeNumbers: ["C04.588.894.797.520"] },
  { ui: "D002331", name: "Cardiovascular Diseases", treeNumbers: ["C14"] },
];
const taxonomy: Row[] = [{ code: "BREAST", disease: "Breast Cancer", nlm_descriptor: "Breast Neoplasms", note: "" }];

describe("buildCodeByUi + isCancerRelated", () => {
  it("matches the anchor descriptor and its subtree descendants", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    expect(isCancerRelated(["D001943"], codeByUi)).toBe(true);
    expect(isCancerRelated(["D001944"], codeByUi)).toBe(true); // descendant tree number
  });

  it("does not match descriptors outside the taxonomy", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    expect(isCancerRelated(["D008175"], codeByUi)).toBe(false);
    expect(isCancerRelated(["D002331"], codeByUi)).toBe(false);
  });

  it("a paper with no MeSH tags never matches", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    expect(isCancerRelated([], codeByUi)).toBe(false);
  });

  it("reports an unresolved NLM descriptor name in `missing`", () => {
    const { missing } = buildCodeByUi(descriptors, [
      { code: "X", disease: "X", nlm_descriptor: "Nonexistent Descriptor", note: "" },
    ]);
    expect(missing).toEqual(["Nonexistent Descriptor"]);
  });
});

describe("parseCsv", () => {
  it("parses the real taxonomy CSV header", () => {
    const rows = parseCsv("code,disease,nlm_descriptor,note\nBREAST,Breast Cancer,Breast Neoplasms,\n");
    expect(rows).toEqual([{ code: "BREAST", disease: "Breast Cancer", nlm_descriptor: "Breast Neoplasms", note: "" }]);
  });
});

describe("matchedCodes", () => {
  it("returns the code(s) a paper's MeSH UIs actually matched", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    expect(matchedCodes(["D001943"], codeByUi)).toEqual(["BREAST"]);
    expect(matchedCodes(["D001944"], codeByUi)).toEqual(["BREAST"]); // descendant
  });

  it("returns an empty array when nothing matches — never throws on an unknown UI", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    expect(matchedCodes(["D008175"], codeByUi)).toEqual([]);
    expect(matchedCodes([], codeByUi)).toEqual([]);
  });

  it("dedupes when multiple UIs on the same paper hit the same code", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    expect(matchedCodes(["D001943", "D001944"], codeByUi)).toEqual(["BREAST"]);
  });
});

describe("buildTaxonomyDetail", () => {
  it("groups anchors by code with their real tree number, and counts+samples descendants excluding the anchor itself", () => {
    const { codeByUi } = buildCodeByUi(descriptors, taxonomy);
    const detail = buildTaxonomyDetail(taxonomy, descriptors, codeByUi);
    expect(detail).toEqual([
      {
        code: "BREAST",
        disease: "Breast Cancer",
        anchors: [{ name: "Breast Neoplasms", treeNumber: "C04.588.180" }],
        descendantCount: 1,
        exampleDescendants: ["Breast Neoplasms, Male"],
      },
    ]);
  });

  it("a code with no matched descendants still reports (count 0, no examples)", () => {
    const soloTaxonomy: Row[] = [{ code: "LUNG", disease: "Lung Cancer", nlm_descriptor: "Lung Neoplasms", note: "" }];
    const { codeByUi } = buildCodeByUi(descriptors, soloTaxonomy);
    const detail = buildTaxonomyDetail(soloTaxonomy, descriptors, codeByUi);
    expect(detail).toEqual([
      {
        code: "LUNG",
        disease: "Lung Cancer",
        anchors: [{ name: "Lung Neoplasms", treeNumber: "C04.588.894.797.520" }],
        descendantCount: 0,
        exampleDescendants: [],
      },
    ]);
  });

  it("shows EVERY tree number of a poly-hierarchical anchor, not just the first — a descendant reachable only through the second tree number must still trace back to a visible anchor branch", () => {
    const polyDescriptors: Descriptor[] = [
      // Lives under BOTH C04 (Neoplasms by site) and C08 (Respiratory) — MeSH
      // cross-lists some concepts under more than one branch.
      { ui: "D008175", name: "Lung Neoplasms", treeNumbers: ["C04.588.894.797.520", "C08.785.520"] },
      // Only reachable via the SECOND tree number (the C08 branch).
      { ui: "D055752", name: "Bronchioloalveolar Carcinoma", treeNumbers: ["C08.785.520.150"] },
    ];
    const lungTaxonomy: Row[] = [{ code: "LUNG", disease: "Lung Cancer", nlm_descriptor: "Lung Neoplasms", note: "" }];
    const { codeByUi } = buildCodeByUi(polyDescriptors, lungTaxonomy);
    expect(codeByUi.get("D055752")).toEqual(new Set(["LUNG"])); // classification is correct either way

    const detail = buildTaxonomyDetail(lungTaxonomy, polyDescriptors, codeByUi);
    expect(detail[0].descendantCount).toBe(1);
    expect(detail[0].exampleDescendants).toEqual(["Bronchioloalveolar Carcinoma"]);
    // Both tree numbers must show — the C08 one is the branch that actually
    // produced the match above; showing only C04 would hide it.
    expect(detail[0].anchors).toEqual([
      { name: "Lung Neoplasms", treeNumber: "C04.588.894.797.520" },
      { name: "Lung Neoplasms", treeNumber: "C08.785.520" },
    ]);
  });
});
