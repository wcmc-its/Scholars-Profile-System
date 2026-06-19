/**
 * #794 — pure mapper for the A2 canonical tools taxonomy → scholar_tool rows.
 * Joins faculty rollup entries to canonical tools[] by canonical_tool_id, derives
 * category (method_family_label) + maxConfidence (salience_tier), FK-scope +
 * field guards, merge-by-name, top-N. Verifiable without an S3 fetch or a DB.
 */
import { describe, expect, it } from "vitest";

import {
  buildScholarToolWritesFromS3,
  tierToConfidence,
  TIER_CONFIDENCE,
  type ToolsArtifactSlice,
} from "@/etl/tools/scholar-tool-mapper-s3";
import { buildToolContextIndex } from "@/etl/tools/tool-context";

/** Build a minimal artifact slice from tool records + a per-cwid tool list. */
function artifact(
  tools: ToolsArtifactSlice["tools"],
  faculty: Record<
    string,
    Array<{ canonical_tool_id: string; display_name?: string; pub_count?: number }>
  >,
): ToolsArtifactSlice {
  return {
    tools,
    faculty: Object.fromEntries(
      Object.entries(faculty).map(([cwid, list]) => [cwid, { cwid, tools: list }]),
    ),
  };
}

describe("buildScholarToolWritesFromS3 — canonical join", () => {
  it("emits one row per (cwid, tool) with canonical name, family category, tier confidence", () => {
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          {
            canonical_tool_id: "tool_1",
            display_name: "C57BL/6 mouse",
            method_family_label: "Inbred mouse models",
            salience_tier: "S",
          },
        ],
        { aog: [{ canonical_tool_id: "tool_1", display_name: "C57BL_6 mouse", pub_count: 7 }] },
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toEqual([
      {
        cwid: "aog",
        toolName: "C57BL/6 mouse", // canonical tools[] name, NOT the slug-mangled faculty-side name
        category: "Inbred mouse models",
        pmidCount: 7, // faculty pub_count
        maxConfidence: 0.9, // tier S
        sampleContext: null,
        pmids: [],
      },
    ]);
  });

  it("uses the canonical display_name even when the faculty entry omits one", () => {
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [{ canonical_tool_id: "tool_9", display_name: "Flow cytometry", salience_tier: "A" }],
        { aog: [{ canonical_tool_id: "tool_9", pub_count: 3 }] },
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0]).toMatchObject({
      toolName: "Flow cytometry",
      category: null,
      maxConfidence: 0.7,
    });
  });
});

