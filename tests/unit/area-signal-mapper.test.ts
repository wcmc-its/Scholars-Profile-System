import { describe, expect, it } from "vitest";

import {
  buildAreaSignalWrites,
  planAreaSignalPrune,
  projectAreaSignals,
  type AreaSignalWriter,
} from "@/etl/dynamodb/area-signal-mapper";
import { partitionRecords } from "@/etl/dynamodb/partition";

const K1 = "a".repeat(32);
const K2 = "b".repeat(32);
const TOPICS = new Set(["cardio_example", "onc_example"]);

const rec = (key: string, over: Record<string, unknown> = {}) => ({
  PK: `AREASIGNAL#grant:${key}`,
  SK: "META",
  synopsis: "Synthetic synopsis",
  synopsis_model: "example-model",
  taxonomy_version: "taxonomy_v2",
  scored_at: "2026-10-15T09:00:00Z",
  topic_scores: [
    { topic_id: "cardio_example", score: 0.8123456 },
    { topic_id: "onc_example", score: 0.4 },
  ],
  ...over,
});

describe("partitionRecords routes AREASIGNAL# and never AREAINPUT", () => {
  it("buckets AREASIGNAL# items and drops our own queue", () => {
    const b = partitionRecords([
      rec(K1),
      { PK: "AREAINPUT", SK: `grant#${K1}`, status: "pending" },
      { PK: "TOPIC#cardio_example", SK: "x" },
    ]);
    expect(b.areaSignals).toHaveLength(1);
    expect(b.topics).toHaveLength(1);
  });
});

describe("buildAreaSignalWrites", () => {
  it("maps text and per-area scores", () => {
    const m = buildAreaSignalWrites([rec(K1)], TOPICS);
    expect(m.texts).toEqual([
      {
        textKey: K1,
        kind: "grant",
        synopsis: "Synthetic synopsis",
        synopsisModel: "example-model",
        taxonomyVersion: "taxonomy_v2",
        scoredAt: new Date("2026-10-15T09:00:00Z"),
      },
    ]);
    expect(m.topics.map((t) => [t.textKey, t.parentTopicId, t.score.toString()])).toEqual([
      [K1, "cardio_example", "0.8123"],
      [K1, "onc_example", "0.4"],
    ]);
  });

  it("FK-guards unknown topics and drops bad scores without dropping the text", () => {
    const m = buildAreaSignalWrites(
      [
        rec(K1, {
          topic_scores: [
            { topic_id: "retired_area", score: 0.9 },
            { topic_id: "cardio_example", score: "nope" },
            { topic_id: "onc_example", score: 1.5 },
            { score: 0.5 },
          ],
        }),
      ],
      TOPICS,
    );
    expect(m.texts).toHaveLength(1);
    expect(m.topics).toEqual([]);
    expect(m.skippedUnknownTopic).toBe(1);
    expect(m.skippedBadScore).toBe(3);
  });

  it("drops malformed keys and non-META items", () => {
    const m = buildAreaSignalWrites(
      [
        { PK: "AREASIGNAL#paper:abcdefgh12", SK: "META" },
        { PK: "AREASIGNAL#grant:", SK: "META" },
        rec(K2, { SK: "OTHER" }),
        { PK: `AREASIGNAL#trial:${K2}`, SK: "META", topic_scores: [] },
      ],
      TOPICS,
    );
    expect(m.skippedBadKey).toBe(3);
    expect(m.texts.map((t) => [t.kind, t.textKey])).toEqual([["trial", K2]]);
  });
});

describe("planAreaSignalPrune (populated-guard)", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

  it("never prunes from an empty scan of a populated table", () => {
    const p = planAreaSignalPrune([], keys(300));
    expect(p.prune).toBe(false);
    expect(p.stale).toEqual([]);
  });

  it("refuses an implausible shrink", () => {
    expect(planAreaSignalPrune(keys(100), keys(300)).prune).toBe(false);
  });

  it("prunes keys absent from a full scan", () => {
    const p = planAreaSignalPrune(keys(299), keys(300));
    expect(p).toEqual({ prune: true, stale: ["k299"] });
  });
});

/** A recording in-memory stand-in for the Prisma surface the writer uses. */
function fakeDb(existing: string[] = []) {
  const texts = new Map<string, unknown>(existing.map((k) => [k, {}]));
  const topics: { textKey: string; parentTopicId: string }[] = existing.map((k) => ({
    textKey: k,
    parentTopicId: "old_area",
  }));
  const client: AreaSignalWriter = {
    areaSignalText: {
      findMany: async () => [...texts.keys()].map((textKey) => ({ textKey })),
      upsert: async ({ where, create }) => {
        texts.set(where.textKey, create);
        return create;
      },
      deleteMany: async ({ where }) => {
        let n = 0;
        for (const k of where.textKey.in) {
          if (texts.delete(k)) n += 1;
          // FK cascade
          for (let i = topics.length - 1; i >= 0; i--) if (topics[i].textKey === k) topics.splice(i, 1);
        }
        return { count: n };
      },
    },
    areaSignalTopic: {
      deleteMany: async ({ where }) => {
        const before = topics.length;
        for (let i = topics.length - 1; i >= 0; i--) {
          if (where.textKey.in.includes(topics[i].textKey)) topics.splice(i, 1);
        }
        return { count: before - topics.length };
      },
      createMany: async ({ data }) => {
        topics.push(...data.map((d) => ({ textKey: d.textKey, parentTopicId: d.parentTopicId })));
        return { count: data.length };
      },
    },
    $transaction: async (fn) => fn(client),
  };
  return { client, texts, topics };
}

describe("projectAreaSignals", () => {
  it("replaces each text's areas rather than accumulating them", async () => {
    const db = fakeDb([K1]);
    const res = await projectAreaSignals(buildAreaSignalWrites([rec(K1)], TOPICS), db.client);
    expect(res).toMatchObject({ texts: 1, topics: 2, pruned: 0 });
    expect(db.topics.map((t) => t.parentTopicId).sort()).toEqual(["cardio_example", "onc_example"]);
  });

  it("keeps every row when the scan comes back empty", async () => {
    const existing = Array.from({ length: 120 }, (_, i) => String(i).padStart(32, "0"));
    const db = fakeDb(existing);
    const res = await projectAreaSignals(buildAreaSignalWrites([], TOPICS), db.client);
    expect(res.pruned).toBe(0);
    expect(res.pruneSkipped).toMatch(/below floor/);
    expect(db.texts.size).toBe(120);
  });
});
