/**
 * Block 2 TOPIC# -> publication_topic record mapper (issue #348).
 *
 * buildPublicationTopicWrites applies the FK/field guards that index.ts
 * Block 2 used to inline. The #348 change: an empty `author_position` no
 * longer drops the row — it lands with authorPosition="". Covers:
 *   - A complete record -> a write
 *   - Empty author_position -> still a write, authorPosition="" (#348)
 *   - Absent author_position -> still a write (#348)
 *   - A real author_position is preserved
 *   - emptyAuthorPosition counts only landed rows
 *   - Each skip category (topic, scholar, required fields, publication)
 *   - pmid / score / year are still required
 *   - Numeric pmid normalized to string
 *   - Empty input -> all-zero result
 */
import { describe, expect, it } from "vitest";
import {
  buildPublicationTopicWrites,
  type TopicRecordInput,
} from "@/etl/dynamodb/publication-topic-mapper";

const SETS = {
  knownTopicIds: new Set(["neuro_oncology", "digital_health_telemedicine"]),
  ourCwidSet: new Set(["abc1234"]),
  knownPmidSet: new Set(["30418319"]),
};

/** A record that clears every guard, with per-test overrides. */
function rec(over: Partial<TopicRecordInput> = {}): TopicRecordInput {
  return {
    PK: "TOPIC#neuro_oncology",
    pmid: "30418319",
    faculty_uid: "cwid_abc1234",
    score: 0.8,
    year: 2020,
    author_position: "first",
    ...over,
  };
}

describe("buildPublicationTopicWrites (#348 Block 2 mapper)", () => {
  it("maps a complete record to a single write", () => {
    const r = buildPublicationTopicWrites([rec()], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({
      pmid: "30418319",
      cwid: "abc1234",
      parentTopicId: "neuro_oncology",
      authorPosition: "first",
      year: 2020,
    });
    expect(Number(r.writes[0].score)).toBeCloseTo(0.8);
  });

  it("lands a row with empty author_position instead of dropping it (#348)", () => {
    const r = buildPublicationTopicWrites([rec({ author_position: "" })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].authorPosition).toBe("");
    expect(r.skippedMissingFields).toBe(0);
    expect(r.emptyAuthorPosition).toBe(1);
  });

  it("lands a row when author_position is absent entirely (#348)", () => {
    const r = buildPublicationTopicWrites([rec({ author_position: undefined })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].authorPosition).toBe("");
    expect(r.emptyAuthorPosition).toBe(1);
  });

  it("preserves a real author_position and leaves emptyAuthorPosition at zero", () => {
    const r = buildPublicationTopicWrites([rec({ author_position: "last" })], SETS);
    expect(r.writes[0].authorPosition).toBe("last");
    expect(r.emptyAuthorPosition).toBe(0);
  });

  it("counts emptyAuthorPosition only for rows that actually landed", () => {
    const r = buildPublicationTopicWrites(
      [
        rec({ author_position: "" }), // lands, empty
        rec({ author_position: "first" }), // lands, non-empty
        rec({ pmid: "999", author_position: "" }), // skipped (pmid unknown) — not counted
      ],
      SETS,
    );
    expect(r.emptyAuthorPosition).toBe(1);
    expect(r.skippedMissingPublication).toBe(1);
  });

  it("skips a record whose parent topic isn't in the catalog (FK guard)", () => {
    const r = buildPublicationTopicWrites([rec({ PK: "TOPIC#made_up" })], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingTopic).toBe(1);
  });

  it("skips a record whose cwid isn't an active scholar (FK guard)", () => {
    const r = buildPublicationTopicWrites([rec({ faculty_uid: "cwid_nobody" })], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingScholar).toBe(1);
  });

  it("skips a record whose pmid isn't in the publication table (FK guard)", () => {
    const r = buildPublicationTopicWrites([rec({ pmid: "77777777" })], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingPublication).toBe(1);
  });

  it("still requires pmid, score, and year", () => {
    expect(buildPublicationTopicWrites([rec({ pmid: undefined })], SETS).skippedMissingFields).toBe(
      1,
    );
    expect(
      buildPublicationTopicWrites([rec({ score: undefined })], SETS).skippedMissingFields,
    ).toBe(1);
    expect(buildPublicationTopicWrites([rec({ year: undefined })], SETS).skippedMissingFields).toBe(
      1,
    );
  });

  it("normalizes a numeric pmid to a string", () => {
    const r = buildPublicationTopicWrites([rec({ pmid: 30418319 })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].pmid).toBe("30418319");
  });

  it("returns an all-zero result for empty input", () => {
    const r = buildPublicationTopicWrites([], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingTopic).toBe(0);
    expect(r.skippedMissingScholar).toBe(0);
    expect(r.skippedMissingFields).toBe(0);
    expect(r.skippedMissingPublication).toBe(0);
    expect(r.emptyAuthorPosition).toBe(0);
  });
});
