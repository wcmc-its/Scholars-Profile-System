/**
 * Pure in-memory partitioner for the ReCiterAI -> app-DB projection ETL (#1514).
 *
 * partitionRecords replaces the six separate `begins_with` filtered DynamoDB
 * scans that etl/dynamodb/index.ts Blocks 1-6 used to run over the same table.
 * A filtered Scan still reads the whole table, so the six were collapsed into
 * ONE unfiltered scan + this routing. Routing is the blast-radius-sensitive part
 * (it projects topics / impact / cores for the whole app) and there is no local
 * DynamoDB to runtime-verify against, so this unit test is the acceptance bar.
 *
 * Covers:
 *   - one item of each recognized type lands in exactly its bucket
 *   - a PUB#… item whose SK is CORE#… lands in `cores` (SK-first rule)
 *   - a CORE#…/STAFF_DICT item lands in `coreStaff`, while both SPS-written
 *     siblings under the same partition — CORE#…/CLIENTS and the reserved
 *     CORE#…/STAFF — stay DROPPED
 *   - a GRANT#… item and a PUB#… item WITHOUT an SK CORE# prefix are dropped
 *   - prefix boundaries: TAXONOMY# vs TOPIC#, and the required cwid_/pmid_ tails
 */
import { describe, expect, it } from "vitest";
import { partitionRecords } from "@/etl/dynamodb/partition";

const emptyBucketSizes = () => ({
  tax: 0,
  topics: 0,
  faculty: 0,
  impact: 0,
  tools: 0,
  cores: 0,
  coreStaff: 0,
  producerRuns: 0,
  driftDays: 0,
});

const sizes = (b: ReturnType<typeof partitionRecords>) => ({
  tax: b.tax.length,
  topics: b.topics.length,
  faculty: b.faculty.length,
  impact: b.impact.length,
  tools: b.tools.length,
  cores: b.cores.length,
  coreStaff: b.coreStaff.length,
  producerRuns: b.producerRuns.length,
  driftDays: b.driftDays.length,
});

