/**
 * Issue #259 §1.8 (migrated through #316 PR-B-finalize) —
 * `buildPubImpactFields` derives the doc-level `impactScore` (sortable,
 * sourced from Publication.impactScore) and `topicImpacts[]` (one entry
 * per distinct parentTopicId; each carries the same doc-level value).
 *
 * Invariants under test:
 *   - publicationImpactScore null → no fields output (regardless of topics).
 *   - publicationImpactScore non-null + zero topic rows → only impactScore.
 *   - publicationImpactScore non-null + n topic rows → both fields, with
 *     topicImpacts deduped to distinct parentTopicIds and each entry's
 *     impactScore equal to the doc-level value.
 *   - Prisma Decimal values (objects with `toNumber()`) coerce to plain numbers.
 *   - Non-finite publicationImpactScore is skipped (defensive guard).
 */
import { describe, it, expect } from "vitest";
import { buildPubImpactFields } from "@/etl/search-index/index";

// Lightweight Decimal stand-in matching the runtime shape Prisma returns
// for Decimal columns. The real Prisma client returns instances of
// `Decimal.js` which expose `.toNumber()`.
const dec = (n: number) => ({ toNumber: () => n });

describe("buildPubImpactFields (§1.8 doc-level + per-topic, post-#316 PR-B-finalize)", () => {
  it("publication null → empty object regardless of topic rows", () => {
    expect(buildPubImpactFields(null, [])).toEqual({});
    expect(
      buildPubImpactFields(null, [{ parentTopicId: "cardiology" }]),
    ).toEqual({});
  });

  it("publication non-null + no topic rows → only impactScore", () => {
    const result = buildPubImpactFields(dec(42), []);
    expect(result).toEqual({ impactScore: 42 });
    expect(result).not.toHaveProperty("topicImpacts");
  });

  it("publication non-null + single topic → both fields, topicImpact equals doc-level", () => {
    const result = buildPubImpactFields(dec(42.5), [{ parentTopicId: "cardiology" }]);
    expect(result).toEqual({
      impactScore: 42.5,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 42.5 }],
    });
  });

  it("duplicate parentTopicIds collapse to a single entry", () => {
    // Two PublicationTopic rows for the same parent (one per scholar) — the
    // dedup-by-parentTopicId means topicImpacts has just one entry. Pre-PR-B
    // this was a MAX-over-cwids; post-finalize the value is uniform.
    const result = buildPubImpactFields(dec(60), [
      { parentTopicId: "cardiology" },
      { parentTopicId: "cardiology" },
      { parentTopicId: "cardiology" },
    ]);
    expect(result).toEqual({
      impactScore: 60,
      topicImpacts: [{ parentTopicId: "cardiology", impactScore: 60 }],
    });
  });

  it("multiple parent topics → one entry per topic, all with the same doc-level impactScore", () => {
    const result = buildPubImpactFields(dec(78), [
      { parentTopicId: "cardiology" },
      { parentTopicId: "oncology" },
      { parentTopicId: "neurology" },
    ]);
    expect(result.impactScore).toBe(78);
    const ti = result.topicImpacts!;
    expect(ti).toHaveLength(3);
    const byTopic = new Map(ti.map((t) => [t.parentTopicId, t.impactScore]));
    expect(byTopic.get("cardiology")).toBe(78);
    expect(byTopic.get("oncology")).toBe(78);
    expect(byTopic.get("neurology")).toBe(78);
  });

  it("accepts plain numbers as well as Decimal-like objects for publicationImpactScore", () => {
    const result = buildPubImpactFields(42, [{ parentTopicId: "cardiology" }]);
    expect(result.impactScore).toBe(42);
    expect(result.topicImpacts).toEqual([{ parentTopicId: "cardiology", impactScore: 42 }]);
  });

  it("non-finite publicationImpactScore is skipped (no fields output)", () => {
    const result = buildPubImpactFields(dec(Number.NaN), [
      { parentTopicId: "cardiology" },
    ]);
    expect(result).toEqual({});
  });
});
