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
 * Plus projectPublicationCores, the whole Block 6 write path (map -> payload ->
 * both upsert halves) driven against a recording writer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  buildPublicationCoreWrites,
  projectPublicationCores,
  type CoreRecordInput,
  type PubCoreWrite,
  type PubCoreWriter,
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
 * Block 6's write path, end to end, against a writer that records its
 * arguments.
 *
 * This replaces a source-text guard over etl/dynamodb/index.ts. That guard read
 * the block as a STRING — window anchors, a comment stripper, a hand-kept list
 * of payload keys — and asserted no column name was spelled inside the window.
 * It was widened twice and never closed the class, it only moved the boundary:
 * with the window at the upsert call, `{ ...toPubCoreUpsertPayload(w),
 * methodEvidence: undefined }` sat one line above it; with the window at the
 * write set, `for (const cw of coreMap.writes) cw.methodTier = null;` sat three
 * lines above THAT. Both typechecked at exit 0 (every column is optional in
 * Prisma's generated update input), left the suite green, and stopped a column
 * being written for good. It also reddened on a column name appearing inside a
 * string, and its comment stripper silently ate the rest of any line holding
 * `/https:\/\//`.
 *
 * The window is gone rather than fenced: index.ts Block 6 is one call to
 * `projectPublicationCores`, which maps and writes in the same function, so
 * there is no statement between the mapping and the upsert to neutralize. What
 * is asserted here is what the upsert actually RECEIVES, so a comment or a
 * string naming a column cannot affect this test at all, and the expected
 * column set is read off the mapper's own write object — a column added to
 * `PubCoreWrite` and forgotten in the payload fails without anyone remembering
 * to update a list here.
 */
describe("projectPublicationCores (Block 6 records -> publication_core upsert)", () => {
  /** Every optional signal populated, so a dropped column reads as a value change, not null-to-null. */
  const FULL: Partial<CoreRecordInput> = {
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
  };

  type UpsertArgs = Parameters<PubCoreWriter["publicationCore"]["upsert"]>[0];

  function recordingWriter() {
    const calls: UpsertArgs[] = [];
    const writer: PubCoreWriter = {
      publicationCore: {
        upsert: async (args) => {
          calls.push(args);
          return {};
        },
      },
    };
    return { calls, writer };
  }

  /** The mapped columns, off the write itself: `create` adds only the (pmid, coreId) key. */
  function mappedColumns(w: PubCoreWrite): string[] {
    return Object.keys(w).filter((k) => k !== "pmid" && k !== "coreId");
  }

  it("sends every mapped column, with its mapped value, in BOTH halves", async () => {
    const expected = buildPublicationCoreWrites([rec(FULL)], SETS).writes[0];
    const columns = mappedColumns(expected);
    expect(columns.length).toBeGreaterThan(0);

    const { calls, writer } = recordingWriter();
    const result = await projectPublicationCores([rec(FULL)], SETS, writer);

    expect(result.upserted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ pmid_coreId: { pmid: "30418319", coreId: "2" } });

    const create = calls[0].create as Record<string, unknown>;
    const update = calls[0].update as Record<string, unknown>;
    const write = expected as unknown as Record<string, unknown>;

    // No column missing from either half, and none invented.
    expect(Object.keys(update).sort()).toEqual([...columns].sort());
    expect(Object.keys(create).sort()).toEqual([...columns, "pmid", "coreId"].sort());
    for (const k of columns) {
      expect(update[k]).toEqual(write[k]);
      expect(create[k]).toEqual(write[k]);
    }
    expect(create.pmid).toBe("30418319");
    expect(create.coreId).toBe("2");
  });

  it("writes the absent-signal row as DbNull, not as a dropped key", async () => {
    // The case that actually runs today: 0 of 21,481 live CORE# items carry a
    // method/MeSH attribute, so a column silently stopped here would look
    // exactly like the engine not emitting yet.
    const expected = buildPublicationCoreWrites([rec()], SETS).writes[0];
    const { calls, writer } = recordingWriter();
    await projectPublicationCores([rec()], SETS, writer);

    const update = calls[0].update as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(mappedColumns(expected).sort());
    expect(update.methodTier).toBeNull();
    expect(update.methodEvidence).toBe(Prisma.DbNull);
    expect(update.meshEvidence).toBe(Prisma.DbNull);
  });

  it("upserts every write across batch boundaries, and nothing a guard skipped", async () => {
    const pmids = Array.from({ length: 250 }, (_, i) => String(40000000 + i));
    const sets = { knownCoreIds: SETS.knownCoreIds, knownPmidSet: new Set(pmids) };
    const records = [
      ...pmids.map((pmid) => rec({ pmid, PK: `PUB#${pmid}` })),
      rec({ pmid: "40000000", PK: "PUB#40000000", status: "below_threshold" }),
      rec({ pmid: "99999999", PK: "PUB#99999999" }),
    ];

    const { calls, writer } = recordingWriter();
    const result = await projectPublicationCores(records, sets, writer);

    // 250 > the 100-row batch, so this also pins the chunking arithmetic.
    expect(result.upserted).toBe(250);
    expect(calls).toHaveLength(250);
    expect(result.skippedBelowThreshold).toBe(1);
    expect(result.skippedMissingPublication).toBe(1);
    expect(new Set(calls.map((c) => c.create.pmid))).toEqual(new Set(pmids));
  });

  // The behavioral tests above own every column, but they can only see writes that
  // go THROUGH `projectPublicationCores`. Block 6 re-inlining its own upsert loop
  // would bypass them entirely and stay green — the one case the deleted text guard
  // did catch. Two lines restore it, without the window anchors, the comment
  // stripper or the hand-maintained key list that made that guard unfixable.
  it("keeps Block 6 routed through the projector", () => {
    const src = readFileSync(join(process.cwd(), "etl/dynamodb/index.ts"), "utf8");
    expect(src).toContain("projectPublicationCores(");
    expect(src).not.toContain("publicationCore.upsert");
  });
});
