import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildTopicDetail,
  isCancerRelated,
  matchedTopics,
  matchedUis,
  type TaxonomyLookup,
} from "@/lib/cancer-taxonomy";

function lookup(topicsByUi: Record<string, string[]>, nameByUi: Record<string, string> = {}): TaxonomyLookup {
  return { topicsByUi: new Map(Object.entries(topicsByUi)), nameByUi: new Map(Object.entries(nameByUi)) };
}

describe("isCancerRelated", () => {
  it("matches a UI present in the taxonomy, including one with empty (unassigned) topics", () => {
    const l = lookup({ D001943: ["breast"], D999999: [] });
    expect(isCancerRelated(["D001943"], l)).toBe(true);
    expect(isCancerRelated(["D999999"], l)).toBe(true);
  });

  it("does not match a UI outside the taxonomy", () => {
    const l = lookup({ D001943: ["breast"] });
    expect(isCancerRelated(["D008175"], l)).toBe(false);
  });

  it("a paper with no MeSH tags never matches", () => {
    const l = lookup({ D001943: ["breast"] });
    expect(isCancerRelated([], l)).toBe(false);
  });
});

describe("matchedUis", () => {
  it("returns every matching UI, preserving input order — no dedup/rollup, unlike matchedTopics", () => {
    const l = lookup({ D001943: ["breast"], D001944: ["breast"] });
    expect(matchedUis(["D001943", "D001944"], l)).toEqual(["D001943", "D001944"]);
  });

  it("drops any UI that doesn't fall in the taxonomy", () => {
    const l = lookup({ D001943: ["breast"] });
    expect(matchedUis(["D008175", "D001943", "D002331"], l)).toEqual(["D001943"]);
  });

  it("returns an empty array for a paper with no MeSH tags, or none in the taxonomy", () => {
    const l = lookup({ D001943: ["breast"] });
    expect(matchedUis([], l)).toEqual([]);
    expect(matchedUis(["D008175"], l)).toEqual([]);
  });
});

describe("matchedTopics", () => {
  it("returns every distinct topic across all matched UIs, sorted and deduped", () => {
    const l = lookup({ D1: ["breast", "cc-biology"], D2: ["breast"] });
    expect(matchedTopics(["D1", "D2"], l)).toEqual(["breast", "cc-biology"]);
  });

  it("a single descriptor can contribute more than one topic — multi-valued facet, intentional", () => {
    const l = lookup({ D1: ["breast", "cc-therapeutics"] });
    expect(matchedTopics(["D1"], l)).toEqual(["breast", "cc-therapeutics"]);
  });

  it("a matched descriptor with an empty topics array contributes the literal 'unassigned'", () => {
    const l = lookup({ D1: [] });
    expect(matchedTopics(["D1"], l)).toEqual(["unassigned"]);
  });

  it("returns an empty array when nothing matches, never throws on an unknown UI", () => {
    const l = lookup({ D1: ["breast"] });
    expect(matchedTopics(["D999"], l)).toEqual([]);
    expect(matchedTopics([], l)).toEqual([]);
  });
});

