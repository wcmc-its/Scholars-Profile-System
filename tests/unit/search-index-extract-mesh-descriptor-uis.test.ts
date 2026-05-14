/**
 * Issue #259 / SPEC §5.4.1 — `extractMeshDescriptorUis` is the choke point for
 * deriving the new `meshDescriptorUi` keyword field on each publication doc.
 *
 * Invariants under test (mirrors the SPEC §8.2 table for this extractor):
 *
 *   - Returns `[]` for non-array / nullish input.
 *   - Returns `[]` for legacy bare-string rows (those rows have no UIs).
 *   - Extracts the literal `Dnnnnnn` UI from `{ ui, label }` object rows.
 *   - Source order is preserved; duplicates in the source are deduped.
 *   - Defensive: rows missing a valid string `ui` are dropped (should be
 *     unreachable under the ETL contract per #278, but kept for safety).
 *   - `label` is irrelevant to this extractor; absence does not affect UI emit.
 */
import { describe, it, expect } from "vitest";
import { extractMeshDescriptorUis } from "@/etl/search-index/index";

describe("extractMeshDescriptorUis", () => {
  it("returns [] for null / undefined / non-array input", () => {
    expect(extractMeshDescriptorUis(null)).toEqual([]);
    expect(extractMeshDescriptorUis(undefined)).toEqual([]);
    expect(extractMeshDescriptorUis("D006801")).toEqual([]);
    expect(extractMeshDescriptorUis(42)).toEqual([]);
    expect(extractMeshDescriptorUis({ ui: "D006801" })).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(extractMeshDescriptorUis([])).toEqual([]);
  });

  it("returns [] for legacy bare-string rows (no UI to extract)", () => {
    expect(
      extractMeshDescriptorUis(["Neoplasms", "Humans", "Adenocarcinoma"]),
    ).toEqual([]);
  });

  it("extracts the UI from a single { ui, label } object", () => {
    expect(
      extractMeshDescriptorUis([{ ui: "D006801", label: "Humans" }]),
    ).toEqual(["D006801"]);
  });

  it("extracts two distinct UIs in source order", () => {
    expect(
      extractMeshDescriptorUis([
        { ui: "D006801", label: "Humans" },
        { ui: "D003920", label: "Diabetes Mellitus" },
      ]),
    ).toEqual(["D006801", "D003920"]);
  });

  it("dedupes a duplicate UI in the source (data bug)", () => {
    expect(
      extractMeshDescriptorUis([
        { ui: "D006801", label: "Humans" },
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["D006801"]);
  });

  it("skips bare-string rows in a mixed array; returns only object UIs", () => {
    expect(
      extractMeshDescriptorUis([
        "Neoplasms",
        { ui: "D006801", label: "Humans" },
        "Adenocarcinoma",
      ]),
    ).toEqual(["D006801"]);
  });

  it("skips objects missing the `ui` field; returns others", () => {
    expect(
      extractMeshDescriptorUis([
        { label: "Neoplasms" }, // missing ui
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["D006801"]);
  });

  it("skips objects with `ui: null` / `ui: \"\"` / `ui: 42`; returns others", () => {
    expect(
      extractMeshDescriptorUis([
        { ui: null, label: "Neoplasms" },
        { ui: "", label: "Humans" },
        { ui: 42, label: "Carcinoma" },
        { ui: "D006801", label: "Humans" },
      ]),
    ).toEqual(["D006801"]);
  });

  it("returns the UI even when `label` is absent (label is irrelevant here)", () => {
    expect(
      extractMeshDescriptorUis([{ ui: "D006801" }]),
    ).toEqual(["D006801"]);
  });
});