describe("buildScholarToolWritesFromS3 — guards", () => {
  it("skips scholars whose cwid is out of FK scope", () => {
    const res = buildScholarToolWritesFromS3(
      artifact([{ canonical_tool_id: "tool_1", display_name: "X", salience_tier: "B" }], {
        stranger: [{ canonical_tool_id: "tool_1", pub_count: 1 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingCwid).toBe(1);
  });

  it("falls back to the faculty display_name when the tool id is unknown (category null, weakest tier)", () => {
    const res = buildScholarToolWritesFromS3(
      artifact([], {
        aog: [{ canonical_tool_id: "ghost", display_name: "Mystery assay", pub_count: 2 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes[0]).toMatchObject({
      toolName: "Mystery assay",
      category: null,
      maxConfidence: tierToConfidence(null),
    });
    expect(res.unknownToolFallback).toBe(1);
  });

  it("drops entries with no resolvable display name", () => {
    const res = buildScholarToolWritesFromS3(
      artifact([], { aog: [{ canonical_tool_id: "ghost", pub_count: 4 }] }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(res.writes).toEqual([]);
    expect(res.skippedMissingFields).toBe(1);
  });
});

describe("buildScholarToolWritesFromS3 — ranking + merge", () => {
  it("keeps the top tools per scholar by (pmidCount, then tier)", () => {
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          { canonical_tool_id: "a", display_name: "A", salience_tier: "B" },
          { canonical_tool_id: "b", display_name: "B", salience_tier: "S" },
          { canonical_tool_id: "c", display_name: "C", salience_tier: "S" },
        ],
        {
          aog: [
            { canonical_tool_id: "a", pub_count: 3 }, // most papers
            { canonical_tool_id: "b", pub_count: 2 }, // tie broken by tier vs c
            { canonical_tool_id: "c", pub_count: 2 },
          ],
        },
      ),
      { ourCwidSet: new Set(["aog"]), topNPerScholar: 2 },
    );
    expect(writes.map((w) => w.toolName)).toEqual(["A", "B"]); // C dropped (same papers as B, same tier; A leads on papers)
    expect(writes.map((w) => w.pmidCount)).toEqual([3, 2]);
  });

  it("merges two ids that collapse to one display name (max pub_count, max tier)", () => {
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          { canonical_tool_id: "x1", display_name: "Western blot", salience_tier: "B" },
          { canonical_tool_id: "x2", display_name: "Western blot", salience_tier: "A" },
        ],
        {
          aog: [
            { canonical_tool_id: "x1", pub_count: 4 },
            { canonical_tool_id: "x2", pub_count: 9 },
          ],
        },
      ),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ toolName: "Western blot", pmidCount: 9, maxConfidence: 0.7 });
  });
});

describe("tierToConfidence", () => {
  it("is monotone S > A > B > C > unknown and stays within Decimal(5,4) [0,1]", () => {
    const ladder = [
      TIER_CONFIDENCE.S,
      TIER_CONFIDENCE.A,
      TIER_CONFIDENCE.B,
      TIER_CONFIDENCE.C,
      tierToConfidence(null),
    ];
    expect(ladder).toEqual([0.9, 0.7, 0.5, 0.3, 0.1]);
    const sorted = [...ladder].sort((a, b) => b - a);
    expect(ladder).toEqual(sorted); // already strictly descending
    for (const v of ladder) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(tierToConfidence("Z")).toBe(0.1); // unrecognized tier → unknown floor
  });
});

describe("buildScholarToolWritesFromS3 — #1119 sample context", () => {
  it("populates sampleContext from the tool's best snippet (keyed by canonical id)", () => {
    const toolContext = buildToolContextIndex({
      tool_1: {
        "111":
          "cloudrnaSPAdes assembles full-length isoforms from barcoded RNA-seq linked-read data in a reference-free fashion",
        "222": "short", // junk
      },
    });
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [{ canonical_tool_id: "tool_1", display_name: "cloudrnaSPAdes", salience_tier: "A" }],
        { aog: [{ canonical_tool_id: "tool_1", pub_count: 3 }] },
      ),
      { ourCwidSet: new Set(["aog"]), toolContext },
    );
    expect(writes[0].sampleContext).toContain("full-length isoforms");
  });

  it("leaves sampleContext null when no toolContext index is supplied", () => {
    const { writes } = buildScholarToolWritesFromS3(
      artifact([{ canonical_tool_id: "tool_1", display_name: "X", salience_tier: "A" }], {
        aog: [{ canonical_tool_id: "tool_1", pub_count: 3 }],
      }),
      { ourCwidSet: new Set(["aog"]) },
    );
    expect(writes[0].sampleContext).toBeNull();
  });

  it("#1119 opaque gate: suppresses sampleContext for a high-frequency tool (canonical pub_count)", () => {
    const toolContext = buildToolContextIndex({
      tool_1: {
        "111":
          "RNA-seq analysis of E. coli K12 revealed 447 differentially expressed genes across conditions",
      },
    });
    // Canonical GLOBAL pub_count is the gate signal — NOT the per-scholar faculty count.
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          {
            canonical_tool_id: "tool_1",
            display_name: "RNA-seq",
            salience_tier: "S",
            pub_count: 900,
          },
        ],
        { aog: [{ canonical_tool_id: "tool_1", pub_count: 8 }] },
      ),
      { ourCwidSet: new Set(["aog"]), toolContext },
    );
    expect(writes[0].sampleContext).toBeNull();
  });

  it("#1119 opaque gate: keeps sampleContext for a niche tool with a low canonical pub_count", () => {
    const toolContext = buildToolContextIndex({
      tool_1: {
        "111":
          "wsPurity quantifies tumor purity within a digitally captured H&E stained histological slide",
      },
    });
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          {
            canonical_tool_id: "tool_1",
            display_name: "wsPurity",
            salience_tier: "B",
            pub_count: 2,
          },
        ],
        { aog: [{ canonical_tool_id: "tool_1", pub_count: 2 }] },
      ),
      { ourCwidSet: new Set(["aog"]), toolContext },
    );
    expect(writes[0].sampleContext).toContain("tumor purity");
  });

  it("#1119 ADR-005: suppresses sampleContext when the source pmid is a whole-publication takedown", () => {
    const toolContext = buildToolContextIndex({
      tool_1: {
        "111":
          "wsPurity quantifies tumor purity within a digitally captured H&E stained histological slide",
      },
    });
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          {
            canonical_tool_id: "tool_1",
            display_name: "wsPurity",
            salience_tier: "B",
            pub_count: 2,
          },
        ],
        { aog: [{ canonical_tool_id: "tool_1", pub_count: 2 }] },
      ),
      {
        ourCwidSet: new Set(["aog"]),
        toolContext,
        suppression: { darkPmids: new Set(["111"]), hiddenAuthorsByPmid: new Map() },
      },
    );
    expect(writes[0].sampleContext).toBeNull();
  });

  it("#1119 ADR-005: a per-author hide does NOT affect the global sampleContext (dark-only)", () => {
    const toolContext = buildToolContextIndex({
      tool_1: {
        "111":
          "wsPurity quantifies tumor purity within a digitally captured H&E stained histological slide",
      },
    });
    const { writes } = buildScholarToolWritesFromS3(
      artifact(
        [
          {
            canonical_tool_id: "tool_1",
            display_name: "wsPurity",
            salience_tier: "B",
            pub_count: 2,
          },
        ],
        { aog: [{ canonical_tool_id: "tool_1", pub_count: 2 }] },
      ),
      {
        ourCwidSet: new Set(["aog"]),
        toolContext,
        suppression: {
          darkPmids: new Set(),
          hiddenAuthorsByPmid: new Map([["111", new Set(["aog"])]]),
        },
      },
    );
    expect(writes[0].sampleContext).toContain("tumor purity");
  });
});
