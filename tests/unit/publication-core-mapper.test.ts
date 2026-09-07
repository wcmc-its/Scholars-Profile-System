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
 *   - Method-family / MeSH evidence carried through, order preserved, malformed
 *     upstream payloads dropped rather than thrown on, and ABSENT written as
 *     DbNull (true SQL NULL) so an operator's IS NOT NULL means populated
 *   - An over-long method_tier is tallied, not silently nulled
 *   - Empty input -> all-zero result
 * Plus the upsert payload both halves of the Block 6 write derive from.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  buildPublicationCoreWrites,
  toPubCoreUpsertPayload,
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
          prefilter_prior: 0.37,
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
    expect(Number(w.topicalPrior)).toBeCloseTo(0.37);
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
    expect(w.topicalPrior).toBeNull();
    // The empty case is the one that actually runs in production today: a live
    // scan found 0 of 21,481 CORE# items carrying any method/MeSH attribute, so
    // every row written until the engine's next run takes this branch.
    expect(w.methodTier).toBeNull();
    expect(w.methodEvidence).toBe(Prisma.DbNull);
    expect(w.meshEvidence).toBe(Prisma.DbNull);
  });

  it("writes DbNull (SQL NULL), not JsonNull, for absent method/MeSH evidence", () => {
    // Load-bearing, not a style choice. Prisma.JsonNull stores a JSON scalar
    // null: it PASSES `IS NOT NULL` and reports JSON_LENGTH = 1. With 0 of the
    // 21,481 live CORE# items carrying these attributes, JsonNull would make
    // every publication_core row read as populated, and the one operator query
    // this plumbing exists to serve - "is the engine emitting the signal yet?"
    // - would answer yes on an empty column. DbNull is a true SQL NULL, so
    // `method_evidence IS NOT NULL` means genuinely populated.
    const absent = buildPublicationCoreWrites([rec()], SETS).writes[0];
    expect(absent.methodEvidence).toBe(Prisma.DbNull);
    expect(absent.meshEvidence).toBe(Prisma.DbNull);
    expect(absent.methodEvidence).not.toBe(Prisma.JsonNull);
    expect(absent.meshEvidence).not.toBe(Prisma.JsonNull);

    // signalCoauthors is NOT changed with them: it is always a list the engine
    // computed (possibly empty), so present-but-empty is a real reading there.
    const emptyList = buildPublicationCoreWrites([rec({ signal_coauthors: [] })], SETS).writes[0];
    expect(emptyList.signalCoauthors).toBe(Prisma.JsonNull);
  });

  it("carries method_tier, method_evidence and mesh_evidence onto the write in upstream order", () => {
    const r = buildPublicationCoreWrites(
      [
        rec({
          method_tier: "strong",
          // pre-ranked upstream, strongest first — consumers read [0]
          method_evidence: [
            { family: "confocal microscopy", tool: "LSM 880", sentence: "Imaged on an LSM 880." },
            { family: "flow cytometry", tool: "Aria III", sentence: "Sorted on an Aria III." },
          ],
          mesh_evidence: [
            { descriptor_ui: "D008856", descriptor: "Microscopy, Confocal", tree_prefix: "E01" },
          ],
        }),
      ],
      SETS,
    );
    expect(r.writes).toHaveLength(1);
    const w = r.writes[0];
    expect(w.methodTier).toBe("strong");
    expect(w.methodEvidence).toEqual([
      { family: "confocal microscopy", tool: "LSM 880", sentence: "Imaged on an LSM 880." },
      { family: "flow cytometry", tool: "Aria III", sentence: "Sorted on an Aria III." },
    ]);
    expect(w.meshEvidence).toEqual([
      { descriptor_ui: "D008856", descriptor: "Microscopy, Confocal", tree_prefix: "E01" },
    ]);
  });

  it("maps mesh_evidence independently of the method pair (upstream writes them separately)", () => {
    const meshOnly = buildPublicationCoreWrites(
      [
        rec({
          mesh_evidence: [
            { descriptor_ui: "D002478", descriptor: "Cells, Cultured", tree_prefix: "A11" },
          ],
        }),
      ],
      SETS,
    );
    expect(meshOnly.writes[0].methodTier).toBeNull();
    expect(meshOnly.writes[0].methodEvidence).toBe(Prisma.DbNull);
    expect(meshOnly.writes[0].meshEvidence).toHaveLength(1);

    // The engine writes method_tier and method_evidence together or not at all,
    // but a tier arriving alone must still land rather than drop the row.
    const tierOnly = buildPublicationCoreWrites([rec({ method_tier: "weak" })], SETS);
    expect(tierOnly.writes).toHaveLength(1);
    expect(tierOnly.writes[0].methodTier).toBe("weak");
    expect(tierOnly.writes[0].methodEvidence).toBe(Prisma.DbNull);
  });

  it("tolerates a malformed method_evidence / mesh_evidence payload without emitting garbage", () => {
    const notAnArray = buildPublicationCoreWrites(
      [rec({ method_evidence: "confocal microscopy", mesh_evidence: { descriptor: "Brain" } })],
      SETS,
    );
    expect(notAnArray.writes).toHaveLength(1);
    expect(notAnArray.writes[0].methodEvidence).toBe(Prisma.DbNull);
    expect(notAnArray.writes[0].meshEvidence).toBe(Prisma.DbNull);

    // A list with SOME well-formed entries keeps only those; entries missing a
    // required string key are dropped rather than written through.
    const mixed = buildPublicationCoreWrites(
      [
        rec({
          method_evidence: [
            { family: "flow cytometry" }, // no tool/sentence
            { family: "confocal microscopy", tool: "LSM 880", sentence: "Imaged on an LSM 880." },
            null,
            "flow cytometry",
            { family: 1, tool: 2, sentence: 3 }, // right keys, wrong types
          ],
          mesh_evidence: [{ descriptor_ui: "D008856", descriptor: "Microscopy, Confocal" }],
        }),
      ],
      SETS,
    );
    expect(mixed.writes[0].methodEvidence).toEqual([
      { family: "confocal microscopy", tool: "LSM 880", sentence: "Imaged on an LSM 880." },
    ]);
    // every mesh entry was malformed (no tree_prefix) -> nothing to write
    expect(mixed.writes[0].meshEvidence).toBe(Prisma.DbNull);

    // None of this is a required field, so no skip guard trips.
    expect(notAnArray.skippedMissingFields).toBe(0);
    expect(mixed.skippedMissingFields).toBe(0);
  });

  it("nulls a method_tier that is empty or too long for the VARCHAR(16) column", () => {
    expect(buildPublicationCoreWrites([rec({ method_tier: "" })], SETS).writes[0].methodTier).toBe(
      null,
    );
    expect(
      buildPublicationCoreWrites([rec({ method_tier: "  moderate  " })], SETS).writes[0].methodTier,
    ).toBe("moderate");
    // A value MySQL would reject with a 1406 must not take the whole batch down.
    const tooLong = buildPublicationCoreWrites([rec({ method_tier: "a".repeat(17) })], SETS);
    expect(tooLong.writes).toHaveLength(1);
    expect(tooLong.writes[0].methodTier).toBeNull();
  });

  it("tallies an over-long method_tier instead of dropping it silently", () => {
    // Today's vocabulary is strong|moderate|weak, so this can only fire on an
    // engine-side rename - which is exactly the change that must not reach us
    // as an unexplained column of nulls. Every other drop in this mapper is
    // counted; this one is now too.
    const tooLong = buildPublicationCoreWrites(
      [rec({ method_tier: "a".repeat(17) }), rec({ method_tier: "b".repeat(64) })],
      SETS,
    );
    expect(tooLong.droppedMethodTierTooLong).toBe(2);
    expect(tooLong.writes).toHaveLength(2); // the ROW still lands; only the field drops

    // Absent, non-string and merely-empty tiers are absent, not drops.
    expect(buildPublicationCoreWrites([rec()], SETS).droppedMethodTierTooLong).toBe(0);
    expect(
      buildPublicationCoreWrites([rec({ method_tier: "" })], SETS).droppedMethodTierTooLong,
    ).toBe(0);
    expect(
      buildPublicationCoreWrites([rec({ method_tier: "moderate" })], SETS).droppedMethodTierTooLong,
    ).toBe(0);
  });

  it("maps prefilter_prior (batch_screen topical prior) independently of the four run.py signals", () => {
    const present = buildPublicationCoreWrites([rec({ prefilter_prior: 0.58 })], SETS);
    expect(Number(present.writes[0].topicalPrior)).toBeCloseTo(0.58);

    const absent = buildPublicationCoreWrites([rec({ prefilter_prior: undefined })], SETS);
    expect(absent.writes[0].topicalPrior).toBeNull();

    const malformed = buildPublicationCoreWrites(
      // @ts-expect-error - exercising a malformed upstream payload
      [rec({ prefilter_prior: "not-a-number" })],
      SETS,
    );
    expect(malformed.writes[0].topicalPrior).toBeNull();

    // A malformed/absent prefilter_prior must NOT trip any skip guard - it's
    // optional metadata, not a required field.
    expect(malformed.skippedMissingFields).toBe(0);
    expect(absent.skippedMissingFields).toBe(0);
  });

  it("returns an all-zero result for empty input", () => {
    const r = buildPublicationCoreWrites([], SETS);
    expect(r.writes).toHaveLength(0);
    expect(r.skippedMissingCore).toBe(0);
    expect(r.skippedMissingFields).toBe(0);
    expect(r.skippedBelowThreshold).toBe(0);
    expect(r.skippedMissingPublication).toBe(0);
    expect(r.droppedMethodTierTooLong).toBe(0);
  });
});