describe("buildTopicDetail", () => {
  it("groups descriptors by topic, resolves display names, sorts names within a group, and sorts groups by topic", () => {
    const l = lookup(
      { D1: ["breast"], D2: ["breast"], D3: ["lung"] },
      { D1: "Breast Neoplasms", D2: "Breast Neoplasms, Male", D3: "Lung Neoplasms" },
    );
    expect(buildTopicDetail(l)).toEqual([
      { topic: "breast", descriptorCount: 2, exampleDescriptors: ["Breast Neoplasms", "Breast Neoplasms, Male"] },
      { topic: "lung", descriptorCount: 1, exampleDescriptors: ["Lung Neoplasms"] },
    ]);
  });

  it("groups an empty-topics descriptor under the 'unassigned' bucket", () => {
    const l = lookup({ D1: [] }, { D1: "Some Descriptor" });
    expect(buildTopicDetail(l)).toEqual([
      { topic: "unassigned", descriptorCount: 1, exampleDescriptors: ["Some Descriptor"] },
    ]);
  });

  it("falls back to the raw ui when a display name is somehow missing", () => {
    const l = lookup({ D1: ["breast"] });
    expect(buildTopicDetail(l)).toEqual([{ topic: "breast", descriptorCount: 1, exampleDescriptors: ["D1"] }]);
  });

  it("caps examples at 8 but still reports the true descriptorCount", () => {
    const topicsByUi: Record<string, string[]> = {};
    const nameByUi: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      topicsByUi[`D${i}`] = ["breast"];
      nameByUi[`D${i}`] = `Name ${i}`;
    }
    const detail = buildTopicDetail(lookup(topicsByUi, nameByUi));
    expect(detail).toHaveLength(1);
    expect(detail[0].descriptorCount).toBe(10);
    expect(detail[0].exampleDescriptors).toHaveLength(8);
  });

  it("a descriptor with multiple topics appears once under EACH topic group — never summed to one total", () => {
    const l = lookup({ D1: ["breast", "cc-biology"] }, { D1: "Breast Neoplasms" });
    const detail = buildTopicDetail(l);
    expect(detail.map((d) => d.topic)).toEqual(["breast", "cc-biology"]);
    expect(detail.every((d) => d.exampleDescriptors.includes("Breast Neoplasms"))).toBe(true);
  });
});

describe("loadCancerTaxonomy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("filters to cancerRelevant:true, narrows the JSON topics blob defensively, and resolves names for exactly the matched UI set", async () => {
    const { loadCancerTaxonomy } = await import("@/lib/cancer-taxonomy");
    const taxonomyDb = {
      findMany: vi.fn().mockResolvedValue([
        { descriptorUi: "D1", topics: ["breast", 42, null, "cc-biology"] }, // non-string entries dropped
        { descriptorUi: "D2", topics: "not-an-array" }, // wrong shape entirely -> []
      ]),
    };
    const meshDb = {
      findMany: vi.fn().mockResolvedValue([
        { descriptorUi: "D1", name: "Breast Neoplasms" },
        { descriptorUi: "D2", name: "Other Descriptor" },
      ]),
    };

    const result = await loadCancerTaxonomy(taxonomyDb, meshDb);

    expect(taxonomyDb.findMany).toHaveBeenCalledWith({
      where: { cancerRelevant: true },
      select: { descriptorUi: true, topics: true },
    });
    expect(result.topicsByUi.get("D1")).toEqual(["breast", "cc-biology"]);
    expect(result.topicsByUi.get("D2")).toEqual([]);
    expect(meshDb.findMany).toHaveBeenCalledWith({
      where: { descriptorUi: { in: ["D1", "D2"] } },
      select: { descriptorUi: true, name: true },
    });
    expect(result.nameByUi.get("D1")).toBe("Breast Neoplasms");
  });

  it("skips the name query entirely when the matched UI set is empty", async () => {
    const { loadCancerTaxonomy } = await import("@/lib/cancer-taxonomy");
    const taxonomyDb = { findMany: vi.fn().mockResolvedValue([]) };
    const meshDb = { findMany: vi.fn() };

    const result = await loadCancerTaxonomy(taxonomyDb, meshDb);

    expect(result.topicsByUi.size).toBe(0);
    expect(result.nameByUi.size).toBe(0);
    expect(meshDb.findMany).not.toHaveBeenCalled();
  });

  it("caches for the process lifetime — a second call does not re-query either table", async () => {
    const { loadCancerTaxonomy } = await import("@/lib/cancer-taxonomy");
    const taxonomyDb = { findMany: vi.fn().mockResolvedValue([{ descriptorUi: "D1", topics: ["breast"] }]) };
    const meshDb = { findMany: vi.fn().mockResolvedValue([{ descriptorUi: "D1", name: "Breast Neoplasms" }]) };

    await loadCancerTaxonomy(taxonomyDb, meshDb);
    await loadCancerTaxonomy(taxonomyDb, meshDb);

    expect(taxonomyDb.findMany).toHaveBeenCalledTimes(1);
    expect(meshDb.findMany).toHaveBeenCalledTimes(1);
  });
});
