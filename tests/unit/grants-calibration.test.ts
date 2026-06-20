/**
 * GrantRecs Phase 2, Task 9 — fixtures-driven calibration sanity checks (spec
 * §10), end-to-end through the PURE path (mapper → candidates → composite
 * rank), no DB/OpenSearch. Demonstrates the composite working as intended:
 * stage-fit reorders without overriding topic relevance.
 */
import { describe, expect, it } from "vitest";

import { buildOpportunityWrites, type GrantRecordInput } from "@/etl/dynamodb/grant-opportunity-mapper";
import {
  rankCandidates,
  type OpportunityCandidate,
} from "@/lib/api/match-opportunities";
import type { CareerStage } from "@/lib/career-stage";
import sampleGrants from "../fixtures/grants/sample-grants.json";

const FIXTURES = sampleGrants as unknown as GrantRecordInput[];

const NOW = new Date("2026-06-20T00:00:00Z");

/** Turn mapper writes into match candidates (the index doc carries the same payload). */
function candidates(): OpportunityCandidate[] {
  return buildOpportunityWrites(FIXTURES).writes.map((w) => ({
    opportunityId: w.opportunityId,
    title: w.title,
    sponsor: w.sponsor,
    dueDate: w.dueDate,
    status: w.status,
    topicVector: w.topicVector as { topic_id: string; score: number }[],
    appealByStage: w.appealByStage as Partial<Record<CareerStage, number>>,
    meshDescriptorUi: [],
  }));
}

describe("calibration — fixtures end-to-end", () => {
  it("drops the non-research internship at the mapper", () => {
    const { writes, skipped } = buildOpportunityWrites(FIXTURES);
    expect(skipped.nonResearch).toBe(1);
    expect(writes.map((w) => w.opportunityId)).not.toContain("grants_gov:402999");
  });

  it("an early-career neuroscientist sees the K01 ranked above the R01", () => {
    const scholarVec = new Map([["neuroscience", 0.9], ["psychiatry", 0.4]]);
    const ranked = rankCandidates(scholarVec, "early", [], candidates(), { now: NOW });
    expect(ranked[0].opportunityId).toBe("grants_gov:401122"); // K01
    // Both axes present and distinct on the top result.
    expect(ranked[0].axes.topicAffinity).toBeGreaterThan(0);
    expect(ranked[0].axes.stageAppeal).toBe(0.9);
  });

  it("a senior implementation scientist sees the R01 ranked above the K01", () => {
    const scholarVec = new Map([["implementation_science", 0.95], ["health_services_research", 0.4]]);
    const ranked = rankCandidates(scholarVec, "senior", [], candidates(), { now: NOW });
    expect(ranked[0].opportunityId).toBe("grants_gov:359855"); // R01
  });

  it("sort:'deadline' surfaces the soonest-closing opportunity regardless of fit", () => {
    const scholarVec = new Map([["implementation_science", 0.95], ["neuroscience", 0.5]]);
    const ranked = rankCandidates(scholarVec, "early", [], candidates(), { now: NOW, sort: "deadline" });
    expect(ranked[0].opportunityId).toBe("grants_gov:401122"); // K01 due 2026-07-12 < R01 2026-09-01
  });
});
