/**
 * Per-pmid `top_topic_id` collapse for `etl/dynamodb` Block 2b (issue #325).
 *
 * The TOPIC# producer denormalizes `top_topic_id` across the N rows for
 * one pmid; the resolver collapses to first-non-empty per pmid and
 * applies two FK guards (pmid must exist locally, target topic must
 * exist in the catalog). Covers:
 *   - Multi-row denormalization for one pmid
 *   - Numeric pmid normalization to string (DDB returns Number)
 *   - Missing field tolerance (forward-compat with pre-RA#68 rows)
 *   - knownPmidSet guard (pub-not-yet-ingested)
 *   - knownTopicIds guard (target topic missing mid-taxonomy-bump)
 *   - Per-pmid conflict counting (producer drift detection)
 */
import { describe, expect, it } from "vitest";
import {
  resolveTopTopicByPmid,
  type TopTopicCandidate,
} from "@/etl/dynamodb/top-topic-resolver";

const KNOWN_TOPICS = new Set([
  "digital_health_telemedicine",
  "neuro_oncology",
  "bioethics_medical_humanities",
]);

describe("resolveTopTopicByPmid (#325 Block 2b)", () => {
  it("collapses N TOPIC# rows for one pmid to a single map entry", () => {
    const rows: TopTopicCandidate[] = [
      { pmid: "30418319", top_topic_id: "digital_health_telemedicine" },
      { pmid: "30418319", top_topic_id: "digital_health_telemedicine" },
      { pmid: "30418319", top_topic_id: "digital_health_telemedicine" },
    ];
    const r = resolveTopTopicByPmid(rows, new Set(["30418319"]), KNOWN_TOPICS);
    expect(r.byPmid.size).toBe(1);
    expect(r.byPmid.get("30418319")).toBe("digital_health_telemedicine");
    expect(r.perPmidConflicts).toBe(0);
    expect(r.skippedUnknownTopic).toBe(0);
  });

  it("accepts numeric pmid and normalizes to string (DDB Document client returns Number)", () => {
    const r = resolveTopTopicByPmid(
      [{ pmid: 30418319, top_topic_id: "neuro_oncology" }],
      new Set(["30418319"]),
      KNOWN_TOPICS,
    );
    expect(r.byPmid.get("30418319")).toBe("neuro_oncology");
  });

  it("ignores rows missing top_topic_id (forward-compat: pre-RA#68 records)", () => {
    const rows: TopTopicCandidate[] = [
      { pmid: "1" }, // missing field entirely
      { pmid: "2", top_topic_id: "" }, // empty string
      { pmid: "3", top_topic_id: "neuro_oncology" },
    ];
    const r = resolveTopTopicByPmid(
      rows,
      new Set(["1", "2", "3"]),
      KNOWN_TOPICS,
    );
    expect(r.byPmid.size).toBe(1);
    expect(r.byPmid.get("3")).toBe("neuro_oncology");
  });

  it("skips pmids not present in knownPmidSet (publication not yet ingested)", () => {
    const r = resolveTopTopicByPmid(
      [
        { pmid: "1", top_topic_id: "neuro_oncology" },
        { pmid: "2", top_topic_id: "neuro_oncology" },
      ],
      new Set(["1"]), // only pmid 1 ingested locally
      KNOWN_TOPICS,
    );
    expect(r.byPmid.size).toBe(1);
    expect(r.byPmid.get("1")).toBe("neuro_oncology");
    expect(r.byPmid.has("2")).toBe(false);
  });

  it("skips and counts pmids whose top_topic_id isn't in the catalog (FK guard)", () => {
    const r = resolveTopTopicByPmid(
      [
        { pmid: "1", top_topic_id: "neuro_oncology" }, // valid
        { pmid: "2", top_topic_id: "made_up_topic" }, // unknown
        { pmid: "3", top_topic_id: "also_not_real" }, // unknown
      ],
      new Set(["1", "2", "3"]),
      KNOWN_TOPICS,
    );
    expect(r.byPmid.size).toBe(1);
    expect(r.skippedUnknownTopic).toBe(2);
  });

  it("counts per-pmid conflicts and keeps first-seen for determinism", () => {
    const rows: TopTopicCandidate[] = [
      { pmid: "9", top_topic_id: "neuro_oncology" }, // first
      { pmid: "9", top_topic_id: "digital_health_telemedicine" }, // drift
    ];
    const r = resolveTopTopicByPmid(rows, new Set(["9"]), KNOWN_TOPICS);
    expect(r.byPmid.get("9")).toBe("neuro_oncology"); // first wins
    expect(r.perPmidConflicts).toBe(1);
  });

  it("returns empty resolution when input is empty (zero-coverage producer state)", () => {
    const r = resolveTopTopicByPmid([], new Set<string>(), KNOWN_TOPICS);
    expect(r.byPmid.size).toBe(0);
    expect(r.skippedUnknownTopic).toBe(0);
    expect(r.perPmidConflicts).toBe(0);
  });

  it("trims string-form pmid (DDB sometimes returns whitespace)", () => {
    const r = resolveTopTopicByPmid(
      [{ pmid: " 42 ", top_topic_id: "neuro_oncology" }],
      new Set(["42"]),
      KNOWN_TOPICS,
    );
    expect(r.byPmid.get("42")).toBe("neuro_oncology");
  });

  it("rejects non-numeric string pmid (avoids polluting the publication FK)", () => {
    const r = resolveTopTopicByPmid(
      [{ pmid: "not-a-pmid", top_topic_id: "neuro_oncology" }],
      new Set(["not-a-pmid"]),
      KNOWN_TOPICS,
    );
    expect(r.byPmid.size).toBe(0);
  });
});
