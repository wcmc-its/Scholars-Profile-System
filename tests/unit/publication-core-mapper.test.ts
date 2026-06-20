/**
 * Block 6 PUB#/CORE# -> publication_core record mapper.
 *
 * buildPublicationCoreWrites applies the FK/field guards that index.ts Block 6
 * would otherwise inline, mirroring the publication-topic-mapper split. Covers:
 *   - A complete record -> a write (candidate and confirmed both land)
 *   - core_id / pmid resolved from SK / PK when the scalar fields are absent
 *   - Each skip category (core FK, publication FK, required fields, below-threshold)
 *   - pmid / likelihood / status / scored_at are required
 *   - Numeric pmid normalized to string
 *   - Signal fields mapped (coauthors JSON, ack, llm, affinity) with null/JsonNull
 *     for absent optionals
 *   - Empty input -> all-zero result
 */
import { describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  buildPublicationCoreWrites,
  type CoreRecordInput,
} from "@/etl/dynamodb/publication-core-mapper";

const SETS = {
  knownCoreIds: new Set(["2"]),
  knownPmidSet: new Set(["30418319"]),
};

/** A record that clears every guard, with per-test overrides. */
function rec(over: Partial<CoreRecordInput> = {}): CoreRecordInput {
  return {
    PK: "PUB#30418319",
    SK: "CORE#2",
    pmid: "30418319",
    core_id: "2",
    likelihood: 0.82,
    status: "candidate",
    scored_at: "2026-06-19T12:00:00Z",
    ...over,
  };
}

describe("buildPublicationCoreWrites (Block 6 mapper)", () => {
  it("maps a complete record to a single write", () => {
    const r = buildPublicationCoreWrites([rec()], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({
      pmid: "30418319",
      coreId: "2",
      status: "candidate",
      signalAck: false,
    });
    expect(Number(r.writes[0].likelihood)).toBeCloseTo(0.82);
    expect(r.writes[0].scoredAt).toBeInstanceOf(Date);
    expect(r.writes[0].scoredAt.toISOString()).toBe("2026-06-19T12:00:00.000Z");
  });

  it("lands a confirmed record, not just candidate", () => {
    const r = buildPublicationCoreWrites([rec({ status: "confirmed" })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].status).toBe("confirmed");
  });

  it("resolves core_id from the SK when the core_id field is absent", () => {
    const r = buildPublicationCoreWrites([rec({ core_id: undefined, SK: "CORE#2" })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].coreId).toBe("2");
  });

  it("resolves pmid from the PK when the pmid field is absent", () => {
    const r = buildPublicationCoreWrites([rec({ pmid: undefined, PK: "PUB#30418319" })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].pmid).toBe("30418319");
  });

  it("normalizes a numeric pmid to a string", () => {
    const r = buildPublicationCoreWrites([rec({ pmid: 30418319 })], SETS);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].pmid).toBe("30418319");
  });

  it("skips a record whose core_id isn't in the catalog (FK guard)", () => {
    const r = buildPublicationCoreWrites([rec({ core_id: "999", SK: "CORE#999" })], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingCore).toBe(1);
  });

  it("skips a record whose pmid isn't in the publication table (FK guard)", () => {
    const r = buildPublicationCoreWrites(
      [rec({ pmid: "77777777", PK: "PUB#77777777" })],
      SETS,
    );
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingPublication).toBe(1);
  });

  it("drops a below_threshold record without erroring", () => {
    const r = buildPublicationCoreWrites([rec({ status: "below_threshold" })], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedBelowThreshold).toBe(1);
    expect(r.skippedMissingFields).toBe(0);
  });

  it("requires pmid, likelihood, status, and scored_at", () => {
    expect(
      buildPublicationCoreWrites([rec({ pmid: undefined, PK: "PUB#" })], SETS).skippedMissingFields,
    ).toBe(1);
    expect(
      buildPublicationCoreWrites([rec({ likelihood: undefined })], SETS).skippedMissingFields,
    ).toBe(1);
    expect(buildPublicationCoreWrites([rec({ status: "" })], SETS).skippedMissingFields).toBe(1);
    expect(
      buildPublicationCoreWrites([rec({ scored_at: undefined })], SETS).skippedMissingFields,
    ).toBe(1);
    expect(
      buildPublicationCoreWrites([rec({ scored_at: "not-a-date" })], SETS).skippedMissingFields,
    ).toBe(1);
  });

  it("maps the signal fields, truncating llm_score and boxing affinity as Decimal", () => {
    const r = buildPublicationCoreWrites(
      [
        rec({
          signal_coauthors: ["djb2001", "jpd2001"],
          signal_ack: true,
          ack_alias: "CBIC",
          ack_snippet: "...processed at the Citigroup Biomedical Imaging Center...",
          llm_score: 7.9,
          llm_rationale: "advanced MRI methods described",
          author_affinity: 0.45,
        }),
      ],
      SETS,
    );
    expect(r.writes).toHaveLength(1);
    const w = r.writes[0];
    expect(w.signalCoauthors).toEqual(["djb2001", "jpd2001"]);
    expect(w.signalAck).toBe(true);
    expect(w.ackAlias).toBe("CBIC");
    expect(w.ackSnippet).toContain("Citigroup Biomedical Imaging Center");
    expect(w.llmScore).toBe(7); // truncated to SMALLINT
    expect(w.llmRationale).toBe("advanced MRI methods described");
    expect(Number(w.authorAffinity)).toBeCloseTo(0.45);
  });

  it("uses JsonNull for empty coauthors and null for absent optional fields", () => {
    const r = buildPublicationCoreWrites([rec({ signal_coauthors: [] })], SETS);
    expect(r.writes).toHaveLength(1);
    const w = r.writes[0];
    expect(w.signalCoauthors).toBe(Prisma.JsonNull);
    expect(w.ackAlias).toBeNull();
    expect(w.ackSnippet).toBeNull();
    expect(w.llmScore).toBeNull();
    expect(w.llmRationale).toBeNull();
    expect(w.authorAffinity).toBeNull();
  });

  it("returns an all-zero result for empty input", () => {
    const r = buildPublicationCoreWrites([], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingCore).toBe(0);
    expect(r.skippedMissingFields).toBe(0);
    expect(r.skippedBelowThreshold).toBe(0);
    expect(r.skippedMissingPublication).toBe(0);
  });
});