describe("partitionRecords (#1514 single-scan partition)", () => {
  it("routes one item of each recognized type into exactly its bucket", () => {
    const tax = { PK: "TAXONOMY#taxonomy_v2", SK: "META", topics: [] };
    const topic = { PK: "TOPIC#123", SK: "PUB#1", pmid: 1 };
    const faculty = { PK: "FACULTY#cwid_abc1001", SK: "PROFILE" };
    const impact = { PK: "IMPACT#pmid_30418319", SK: "SCORE", impact_score: 0.7 };
    const tool = { PK: "TOOL#crispr", SK: "PUB#1", pmid: 1 };
    const core = { PK: "PUB#30418319", SK: "CORE#2", core_id: "2" };
    const coreStaff = { PK: "CORE#2", SK: "STAFF_DICT", staff_count: 7, staff_tracked_count: 4 };
    const producerRun = { PK: "STAGE#daily_enrichment#GLOBAL", SK: "RUN#2026-09-07T11:01:13Z" };
    const driftDay = { PK: "DRIFT#taxonomy", SK: "DAY#2026-09-07" };

    const b = partitionRecords([
      tax,
      topic,
      faculty,
      impact,
      tool,
      core,
      coreStaff,
      producerRun,
      driftDay,
    ]);

    expect(sizes(b)).toEqual({
      tax: 1,
      topics: 1,
      faculty: 1,
      impact: 1,
      tools: 1,
      cores: 1,
      coreStaff: 1,
      producerRuns: 1,
      driftDays: 1,
    });
    expect(b.tax[0]).toBe(tax);
    expect(b.topics[0]).toBe(topic);
    expect(b.faculty[0]).toBe(faculty);
    expect(b.impact[0]).toBe(impact);
    expect(b.tools[0]).toBe(tool);
    expect(b.cores[0]).toBe(core);
    expect(b.coreStaff[0]).toBe(coreStaff);
    expect(b.producerRuns[0]).toBe(producerRun);
    expect(b.driftDays[0]).toBe(driftDay);
  });

  it("routes a CORE#…/STAFF_DICT item into coreStaff — the key shape is the MIRROR of a core row's", () => {
    // A CoreRecord is PK=PUB#…, SK=CORE#…; the staff item is PK=CORE#…,
    // SK=STAFF_DICT. Same "CORE#" text, opposite halves of the key, different
    // bucket. Both attributes ride along untouched — the mapper reads them.
    const staff = {
      PK: "CORE#14",
      SK: "STAFF_DICT",
      core_id: "14",
      staff_count: 4,
      staff_tracked_count: 1,
    };
    const b = partitionRecords([staff]);
    expect(sizes(b)).toEqual({ ...emptyBucketSizes(), coreStaff: 1 });
    expect(b.coreStaff[0]).toBe(staff);
    // and NOT into cores — its SK does not begin with CORE#
    expect(b.cores).toHaveLength(0);
  });

  it("keeps DROPPING the CORE#…/CLIENTS item SPS writes back to the engine", () => {
    // lib/cores/client-writeback.ts writes (CORE#{id}, CLIENTS) — SPS -> engine.
    // The STAFF_DICT match is on the EXACT SK, not a CORE#-PK prefix, so this
    // item is still unmatched: ingesting our own writeback would be a loop, not
    // a read.
    const clients = { PK: "CORE#2", SK: "CLIENTS", client_cwids: ["aaa1001"], client_count: 1 };
    const b = partitionRecords([clients]);
    expect(sizes(b)).toEqual(emptyBucketSizes());
  });

  it("DROPS the reserved CORE#…/STAFF key — the SK is matched exactly, not by prefix", () => {
    // The bare STAFF key is reserved for a future SPS-CURATED staff list, which
    // would run SPS -> engine like CLIENTS does. A `sk.startsWith("STAFF")`
    // here would swallow it the day it exists and feed our own writes back in.
    const reserved = { PK: "CORE#2", SK: "STAFF", staff_cwids: ["aaa1001"] };
    const b = partitionRecords([reserved]);
    expect(sizes(b)).toEqual(emptyBucketSizes());
  });

  it("routes a PUB#… item with an SK CORE# prefix into cores (SK-first rule)", () => {
    // PK=PUB#… matches no PK prefix; only the SK check keeps it. Its own filtered
    // scan (begins_with(SK, 'CORE#')) does the same today.
    const core = { PK: "PUB#30418319", SK: "CORE#2", core_id: "2", likelihood: 0.8 };
    const b = partitionRecords([core]);
    expect(sizes(b)).toEqual({ ...emptyBucketSizes(), cores: 1 });
    expect(b.cores[0]).toBe(core);
  });

  it("checks SK before PK so an SK CORE# item never falls through to a PK bucket", () => {
    // Defensive: even a hypothetical item whose PK begins with a recognized PK
    // prefix goes to cores when its SK is CORE#… (SK check runs first).
    const skWins = { PK: "TOPIC#123", SK: "CORE#9", core_id: "9" };
    const b = partitionRecords([skWins]);
    expect(sizes(b)).toEqual({ ...emptyBucketSizes(), cores: 1 });
    expect(b.topics).toHaveLength(0);
  });

  it("drops a GRANT#… item and a PUB#… item without an SK CORE# prefix", () => {
    const grant = { PK: "GRANT#opp_123", SK: "META", opportunity_id: "opp_123" };
    const pubNoCore = { PK: "PUB#30418319", SK: "META#abstract" };
    const pubNoSk = { PK: "PUB#30418319" };
    const b = partitionRecords([grant, pubNoCore, pubNoSk]);
    expect(sizes(b)).toEqual(emptyBucketSizes());
  });

  it("respects prefix boundaries: TAXONOMY# is not captured by the TOPIC# check and vice versa", () => {
    const tax = { PK: "TAXONOMY#taxonomy_v2" };
    const topic = { PK: "TOPIC#neuro" };
    const b = partitionRecords([tax, topic]);
    expect(sizes(b)).toEqual({ ...emptyBucketSizes(), tax: 1, topics: 1 });
    expect(b.tax[0]).toBe(tax);
    expect(b.topics[0]).toBe(topic);
  });

  it("requires the cwid_ tail for faculty and the pmid_ tail for impact", () => {
    // begins_with(PK, 'FACULTY#cwid_') / begins_with(PK, 'IMPACT#pmid_') —
    // FACULTY#/IMPACT# without the exact tail matched no filtered scan, so drops.
    const facultyNoTail = { PK: "FACULTY#other" };
    const impactNoTail = { PK: "IMPACT#doi_xyz" };
    const b = partitionRecords([facultyNoTail, impactNoTail]);
    expect(sizes(b)).toEqual(emptyBucketSizes());
  });

  it("routes EVERY STAGE# row, GLOBAL or scoped — filtering scope is the mapper's job", () => {
    const global = { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#2026-09-07T12:00:34Z" };
    const scoped = { PK: "STAGE#rollup_by_cwid#cwid:abc1001", SK: "RUN#2026-09-07T12:03:23Z" };
    // The FAILED# SK variant is a routing no-op — it is the mapper that has to
    // know it sorts after every RUN#<date>.
    const failed = { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#FAILED#2026-05-16T03:11:04.425Z" };

    const b = partitionRecords([global, scoped, failed]);

    expect(sizes(b)).toEqual({ ...emptyBucketSizes(), producerRuns: 3 });
  });

  it("routes DRIFT# findings rows into their own bucket, not producerRuns", () => {
    const drift = { PK: "DRIFT#evaluation", SK: "DAY#2026-09-07", severity: "WARN" };
    const stage = { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#2026-09-07T12:00:34Z" };

    const b = partitionRecords([drift, stage]);

    expect(sizes(b)).toEqual({ ...emptyBucketSizes(), driftDays: 1, producerRuns: 1 });
    expect(b.driftDays[0]).toBe(drift);
  });

  it("returns all-empty buckets for empty input", () => {
    expect(sizes(partitionRecords([]))).toEqual(emptyBucketSizes());
  });
});
