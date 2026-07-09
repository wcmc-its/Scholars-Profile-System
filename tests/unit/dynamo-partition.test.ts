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
});

const sizes = (b: ReturnType<typeof partitionRecords>) => ({
  tax: b.tax.length,
  topics: b.topics.length,
  faculty: b.faculty.length,
  impact: b.impact.length,
  tools: b.tools.length,
  cores: b.cores.length,
});

describe("partitionRecords (#1514 single-scan partition)", () => {
  it("routes one item of each recognized type into exactly its bucket", () => {
    const tax = { PK: "TAXONOMY#taxonomy_v2", SK: "META", topics: [] };
    const topic = { PK: "TOPIC#123", SK: "PUB#1", pmid: 1 };
    const faculty = { PK: "FACULTY#cwid_abc1001", SK: "PROFILE" };
    const impact = { PK: "IMPACT#pmid_30418319", SK: "SCORE", impact_score: 0.7 };
    const tool = { PK: "TOOL#crispr", SK: "PUB#1", pmid: 1 };
    const core = { PK: "PUB#30418319", SK: "CORE#2", core_id: "2" };

    const b = partitionRecords([tax, topic, faculty, impact, tool, core]);

    expect(sizes(b)).toEqual({ tax: 1, topics: 1, faculty: 1, impact: 1, tools: 1, cores: 1 });
    expect(b.tax[0]).toBe(tax);
    expect(b.topics[0]).toBe(topic);
    expect(b.faculty[0]).toBe(faculty);
    expect(b.impact[0]).toBe(impact);
    expect(b.tools[0]).toBe(tool);
    expect(b.cores[0]).toBe(core);
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

  it("returns all-empty buckets for empty input", () => {
    expect(sizes(partitionRecords([]))).toEqual(emptyBucketSizes());
  });
});
