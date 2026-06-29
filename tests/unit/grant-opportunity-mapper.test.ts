/**
 * GrantRecs Phase 2, Task 2 — pure mapper for ReciterAI `GRANT#` DynamoDB items
 * → `opportunity` rows, plus eligibility-flag derivation. Side-effect-free +
 * unit-tested (mirrors publication-topic-mapper / scholar-tool-mapper), so the
 * parsing/coercion/gating is verifiable without a DDB scan or a DB.
 */
import { describe, expect, it } from "vitest";

import {
  buildOpportunityWrites,
  deriveEligibilityFlags,
  type GrantRecordInput,
} from "@/etl/dynamodb/grant-opportunity-mapper";
import { Prisma } from "@/lib/generated/prisma/client";

/** A representative GRANT# item as the DocumentClient yields it (already unwrapped). */
function grantItem(overrides: Partial<GrantRecordInput> = {}): GrantRecordInput {
  return {
    PK: "GRANT#grants_gov:359855",
    SK: "META",
    opportunity_id: "grants_gov:359855",
    source: "grants_gov",
    source_url: "https://www.grants.gov/search-results-detail/359855",
    sponsor: "National Institutes of Health",
    title: "Dissemination and Implementation Research in Health",
    synopsis: "Supports investigator-initiated research on dissemination and implementation.",
    status: "open",
    open_date: "2026-01-15",
    due_date: "2026-09-01",
    eligibility_raw: "Public/State Controlled Institutions of Higher Education",
    cfda_list: ["93.310"],
    mechanism: "R01",
    award_ceiling: 500000,
    award_floor: 50000,
    estimated_funding: 3000000,
    number_of_awards: 6,
    primary_topic_id: "implementation_science",
    topic_vector: [
      { topic_id: "implementation_science", score: 0.97, rationale: "core focus" },
      { topic_id: "biostatistics", score: 0.41, rationale: "methods" },
    ],
    appeal_by_stage: { grad: 0.2, postdoc: 0.6, early: 0.9, mid: 0.8, senior: 0.5 },
    is_research: true,
    taxonomy_version: "taxonomy_v2",
    ingested_at: "2026-06-19T12:00:00Z",
    ...overrides,
  };
}

