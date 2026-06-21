/**
 * #1166 — pure mapper for the ReciterAI entity layer (entities.json /
 * entity_context.json) → family_entity + family_entity_usage rows. ADR-005
 * suppression, evidenced recompute, span guards, malformed/orphan handling.
 * Verifiable without an S3 fetch or a DB.
 */
import { describe, expect, it } from "vitest";

import {
  buildFamilyEntityWritesFromS3,
  type FamilyEntityArtifact,
} from "@/etl/tools/family-entity-mapper-s3";
import type { PublicationSuppressions } from "@/lib/api/manual-layer";

function artifact(): FamilyEntityArtifact {
  return {
    entities: [
      {
        normalized_entity_id: "tool_1",
        entity_label: "3T3-L1 adipocytes",
        supercategory: "animal_cell_models",
        family_label: "Immortalized cell lines",
        parent_entity_id: "ent_abc",
        parent_descriptor: "mouse fibroblast line",
        entity_role: null,
        usage_count: 4,
        evidenced: true,
      },
      {
        normalized_entity_id: "tool_2",
        entity_label: "3T3-L1 preadipocytes",
        supercategory: "animal_cell_models",
        family_label: "Immortalized cell lines",
        parent_entity_id: "ent_abc",
        parent_descriptor: "mouse fibroblast line",
        entity_role: null,
        usage_count: 3,
        evidenced: true,
      },
      {
        // ranked but NO context — evidenced must be recomputed to false.
        normalized_entity_id: "tool_3",
        entity_label: "HEK293T cells",
        supercategory: "animal_cell_models",
        family_label: "Immortalized cell lines",
        parent_entity_id: null,
        parent_descriptor: null,
        entity_role: null,
        usage_count: 2,
        evidenced: true,
      },
    ],
    entityContext: {
      tool_1: {
        "32991178": [
          { usage_sentence: "profiling of 3T3-L1 adipocyte differentiation", span: [13, 19], centrality_score: 0.37, role: null },
        ],
        "38000000": [
          { usage_sentence: "treated 3T3-L1 adipocytes with metformin", span: [8, 25], centrality_score: 0.2, role: null },
        ],
      },
      tool_2: {
        "33672392": [
          { usage_sentence: "senescence in 3T3-L1 preadipocytes", span: [14, 34], centrality_score: 0.41, role: null },
        ],
      },
      // an orphan fact — no DIMENSION record for tool_999.
      tool_999: { "40000000": [{ usage_sentence: "ghost", span: null, centrality_score: null, role: null }] },
    },
  };
}

const noSuppression: PublicationSuppressions = { darkPmids: new Set(), hiddenAuthorsByPmid: new Map() };

describe("buildFamilyEntityWritesFromS3", () => {
  it("projects the dimension + facts and reports orphans", () => {
    const r = buildFamilyEntityWritesFromS3(artifact(), { suppression: noSuppression });
    expect(r.entityWrites.map((e) => e.normalizedEntityId)).toEqual(["tool_1", "tool_2", "tool_3"]);
    expect(r.usageWrites).toHaveLength(3); // tool_1 x2 + tool_2 x1 (orphan excluded)
    expect(r.orphanFacts).toBe(1);
    // usage_count is verbatim (institution-wide), NOT len(facts).
    const e1 = r.entityWrites.find((e) => e.normalizedEntityId === "tool_1")!;
    expect(e1.usageCount).toBe(4);
    // a fact carries the family identity + span + centrality.
    const f = r.usageWrites.find((u) => u.pmid === "32991178")!;
    expect(f.familyLabel).toBe("Immortalized cell lines");
    expect([f.matchedSpanStart, f.matchedSpanEnd]).toEqual([13, 19]);
    expect(f.centralityScore).toBe(0.37);
  });

  it("recomputes evidenced from surviving facts", () => {
    const r = buildFamilyEntityWritesFromS3(artifact(), { suppression: noSuppression });
    const ev = Object.fromEntries(r.entityWrites.map((e) => [e.normalizedEntityId, e.evidenced]));
    expect(ev).toEqual({ tool_1: true, tool_2: true, tool_3: false }); // tool_3 has no context
  });

  it("drops dark-pmid facts (ADR-005) and downgrades evidenced", () => {
    const suppression: PublicationSuppressions = {
      darkPmids: new Set(["32991178", "38000000"]), // both of tool_1's papers
      hiddenAuthorsByPmid: new Map(),
    };
    const r = buildFamilyEntityWritesFromS3(artifact(), { suppression });
    expect(r.suppressedFacts).toBe(2);
    expect(r.usageWrites.some((u) => u.normalizedEntityId === "tool_1")).toBe(false);
    // tool_1 is still ranked (count 4) but no longer clickable.
    const e1 = r.entityWrites.find((e) => e.normalizedEntityId === "tool_1")!;
    expect(e1.usageCount).toBe(4);
    expect(e1.evidenced).toBe(false);
    // tool_2 unaffected.
    expect(r.entityWrites.find((e) => e.normalizedEntityId === "tool_2")!.evidenced).toBe(true);
  });

  it("nulls an out-of-range or malformed span (term-match fallback)", () => {
    const art: FamilyEntityArtifact = {
      entities: [
        { normalized_entity_id: "tool_x", entity_label: "HeLa cells", supercategory: "animal_cell_models",
          family_label: "Cancer cell lines", usage_count: 1 },
      ],
      entityContext: {
        tool_x: {
          "1": [{ usage_sentence: "short", span: [2, 99], centrality_score: null, role: null }], // end > len
          "2": [{ usage_sentence: "HeLa here", span: [0, 4], centrality_score: null, role: null }], // valid
        },
      },
    };
    const r = buildFamilyEntityWritesFromS3(art);
    const bad = r.usageWrites.find((u) => u.pmid === "1")!;
    const good = r.usageWrites.find((u) => u.pmid === "2")!;
    expect([bad.matchedSpanStart, bad.matchedSpanEnd]).toEqual([null, null]);
    expect([good.matchedSpanStart, good.matchedSpanEnd]).toEqual([0, 4]);
  });

  it("skips malformed entity records", () => {
    const art: FamilyEntityArtifact = {
      entities: [
        { normalized_entity_id: "", entity_label: "x", supercategory: "s", family_label: "f", usage_count: 1 },
        { normalized_entity_id: "ok", entity_label: "Y", supercategory: "s", family_label: "f", usage_count: 2 },
        { normalized_entity_id: "nocount", entity_label: "Z", supercategory: "s", family_label: "f" },
      ],
      entityContext: {},
    };
    const r = buildFamilyEntityWritesFromS3(art);
    expect(r.skippedMalformedEntities).toBe(2);
    expect(r.entityWrites.map((e) => e.normalizedEntityId)).toEqual(["ok"]);
  });
});