/**
 * Strip `//` line comments and block comments so the source guard below reads
 * CODE, not prose.
 *
 * The guard asserts no payload key appears literally in the Block 6 batch loop.
 * Raw text cannot tell a field list from a sentence, so a benign
 * `// NOTE: status is engine-provided.` above the payload line turned it red
 * with no behavioral change at all. It fails loud, so it is not a correctness
 * hole - but a guard that fires on a comment is a guard someone eventually
 * deletes, and deleting THIS one puts the silent stopped-write back on the
 * table. Quoted `//` is respected so a string is never mistaken for a comment.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i++;
        if (source[i - 1] === c) break;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The Block 6 upsert used to carry two hand-maintained field lists, one in the
 * `create` half and one in the `update` half. Nothing held them together:
 * deleting the three method/MeSH fields from the `update` half alone left
 * `tsc` at exit 0 and the whole suite green (proved by mutation), because every
 * column is optional in Prisma's generated `PublicationCoreUpdateInput` - the
 * write simply stopped happening. Both halves now derive from one payload, and
 * these tests pin its key set plus the fact that index.ts still uses it.
 */
describe("toPubCoreUpsertPayload (Block 6 upsert payload)", () => {
  /** Every publication_core column the nightly writes, besides the (pmid, coreId) key. */
  const PAYLOAD_KEYS = [
    "likelihood",
    "status",
    "signalCoauthors",
    "signalAck",
    "ackAlias",
    "ackSnippet",
    "llmScore",
    "llmRationale",
    "authorAffinity",
    "topicalPrior",
    "methodTier",
    "methodEvidence",
    "meshEvidence",
    "scoredAt",
  ] as const;

  const write = buildPublicationCoreWrites(
    [
      rec({
        signal_coauthors: ["djb2001"],
        signal_ack: true,
        ack_alias: "CBIC",
        ack_snippet: "Imaging performed at the core.",
        llm_score: 7,
        llm_rationale: "advanced MRI methods described",
        author_affinity: 0.45,
        prefilter_prior: 0.37,
        method_tier: "strong",
        method_evidence: [
          { family: "confocal microscopy", tool: "LSM 880", sentence: "Imaged on an LSM 880." },
        ],
        mesh_evidence: [
          { descriptor_ui: "D008856", descriptor: "Microscopy, Confocal", tree_prefix: "E01" },
        ],
      }),
    ],
    SETS,
  ).writes[0];

  it("carries exactly the mapped columns - no more, no fewer", () => {
    expect(Object.keys(toPubCoreUpsertPayload(write)).sort()).toEqual([...PAYLOAD_KEYS].sort());
  });

  it("passes each mapped value straight through", () => {
    const payload = toPubCoreUpsertPayload(write);
    for (const k of PAYLOAD_KEYS) {
      expect(payload[k]).toBe(write[k]);
    }
  });

  it("is the only place etl/dynamodb/index.ts spells the upsert columns", () => {
    // A source check, not a style check: re-inlining a field list in either
    // half is how the two drifted apart before, and no runtime assertion can
    // see a field that was never sent.
    //
    // The window is the whole batch LOOP, not the `db.write.publicationCore.upsert(`
    // call. Anchored at the call it opened one line BELOW where the payload is
    // built, so a neutralization above it was invisible:
    //
    //   const payload = { ...toPubCoreUpsertPayload(w), methodEvidence: undefined };
    //
    // typechecked at exit 0 (every column is optional in Prisma's update input),
    // left all 22 tests in this file green, and stopped method_evidence being
    // written for good — exactly the silent stopped-write this guard exists to
    // catch. Starting at the loop covers the payload's construction too.
    const src = readFileSync(path.join(process.cwd(), "etl/dynamodb/index.ts"), "utf8");
    const start = src.indexOf("for (let i = 0; i < coreMap.writes.length; i += CORE_BATCH)");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("pubCoreRowsUpserted +=", start);
    expect(end).toBeGreaterThan(start);
    // Comments stripped: this asserts on what the loop DOES, so prose that
    // happens to name a column must not be able to redden it (or, on the
    // toMatch side, to satisfy it).
    const block = stripComments(src.slice(start, end));

    // Derived from the mapper's helper and used UNALTERED: no spread-and-override,
    // no second object literal between the helper and the two halves.
    expect(block).toMatch(/const payload = toPubCoreUpsertPayload\(w\);/);
    expect(block).toMatch(/create:\s*\{[\s\S]*?\.\.\.payload[\s\S]*?\}/);
    expect(block).toMatch(/update:\s*payload\b/);
    for (const k of PAYLOAD_KEYS) {
      expect(block).not.toContain(k);
    }
  });
});
