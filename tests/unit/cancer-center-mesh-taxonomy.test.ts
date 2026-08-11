import { describe, it, expect } from "vitest";
import { buildCodeByUi, isCancerRelated, parseCsv, type Descriptor, type Row } from "@/lib/cancer-center-mesh-taxonomy";

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
