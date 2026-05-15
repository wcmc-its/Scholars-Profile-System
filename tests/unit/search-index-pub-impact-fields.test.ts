/**
 * Issue #259 §1.8 (migrated in #316 PR-B) — `buildPubImpactFields` derives
 * the doc-level `impactScore` (sortable, sourced from Publication.impactScore)
 * and `topicImpacts` (per-topic MAX over publication_topic.impact_score rows,
 * used by the API for the "Concept impact" badge).
 *
 * Invariants under test:
 *   - publicationImpactScore null AND no non-null topic rows → empty object.
 *   - publicationImpactScore null + non-null topic rows → only topicImpacts.
 *   - publicationImpactScore non-null + no topic rows → only impactScore.
 *   - Both present → both fields output, independently sourced.
 *   - Multiple cwids × same topic → topicImpacts MAX over cwids.
 *   - Prisma Decimal values (objects with `toNumber()`) coerce to plain
 *     numbers for both inputs.
 *   - NaN / non-finite values are skipped (defense against bad upstream data).
 */
import { describe, it, expect } from "vitest";
import { buildPubImpactFields } from "@/etl/search-index/index";

// Lightweight Decimal stand-in matching the runtime shape Prisma returns
// for Decimal columns. The real Prisma client returns instances of
// `Decimal.js` which expose `.toNumber()`.
const dec = (n: number) => ({ toNumber: () => n });

describe("buildPubImpactFields (§1.8 doc-level + per-topic, #316 PR-B)", () => {
  it("publication null + zero topic rows → empty object", () => {
    const result = buildPubImpactFields(null, []);
    expect(result).toEqual({});
    const doc = { pmid: "1", ...result };
    expect(doc).not.toHaveProperty("impactScore");
    expect(doc).not.toHaveProperty("topicImpacts");
  });

  it("publication null + all-null topic rows → empty object", () => {
    const result = buildPubImpactFields(null, [
      { parentTopicId: "cardiology", impactScore: null },
      { parentTopicId: "oncology", impactScore: null },
    ]);
    expect(result).toEqual({});
  });

  it("publication non-null + no topic rows → only impactScore", () => {
    const result = buildPubImpactFields(dec(42), []);
    expect(result).toEqual({ impactScore: 42 });
    expect(result).not.toHaveProperty("topicImpacts");
  });

  it("publication null + non-null topic rows → only topicImpacts", () => {
    // Defensive scenario: data-quality gap where the mirror has values but
    // the canonical Publication.impactScore wasn't ETL'd. topicImpacts
    // continues to populate so conceptImpactScore can still compute.
    const result = buildPubImpactFields(null, [
      { parentTopicId: "cardiology", impactScore: dec(20) },
    ]);
    expect(result).toEqual({
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 20 }],
    });
    expect(result).not.toHaveProperty("impactScore");
  });

  it("publication non-null + topic rows → both fields, independently sourced", () => {
    const result = buildPubImpactFields(dec(42.5), [
      { parentTopicId: "cardiology", impactScore: dec(42.5) },
    ]);
    expect(result).toEqual({
      impactScore: 42.5,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 42.5 }],
    });
  });

  it("two cwids × same topic → topicImpacts MAX over cwids", () => {
    // §1.8 spec: "max impact across the pub's publication_topic rows" — kept
    // for backwards-compat with the conceptImpactScore consumer even though
    // post-#316 PR-A every per-topic value mirrors the global.
    const result = buildPubImpactFields(dec(78), [
      { parentTopicId: "cardiology", impactScore: dec(10) },
      { parentTopicId: "cardiology", impactScore: dec(78) },
      { parentTopicId: "cardiology", impactScore: dec(33) },
    ]);
    expect(result).toEqual({
      impactScore: 78,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 78 }],
    });
  });

  it("multiple topics → one entry per topic; doc impactScore from Publication", () => {
    // Post-#316 PR-A the topic values would all equal the global, but the
    // unit-tested invariant is "doc-level comes from publication, topic
    // values come from publication_topic." Different inputs prove the
    // sources are independent.
    const result = buildPubImpactFields(dec(78), [
      { parentTopicId: "cardiology", impactScore: dec(10) },
      { parentTopicId: "oncology", impactScore: dec(78) },
      { parentTopicId: "neurology", impactScore: dec(55) },
    ]);
    expect(result).toMatchObject({ impactScore: 78 });
    const out = result as { topicImpacts: Array<{ parentTopicId: string; impactScore: number }> };
    expect(out.topicImpacts).toHaveLength(3);
    const byTopic = new Map(out.topicImpacts.map((t) => [t.parentTopicId, t.impactScore]));
    expect(byTopic.get("cardiology")).toBe(10);
    expect(byTopic.get("oncology")).toBe(78);
    expect(byTopic.get("neurology")).toBe(55);
  });

  it("mixed null + non-null rows for one topic → topicImpacts MAX over non-nulls only", () => {
    const result = buildPubImpactFields(dec(20), [
      { parentTopicId: "cardiology", impactScore: null },
      { parentTopicId: "cardiology", impactScore: dec(20) },
      { parentTopicId: "cardiology", impactScore: null },
    ]);
    expect(result).toEqual({
      impactScore: 20,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 20 }],
    });
  });

  it("accepts plain numbers as well as Decimal-like objects for both args", () => {
    const result = buildPubImpactFields(42, [
      { parentTopicId: "cardiology", impactScore: 17 },
      { parentTopicId: "oncology", impactScore: dec(42) },
    ]);
    expect(result).toMatchObject({ impactScore: 42 });
    const out = result as { topicImpacts: Array<{ parentTopicId: string; impactScore: number }> };
    expect(out.topicImpacts.map((t) => t.impactScore).sort((a, b) => a - b)).toEqual([17, 42]);
  });

  it("skips non-finite publication impact and per-topic values", () => {
    const result = buildPubImpactFields(dec(Number.NaN), [
      { parentTopicId: "cardiology", impactScore: dec(Number.NaN) },
      { parentTopicId: "cardiology", impactScore: dec(11) },
    ]);
    expect(result).toEqual({
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 11 }],
    });
    expect(result).not.toHaveProperty("impactScore");
  });

  it("topic with only NaN rows is dropped from topicImpacts entirely", () => {
    const result = buildPubImpactFields(dec(50), [
      { parentTopicId: "cardiology", impactScore: dec(Number.NaN) },
      { parentTopicId: "oncology", impactScore: dec(50) },
    ]);
    expect(result).toMatchObject({ impactScore: 50 });
    const out = result as { topicImpacts: Array<{ parentTopicId: string }> };
    expect(out.topicImpacts.map((t) => t.parentTopicId)).toEqual(["oncology"]);
  });
});
