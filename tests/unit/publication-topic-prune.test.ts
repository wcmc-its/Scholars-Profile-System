/**
 * #1511 — the publication_topic keyed prune plan: remove associations ReciterAI
 * dropped, but NEVER mass-delete on a partial/truncated TOPIC# scan (gated by
 * the shared guardedReplace floor, MIN_FLOOR 50 / 50% max shrink).
 */
import { describe, it, expect, vi } from "vitest";

// projection-replace imports @/lib/db only to lazily construct Prisma; stub it
// so this stays a pure unit test with no client construction.
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  planPublicationTopicPrune,
  type PubTopicKey,
} from "@/etl/dynamodb/publication-topic-prune";

const k = (pmid: string, cwid: string, parentTopicId: string): PubTopicKey => ({
  pmid,
  cwid,
  parentTopicId,
});
const keys = (n: number, topic = "t1"): PubTopicKey[] =>
  Array.from({ length: n }, (_, i) => k(String(i), "a", topic));

describe("planPublicationTopicPrune", () => {
  it("marks existing keys absent from the write set as stale", () => {
    const writes = keys(50);
    const orphan = k("orphan", "b", "t2");
    const existing = [...writes, orphan];
    const plan = planPublicationTopicPrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([orphan]);
  });

  it("returns no stale keys when the write set covers every existing key", () => {
    const rows = keys(50);
    const plan = planPublicationTopicPrune(rows, rows, rows.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("refuses to prune when the write set is below the floor (partial scan)", () => {
    // live 100, incoming 10 → below the 50% floor → no prune, even though 90
    // existing keys would otherwise look stale.
    const plan = planPublicationTopicPrune(keys(10), keys(100), 100);
    expect(plan.prune).toBe(false);
    expect(plan.stale).toEqual([]);
  });

  it("allows the first/empty load (live 0 → floor 0)", () => {
    const plan = planPublicationTopicPrune([], [], 0);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("distinguishes keys sharing pmid/cwid but differing in parentTopicId", () => {
    const writes = keys(50); // pmid "0".."49", cwid "a", topic "t1"
    const sameKeyDifferentTopic = k("0", "a", "t2"); // NOT in the write set
    const existing = [...writes, sameKeyDifferentTopic];
    const plan = planPublicationTopicPrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([sameKeyDifferentTopic]);
  });
});