describe("buildOpportunityWrites", () => {
  it("maps a GRANT# item to a typed opportunity write", () => {
    const { writes, skipped } = buildOpportunityWrites([grantItem()]);
    expect(skipped).toEqual({ nonResearch: 0, missingFields: 0 });
    expect(writes).toHaveLength(1);
    const w = writes[0];
    expect(w.opportunityId).toBe("grants_gov:359855");
    expect(w.source).toBe("grants_gov");
    expect(w.title).toContain("Dissemination");
    expect(w.isResearch).toBe(true);
  });

  it("parses ISO dates to Date and treats missing due_date as continuous (null)", () => {
    const [w] = buildOpportunityWrites([grantItem({ due_date: "" })]).writes;
    expect(w.openDate).toBeInstanceOf(Date);
    expect(w.openDate?.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(w.dueDate).toBeNull();
  });

  it("coerces award amounts to BigInt and null-missing", () => {
    const [w] = buildOpportunityWrites([
      grantItem({ award_ceiling: 500000, award_floor: null, number_of_awards: 6 }),
    ]).writes;
    expect(w.awardCeiling).toBe(500000n);
    expect(w.awardFloor).toBeNull();
    expect(w.estimatedFunding).toBe(3000000n);
    expect(w.numberOfAwards).toBe(6);
  });

  it("carries topic_vector and appeal_by_stage through verbatim as JSON", () => {
    const [w] = buildOpportunityWrites([grantItem()]).writes;
    expect(w.topicVector).toEqual([
      { topic_id: "implementation_science", score: 0.97, rationale: "core focus" },
      { topic_id: "biostatistics", score: 0.41, rationale: "methods" },
    ]);
    expect(w.appealByStage).toEqual({ grad: 0.2, postdoc: 0.6, early: 0.9, mid: 0.8, senior: 0.5 });
    expect(w.primaryTopicId).toBe("implementation_science");
  });

  it("derives eligibilityFlags onto the write", () => {
    const [w] = buildOpportunityWrites([grantItem()]).writes;
    expect(w.eligibilityFlags).toContain("us_eligible");
    expect(w.eligibilityFlags).toContain("faculty_eligible");
  });

  it("drops is_research=false items with a skip tally", () => {
    const { writes, skipped } = buildOpportunityWrites([
      grantItem({ is_research: true }),
      grantItem({ opportunity_id: "grants_gov:1", PK: "GRANT#grants_gov:1", is_research: false }),
    ]);
    expect(writes).toHaveLength(1);
    expect(skipped.nonResearch).toBe(1);
  });

  it("drops items missing critical fields (id/title/synopsis) with a skip tally", () => {
    const { writes, skipped } = buildOpportunityWrites([
      grantItem({ opportunity_id: "", PK: "GRANT#" }),
      grantItem({ opportunity_id: "grants_gov:2", PK: "GRANT#grants_gov:2", title: "" }),
    ]);
    expect(writes).toHaveLength(0);
    expect(skipped.missingFields).toBe(2);
  });

  it("falls back to parsing opportunity_id from the PK when the field is absent", () => {
    const item = grantItem();
    delete (item as { opportunity_id?: string }).opportunity_id;
    const [w] = buildOpportunityWrites([item]).writes;
    expect(w.opportunityId).toBe("grants_gov:359855");
  });

  it("passes prestige + is_honorific through; JsonNull / null when absent (GRANT# contract v2)", () => {
    const prestige = {
      score: 0.86,
      mechanism_tier: 0.85,
      size_bucket: 0.7,
      sponsor_tier: null,
      selectivity: null,
      label: "Flagship",
      rationale: "R01, NIH",
    };
    const [withP] = buildOpportunityWrites([grantItem({ prestige, is_honorific: true })]).writes;
    expect(withP.prestige).toEqual(prestige);
    expect(withP.isHonorific).toBe(true);

    // Absent upstream → JSON-null (not []), honorific → null (not false): distinct from "ran but empty".
    const [without] = buildOpportunityWrites([grantItem()]).writes;
    expect(without.prestige).toBe(Prisma.JsonNull);
    expect(without.isHonorific).toBeNull();

    // A stray non-object prestige (e.g. array) is rejected, not stored.
    const [bad] = buildOpportunityWrites([grantItem({ prestige: ["nope"], is_honorific: "x" as unknown as boolean })]).writes;
    expect(bad.prestige).toBe(Prisma.JsonNull);
    expect(bad.isHonorific).toBeNull();
  });

  it("parses match_dsl / match_query S-string JSON; JsonNull when absent/malformed (contract v3)", () => {
    // ReciterAI writes these as compact-JSON DynamoDB `S` strings (DocumentClient yields strings).
    const [w] = buildOpportunityWrites([
      grantItem({
        match_dsl: '{"require":["pediatric_cardiology"],"penalize":["health_informatics"]}',
        match_query: '[{"q":"congenital heart","w":1}]',
      }),
    ]).writes;
    expect(w.matchDsl).toEqual({ require: ["pediatric_cardiology"], penalize: ["health_informatics"] });
    expect(w.matchQuery).toEqual([{ q: "congenital heart", w: 1 }]);

    // Absent upstream → JSON-null (matcher stays fail-closed).
    const [without] = buildOpportunityWrites([grantItem()]).writes;
    expect(without.matchDsl).toBe(Prisma.JsonNull);
    expect(without.matchQuery).toBe(Prisma.JsonNull);

    // Malformed string → JsonNull (fail-open, never throws).
    const [bad] = buildOpportunityWrites([grantItem({ match_dsl: "{not json" })]).writes;
    expect(bad.matchDsl).toBe(Prisma.JsonNull);

    // Already-parsed object (future native DDB map) passes through unchanged.
    const [native] = buildOpportunityWrites([grantItem({ match_dsl: { require: ["x"], penalize: [] } })]).writes;
    expect(native.matchDsl).toEqual({ require: ["x"], penalize: [] });
  });
});

describe("deriveEligibilityFlags", () => {
  it("defaults to US + faculty + postdoc eligible for ordinary research eligibility text", () => {
    const flags = deriveEligibilityFlags("Institutions of Higher Education may apply.");
    expect(flags).toContain("us_eligible");
    expect(flags).toContain("faculty_eligible");
    expect(flags).toContain("postdoc_eligible");
    expect(flags).not.toContain("student_only");
  });

  it("flags student_only and withholds faculty_eligible for predoctoral/student-only text", () => {
    const flags = deriveEligibilityFlags(
      "Applicants must be enrolled predoctoral students; dissertation research only.",
    );
    expect(flags).toContain("student_only");
    expect(flags).not.toContain("faculty_eligible");
  });

  it("withholds postdoc_eligible when restricted to independent faculty investigators", () => {
    const flags = deriveEligibilityFlags(
      "Applicant must hold an independent faculty appointment; no postdoctoral fellows.",
    );
    expect(flags).toContain("faculty_eligible");
    expect(flags).not.toContain("postdoc_eligible");
  });

  it("clears us_eligible for foreign-only restrictions", () => {
    const flags = deriveEligibilityFlags("Open to foreign institutions only; non-US organizations.");
    expect(flags).not.toContain("us_eligible");
  });

  it("flags internal_limited_submission", () => {
    const flags = deriveEligibilityFlags(
      "This is a limited submission; only two applications per institution are permitted.",
    );
    expect(flags).toContain("internal_limited_submission");
  });
});
