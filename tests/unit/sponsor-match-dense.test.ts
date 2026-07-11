/**
 * Dense Stage-2 axis (design §16-Q0 path c): paste vector + scholar vectors +
 * fused re-rank. Pure `fuseDenseRerank`/`denseWeight` need no mocks; the vector
 * builders mock `publication_topic.groupBy` (never live MySQL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGroupBy } = vi.hoisted(() => ({ mockGroupBy: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { read: { publicationTopic: { groupBy: mockGroupBy } } },
}));

import {
  denseWeight,
  fuseDenseRerank,
  pasteTopicVector,
  scholarTopicVectors,
} from "@/lib/api/sponsor-match-dense";

const magnitude = (m: Map<string, number>) =>
  Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0));

beforeEach(() => vi.clearAllMocks());

describe("denseWeight (env knob)", () => {
  const KEY = "SPONSOR_MATCH_DENSE_WEIGHT";
  afterEach(() => delete process.env[KEY]);
  it("defaults to 0 (dense off) when unset", () => {
    delete process.env[KEY];
    expect(denseWeight()).toBe(0);
  });
  it("parses a valid weight", () => {
    process.env[KEY] = "0.5";
    expect(denseWeight()).toBe(0.5);
  });
  it("clamps to [0,1] and treats garbage as 0", () => {
    process.env[KEY] = "2";
    expect(denseWeight()).toBe(1);
    process.env[KEY] = "-1";
    expect(denseWeight()).toBe(0);
    process.env[KEY] = "abc";
    expect(denseWeight()).toBe(0);
  });
});

describe("fuseDenseRerank (Stage-2 blend)", () => {
  it("wDense=0 ⇒ pure term order, dense ignored (no-op path)", () => {
    const items = [
      { cwid: "a", termScore: 2, denseScore: 0 },
      { cwid: "b", termScore: 1, denseScore: 9 }, // high dense must NOT matter at w=0
    ];
    expect(fuseDenseRerank(items, 0)).toEqual(["a", "b"]);
  });

  it("wDense=1 ⇒ pure dense order", () => {
    const items = [
      { cwid: "a", termScore: 9, denseScore: 0.1 },
      { cwid: "b", termScore: 1, denseScore: 0.9 },
    ];
    expect(fuseDenseRerank(items, 1)).toEqual(["b", "a"]);
  });

  it("a blend can flip the order the terms axis alone would give", () => {
    const items = [
      { cwid: "a", termScore: 1.0, denseScore: 0 },
      { cwid: "b", termScore: 0.9, denseScore: 1 },
    ];
    expect(fuseDenseRerank(items, 0)).toEqual(["a", "b"]); // terms: a ahead
    expect(fuseDenseRerank(items, 0.5)).toEqual(["b", "a"]); // dense pulls b ahead
  });

  it("ties keep input order (stable); empty ⇒ empty", () => {
    const tied = [
      { cwid: "a", termScore: 1, denseScore: 1 },
      { cwid: "b", termScore: 1, denseScore: 1 },
    ];
    expect(fuseDenseRerank(tied, 0.5)).toEqual(["a", "b"]);
    expect(fuseDenseRerank([], 0.5)).toEqual([]);
  });
});

describe("pasteTopicVector", () => {
  it("relevance-weights, dedupes (pmid,topic), and L2-normalizes", async () => {
    mockGroupBy.mockResolvedValue([
      { pmid: "p1", parentTopicId: "t1", _max: { score: 4 } },
      { pmid: "p2", parentTopicId: "t1", _max: { score: 2 } },
      { pmid: "p1", parentTopicId: "t2", _max: { score: 1 } },
    ]);
    const v = await pasteTopicVector(new Map([["p1", 1], ["p2", 0.5]]));
    // t1 = 1·4 + 0.5·2 = 5 ; t2 = 1·1 = 1 ; norm = sqrt(26)
    expect(v.get("t1")).toBeCloseTo(5 / Math.sqrt(26), 6);
    expect(v.get("t2")).toBeCloseTo(1 / Math.sqrt(26), 6);
    expect(magnitude(v)).toBeCloseTo(1, 6);
  });

  it("empty rel ⇒ empty vector, no query", async () => {
    const v = await pasteTopicVector(new Map());
    expect(v.size).toBe(0);
    expect(mockGroupBy).not.toHaveBeenCalled();
  });
});

describe("scholarTopicVectors (batched)", () => {
  it("builds one L2-normalized vector per cwid", async () => {
    mockGroupBy.mockResolvedValue([
      { cwid: "a", parentTopicId: "t1", year: 2024, authorPosition: "last", _sum: { score: 5 } },
      { cwid: "a", parentTopicId: "t2", year: 2024, authorPosition: "last", _sum: { score: 5 } },
      { cwid: "b", parentTopicId: "t1", year: 2024, authorPosition: "last", _sum: { score: 5 } },
    ]);
    const vecs = await scholarTopicVectors(["a", "b"], new Date("2026-01-01T00:00:00Z"));
    expect(vecs.get("a")!.size).toBe(2);
    expect(magnitude(vecs.get("a")!)).toBeCloseTo(1, 6);
    expect(magnitude(vecs.get("b")!)).toBeCloseTo(1, 6);
  });

  it("no cwids ⇒ empty, no query", async () => {
    const vecs = await scholarTopicVectors([]);
    expect(vecs.size).toBe(0);
    expect(mockGroupBy).not.toHaveBeenCalled();
  });
});
