/**
 * CORE_CATALOG shape guards. The nightly ETL (etl/dynamodb Block 6) upserts
 * the `core` table from this constant, so a duplicate id, a resurrected
 * retired id, or a stale name lands straight in prod.
 */
import { describe, expect, it } from "vitest";

import { CORE_CATALOG } from "@/etl/dynamodb/core-catalog";

describe("CORE_CATALOG", () => {
  it("has unique ids", () => {
    const ids = CORE_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never carries the retired cores 9 and 12 (facilities that do not exist)", () => {
    const ids = CORE_CATALOG.map((c) => c.id);
    expect(ids).not.toContain("9");
    expect(ids).not.toContain("12");
  });

  it("carries the 2026-10 names", () => {
    const byId = new Map(CORE_CATALOG.map((c) => [c.id, c]));
    expect(byId.get("8")).toMatchObject({ name: "Microbiome Core", facility: "Microbiome Core" });
    expect(byId.get("16")).toMatchObject({
      name: "High Performance Computing",
      facility: "High Performance Computing",
    });
    expect(byId.get("20")).toMatchObject({ name: "Cryo-EM", facility: "Cryo-EM Core" });
    expect(CORE_CATALOG.map((c) => c.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "10",
      "11",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
    ]);
  });
});
