/**
 * GrantRecs Phase 2, Task 1 — the `opportunity` Prisma model is registered in
 * the generated client and its row type carries the GRANT#-projected columns
 * (spec §5). Pure: no DB connection — guards schema/codegen drift only.
 */
import { describe, expect, it } from "vitest";

import { Prisma, type Opportunity } from "@/lib/generated/prisma/client";

describe("Opportunity model — codegen", () => {
  it("is registered in the generated Prisma client", () => {
    expect(Prisma.ModelName.Opportunity).toBe("Opportunity");
  });

  it("row type accepts the GRANT#-projected columns", () => {
    // Compile-time guard (must satisfy the generated row type) + runtime asserts.
    const row: Opportunity = {
      opportunityId: "grants_gov:359855",
      source: "grants_gov",
      sourceUrl: "https://www.grants.gov/search-results-detail/359855",
      sponsor: "National Institutes of Health",
      title: "Dissemination and Implementation Research in Health",
      synopsis: "full synopsis text",
      status: "open",
      openDate: null,
      dueDate: new Date("2026-09-01"),
      eligibilityRaw: "Public/State Controlled Institutions of Higher Education",
      eligibilityFlags: ["us_eligible", "faculty_eligible"],
      cfdaList: ["93.310"],
      mechanism: "R01",
      awardCeiling: 500000n,
      awardFloor: null,
      estimatedFunding: 3000000n,
      numberOfAwards: 6,
      primaryTopicId: "implementation_science",
      topicVector: [{ topic_id: "implementation_science", score: 0.97, rationale: "" }],
      appealByStage: { grad: 0.2, postdoc: 0.6, early: 0.9, mid: 0.8, senior: 0.5 },
      isResearch: true,
      meshDescriptorUi: ["D000074243"],
      taxonomyVersion: "taxonomy_v2",
      ingestedAt: new Date(),
      lastRefreshedAt: new Date(),
    };

    expect(row.opportunityId).toBe("grants_gov:359855");
    expect(row.isResearch).toBe(true);
    expect(row.awardCeiling).toBe(500000n);
    expect(Array.isArray(row.eligibilityFlags)).toBe(true);
  });
});
