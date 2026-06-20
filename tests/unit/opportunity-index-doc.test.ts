/**
 * GrantRecs Phase 2, Task 5 — pure projection of an `opportunity` MySQL row to
 * its `scholars-opportunities` OpenSearch document (spec §7.2). `topicIds` is the
 * coarse retrieval gate; `topicVector`/`appealByStage` ride along non-indexed.
 */
import { describe, expect, it } from "vitest";

import {
  buildOpportunityDoc,
  OPPORTUNITY_TOPIC_GATE,
  type OpportunityIndexRow,
} from "@/lib/search";

function row(over: Partial<OpportunityIndexRow> = {}): OpportunityIndexRow {
  return {
    opportunityId: "grants_gov:359855",
    title: "Implementation Research",
    synopsis: "synopsis text",
    sponsor: "NIH",
    status: "open",
    mechanism: "R01",
    eligibilityFlags: ["us_eligible", "faculty_eligible"],
    cfdaList: ["93.310"],
    openDate: new Date("2026-01-15"),
    dueDate: new Date("2026-09-01"),
    primaryTopicId: "implementation_science",
    topicVector: [
      { topic_id: "implementation_science", score: 0.97, rationale: "" },
      { topic_id: "biostatistics", score: 0.41, rationale: "" },
      { topic_id: "genomics", score: 0.12, rationale: "" },
    ],
    appealByStage: { grad: 0.2, postdoc: 0.6, early: 0.9, mid: 0.8, senior: 0.5 },
    meshDescriptorUi: ["D000074243"],
    awardCeiling: 500000n,
    numberOfAwards: 6,
    ...over,
  };
}

describe("buildOpportunityDoc", () => {
  it("uses opportunityId as the doc id", () => {
    expect(buildOpportunityDoc(row()).id).toBe("grants_gov:359855");
  });

  it("gates topicIds to scores ≥ threshold", () => {
    const { doc } = buildOpportunityDoc(row());
    expect(doc.topicIds).toEqual(["implementation_science", "biostatistics"]); // 0.12 dropped
    expect(OPPORTUNITY_TOPIC_GATE).toBe(0.3);
  });

  it("carries topicVector and appealByStage verbatim for non-indexed re-rank", () => {
    const { doc } = buildOpportunityDoc(row());
    expect(doc.topicVector).toHaveLength(3); // full vector, ungated
    expect(doc.appealByStage).toEqual({ grad: 0.2, postdoc: 0.6, early: 0.9, mid: 0.8, senior: 0.5 });
  });

  it("serializes dates to ISO and coerces BigInt award to number", () => {
    const { doc } = buildOpportunityDoc(row());
    expect(doc.dueDate).toBe("2026-09-01T00:00:00.000Z");
    expect(doc.awardCeiling).toBe(500000);
  });

  it("omits optional empties cleanly", () => {
    const { doc } = buildOpportunityDoc(
      row({ mechanism: null, dueDate: null, awardCeiling: null, meshDescriptorUi: null }),
    );
    expect(doc.mechanism).toBeUndefined();
    expect(doc.dueDate).toBeUndefined();
    expect(doc.awardCeiling).toBeUndefined();
    expect(doc.meshDescriptorUi).toEqual([]);
  });
});
