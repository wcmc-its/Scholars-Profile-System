/**
 * Issue #259 / SPEC §5.4.1 — `extractMeshDescriptorUis` normalizes the
 * `Publication.mesh_terms` JSON column into a deduped string[] of NLM MeSH
 * descriptor UIs (Dnnnnnn), suitable for indexing into the
 * `meshDescriptorUi` keyword field.
 *
 * Unlike `extractMeshLabels` (which accepts both bare-string legacy rows
 * and `{ ui, label }` objects), this extractor only emits UIs from the
 * object shape — bare strings have no UI to extract. Source order is
 * preserved; duplicate UIs are collapsed to a single entry.
 */
import { describe, it, expect } from "vitest";
import { extractMeshDescriptorUis } from "@/etl/search-index/index";

describe("extractMeshDescriptorUis", () => {
  it("returns [] for null / undefined / non-array input", () => {
    expect(extractMeshDescriptorUis(null)).toEqual([]);
    expect(extractMeshDescriptorUis(undefined)).toEqual([]);
    expect(extractMeshDescriptorUis(42)).toEqual([]);
    expect(extractMeshDescriptorUis("D006801")).toEqual([]);
    expect(extractMeshDescriptorUis({ ui: "D006801" })).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(extractMeshDescriptorUis([])).toEqual([]);
  });

  it("returns [] for bare-string rows (legacy shape, no UI field)", () => {
    expect(
      extractMeshDescriptorUis(["Neoplasms", "Humans", "Adenocarcinoma"]),
    ).toEqual([]);
  });

  it("extracts a single UI from one well-formed object", () => {
    expect(
      extractMeshDescriptorUis([{ ui: "D006801", label: "Humans" }]),
    ).toEqual(["D006801"]);
  });

  it("preserves source order across multiple distinct UIs", () => {
    expect(
      extractMeshDescriptorUis([
        { ui: "D006801", label: "Humans" },
        { ui: "D003920", label: "Diabetes Mellitus" },
      ]),
    ).toEqual(["D006801", "D003920"]);
  });

  it("dedupes a UI that appears twice in source (data bug)", () => {
    expect(
      extractMeshDescriptorUis([
        { ui: "D006801", label: "Humans" },
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["D006801"]);
  });

  it("skips bare strings in a mixed array, returning only object UIs", () => {
    expect(
      extractMeshDescriptorUis([
        "Neoplasms",
        { ui: "D006801", label: "Humans" },
        "Adenocarcinoma",
      ]),
    ).toEqual(["D006801"]);
  });

  it("skips objects that are missing the `ui` field", () => {
    expect(
      extractMeshDescriptorUis([
        { label: "Neoplasms" },
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["D006801"]);
  });

  it("skips objects with null / empty / non-string `ui` values", () => {
    expect(
      extractMeshDescriptorUis([
        { ui: null, label: "Neoplasms" },
        { ui: "", label: "Empty" },
        { ui: 42, label: "Numeric" },
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["D006801"]);
  });

  it("returns the UI even when `label` is absent (label is irrelevant)", () => {
    expect(
      extractMeshDescriptorUis([{ ui: "D006801" }]),
    ).toEqual(["D006801"]);
  });
});
