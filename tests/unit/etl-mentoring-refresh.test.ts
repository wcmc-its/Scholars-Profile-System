import { describe, expect, it } from "vitest";
import { BRIDGE_STEPS, bridgeKeys } from "@/etl/mentoring/refresh";

describe("etl:mentoring:refresh", () => {
  it("scopes every bridge key under the env", () => {
    const keys = bridgeKeys("prod");
    expect(Object.keys(keys).sort()).toEqual([
      "MENTORING_AOC_KEY",
      "MENTORING_COPUBS_KEY",
      "MENTORING_COPUB_LIST_KEY",
      "MENTORING_LEARNER_PUBS_KEY",
      "PUBLICATION_CITING_KEY",
    ]);
    for (const k of Object.values(keys)) expect(k).toMatch(/^(mentoring|citations)\/prod\/[a-z-]+\.ndjson$/);
    expect(bridgeKeys("staging").MENTORING_COPUBS_KEY).not.toBe(keys.MENTORING_COPUBS_KEY);
  });

  it("rejects an env that could escape its prefix", () => {
    expect(() => bridgeKeys("../prod")).toThrow();
    expect(() => bridgeKeys("")).toThrow();
  });

  it("runs both exports before any import", () => {
    const lastExport = Math.max(...BRIDGE_STEPS.map((s, i) => (s.includes(":export-") ? i : -1)));
    const firstImport = BRIDGE_STEPS.findIndex((s) => s.includes(":import-"));
    expect(lastExport).toBeLessThan(firstImport);
  });
});
