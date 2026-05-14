/**
 * `extractMeshLabels` is the choke point for normalizing the
 * `Publication.mesh_terms` JSON column into a flat string[] for indexing.
 *
 * History: the column shape shifted from bare strings to `{ ui, label }`
 * objects. The pre-helper indexer filtered to `typeof x === "string"`,
 * which silently dropped every object-shaped row and shipped every doc to
 * OpenSearch with `meshTerms: ""`. The helper must accept both shapes so
 * a partial migration on the source side doesn't lose terms again.
 */
import { describe, it, expect } from "vitest";
import { extractMeshLabels } from "@/etl/search-index/index";

describe("extractMeshLabels", () => {
  it("returns [] for null / undefined / non-array input", () => {
    expect(extractMeshLabels(null)).toEqual([]);
    expect(extractMeshLabels(undefined)).toEqual([]);
    expect(extractMeshLabels("Neoplasms")).toEqual([]);
    expect(extractMeshLabels({ label: "Neoplasms" })).toEqual([]);
    expect(extractMeshLabels(42)).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(extractMeshLabels([])).toEqual([]);
  });

  it("accepts bare-string rows (legacy shape)", () => {
    expect(
      extractMeshLabels(["Neoplasms", "Adenocarcinoma", "Humans"]),
    ).toEqual(["Neoplasms", "Adenocarcinoma", "Humans"]);
  });

  it("extracts `label` from object rows ({ ui, label } shape)", () => {
    expect(
      extractMeshLabels([
        { ui: "D009369", label: "Neoplasms" },
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["Neoplasms", "Humans"]);
  });

  it("handles a mixed array (partial migration on the source side)", () => {
    expect(
      extractMeshLabels([
        "Neoplasms",
        { ui: "D006801", label: "Humans" },
        "Adenocarcinoma",
      ]),
    ).toEqual(["Neoplasms", "Humans", "Adenocarcinoma"]);
  });

  it("drops empty-string labels and empty bare strings", () => {
    expect(
      extractMeshLabels(["", "Neoplasms", { ui: "Dxxx", label: "" }]),
    ).toEqual(["Neoplasms"]);
  });

  it("drops malformed object rows (missing label, non-string label, null)", () => {
    expect(
      extractMeshLabels([
        { ui: "D009369" }, // missing label
        { ui: "Dxxx", label: null }, // null label
        { ui: "Dxxx", label: 42 }, // non-string label
        null, // null element
        { label: "Carcinoma" }, // missing ui is fine — only label matters
      ]),
    ).toEqual(["Carcinoma"]);
  });

  // Issue #259 / PR 1 of MeSH defaults rebalance — adjacent edit adds the new
  // `extractMeshDescriptorUis` extractor to the same module. This snapshot-
  // style assertion locks the names-extraction shape against an unintended
  // refactor of `extractMeshLabels` slipping through under the same PR.
  it("locks the canonical { ui, label } × 5 fixture against accidental drift", () => {
    expect(
      extractMeshLabels([
        { ui: "D006801", label: "Humans" },
        { ui: "D009369", label: "Neoplasms" },
        { ui: "D003920", label: "Diabetes Mellitus" },
        { ui: "D006973", label: "Hypertension" },
        { ui: "D000368", label: "Aged" },
      ]),
    ).toEqual([
      "Humans",
      "Neoplasms",
      "Diabetes Mellitus",
      "Hypertension",
      "Aged",
    ]);
  });
});
