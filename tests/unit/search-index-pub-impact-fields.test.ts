/**
 * Issue #259 §1.8 — `buildPubImpactFields` derives the doc-level `impactScore`
 * (sortable MAX float) and `topicImpacts` (per-topic MAX, used by the API
 * for the "Concept impact" badge) from the un-deduped publication_topic
 * rows joined by the ETL.
 *
 * Invariants under test:
 *   - Zero rows → field omitted (empty object for spreading, OMIT-on-empty
 *     contract shared with `reciterParentTopicId`).
 *   - All-null impactScore → field omitted (no signal worth indexing).
 *   - Multiple cwids × same topic → MAX over cwids per topic.
 *   - Multiple topics → one entry per topic; doc-level `impactScore` is the
 *     MAX across topics.
 *   - Prisma Decimal values (objects with `toNumber()`) coerce to plain
 *     numbers so the float mapping accepts them and JSON serialization
 *     doesn't emit decimal strings.
 *   - NaN / non-finite values are skipped (defense against bad upstream data).
 */
import { describe, it, expect } from "vitest";
import { buildPubImpactFields } from "@/etl/search-index/index";

// Lightweight Decimal stand-in matching the runtime shape Prisma returns
// for Decimal columns. The real Prisma client returns instances of
// `Decimal.js` which expose `.toNumber()`; the helper only ever calls
// that method, so this is a faithful substitute for unit tests.
const dec = (n: number) => ({ toNumber: () => n });

describe("buildPubImpactFields (§1.8 doc-level + per-topic MAX)", () => {
  it("zero rows → omits both fields", () => {
    const result = buildPubImpactFields([]);
    expect(result).toEqual({});
    const doc = { pmid: "1", ...result };
    expect(doc).not.toHaveProperty("impactScore");
    expect(doc).not.toHaveProperty("topicImpacts");
  });

  it("all-null impact rows → omits both fields", () => {
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: null },
      { parentTopicId: "oncology", impactScore: null },
    ]);
    expect(result).toEqual({});
  });

  it("single topic, single non-null impact → impactScore == topicImpacts[0]", () => {
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: dec(42.5) },
    ]);
    expect(result).toEqual({
      impactScore: 42.5,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 42.5 }],
    });
  });

  it("two cwids × same topic → MAX over cwids", () => {
    // Same topic, two scholars with different impact contributions.
    // §1.8 spec: "max impact across the pub's publication_topic rows".
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: dec(10) },
      { parentTopicId: "cardiology", impactScore: dec(78) },
      { parentTopicId: "cardiology", impactScore: dec(33) },
    ]);
    expect(result).toEqual({
      impactScore: 78,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 78 }],
    });
  });

  it("multiple topics → one entry per topic; doc impactScore is the MAX across", () => {
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: dec(10) },
      { parentTopicId: "oncology", impactScore: dec(78) },
      { parentTopicId: "neurology", impactScore: dec(55) },
    ]);
    // Map insertion order preserves first-seen; doc-level MAX is 78.
    expect(result).toMatchObject({ impactScore: 78 });
    const out = result as { topicImpacts: Array<{ parentTopicId: string; impactScore: number }> };
    expect(out.topicImpacts).toHaveLength(3);
    const byTopic = new Map(out.topicImpacts.map((t) => [t.parentTopicId, t.impactScore]));
    expect(byTopic.get("cardiology")).toBe(10);
    expect(byTopic.get("oncology")).toBe(78);
    expect(byTopic.get("neurology")).toBe(55);
  });

  it("mixed null + non-null rows for one topic → MAX over non-nulls only", () => {
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: null },
      { parentTopicId: "cardiology", impactScore: dec(20) },
      { parentTopicId: "cardiology", impactScore: null },
    ]);
    expect(result).toEqual({
      impactScore: 20,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 20 }],
    });
  });

  it("accepts plain numbers as well as Decimal-like objects", () => {
    // Belt-and-braces: helper supports the schema-evolution path where
    // Prisma client serialization changes coerce Decimal → number.
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: 17 },
      { parentTopicId: "oncology", impactScore: dec(42) },
    ]);
    expect(result).toMatchObject({ impactScore: 42 });
  });

  it("skips non-finite values (defense against bad upstream data)", () => {
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: dec(Number.NaN) },
      { parentTopicId: "cardiology", impactScore: dec(11) },
    ]);
    expect(result).toEqual({
      impactScore: 11,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 11 }],
    });
  });

  it("topic with only NaN rows is dropped entirely", () => {
    const result = buildPubImpactFields([
      { parentTopicId: "cardiology", impactScore: dec(Number.NaN) },
      { parentTopicId: "oncology", impactScore: dec(50) },
    ]);
    expect(result).toMatchObject({ impactScore: 50 });
    const out = result as { topicImpacts: Array<{ parentTopicId: string }> };
    expect(out.topicImpacts.map((t) => t.parentTopicId)).toEqual(["oncology"]);
  });
});
