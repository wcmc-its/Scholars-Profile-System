/**
 * #917 v7 — `coerceEntries` backward-compat shim (`lib/edit/biosketch-provenance.ts`). This is the
 * one thing that lets a pre-v7 history row (persisted as a plain `string[]`) keep rendering after
 * entries became `{ title, body }[]`, so it is pinned directly: a legacy string row becomes a
 * title-less entry, a new `{title, body}` object is carried through, and junk is dropped.
 */
import { describe, expect, it } from "vitest";

import { coerceEntries } from "@/lib/edit/biosketch-provenance";

describe("coerceEntries — v7 backward-compat", () => {
  it("coerces a legacy string[] row to title-less entries", () => {
    expect(coerceEntries(["First.", "Second."])).toEqual([
      { title: "", body: "First." },
      { title: "", body: "Second." },
    ]);
  });

  it("carries a new { title, body }[] row through unchanged", () => {
    expect(coerceEntries([{ title: "Subject", body: "Paragraph." }])).toEqual([
      { title: "Subject", body: "Paragraph." },
    ]);
  });

  it("defaults a missing / non-string title to ''", () => {
    expect(coerceEntries([{ body: "B" }, { title: 5, body: "C" }])).toEqual([
      { title: "", body: "B" },
      { title: "", body: "C" },
    ]);
  });

  it("drops malformed members (no string body, non-objects) and non-array values", () => {
    expect(coerceEntries([{ title: "x" }, 7, null, "ok"])).toEqual([{ title: "", body: "ok" }]);
    expect(coerceEntries(null)).toEqual([]);
    expect(coerceEntries("nope")).toEqual([]);
    expect(coerceEntries(undefined)).toEqual([]);
  });
});
