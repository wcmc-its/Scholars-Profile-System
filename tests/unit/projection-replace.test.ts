/**
 * Sanity-guard test for `etl/dynamodb/projection-replace.ts` (nightly
 * projection-wipe hardening).
 *
 * `guardedReplace` is the shared atomic rebuild used by Block 3 (topic_assignment)
 * and Block 5 (scholar_tool) in etl/dynamodb/index.ts. The risk it guards: a
 * partial/empty upstream DynamoDB scan wipes a populated table and replaces it
 * with far fewer rows. Unlike the post-write `=== 0` guards, the floor here is
 * relative (max-shrink) AND absolute (min-floor), so a non-empty-but-implausible
 * incoming set (e.g. live 70k, incoming 3k) is also refused — BEFORE any delete.
 *
 * Mirrors the publication-topic-guard test style: mock the Prisma client and
 * assert the GUARD. Covers:
 *   (a) implausible drop (rows far below floor vs. live) -> throws AND
 *       deleteMany is NOT called (the table is never wiped).
 *   (b) normal shrink within threshold -> passes (deleteMany + createMany run).
 *   (c) first/empty load (live 0) -> passes regardless of row count.
 *   (d) replaceFloor pure-threshold boundaries.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// `delegate` lives inside vi.hoisted with the mock fns so the vi.mock factory
// (also hoisted to the top of the file) can close over it without an
// access-before-init error. A SINGLE model delegate stands in for both
// `db.write.<model>` (live count) and `tx.<model>` (the in-transaction writes):
// guardedReplace picks the same delegate off each via `pick`.
const { mockCount, mockDeleteMany, mockCreateMany, mockTransaction, delegate } = vi.hoisted(
  () => {
    const mockCount = vi.fn();
    const mockDeleteMany = vi.fn();
    const mockCreateMany = vi.fn();
    const mockTransaction = vi.fn();
    return {
      mockCount,
      mockDeleteMany,
      mockCreateMany,
      mockTransaction,
      delegate: { count: mockCount, deleteMany: mockDeleteMany, createMany: mockCreateMany },
    };
  },
);

vi.mock("@/lib/db", () => ({
  db: {
    write: {
      topicAssignment: delegate,
      // $transaction runs the interactive callback with a tx client that
      // exposes the same delegate, mirroring Prisma's real shape.
      $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
  },
}));

import {
  guardedReplace,
  replaceFloor,
  MAX_SHRINK_FRACTION,
  MIN_FLOOR,
  type GuardedReplaceOptions,
} from "@/etl/dynamodb/projection-replace";

// Default: $transaction invokes the callback with a tx client carrying the
// delegate, and deleteMany/createMany resolve to plausible counts.
function wireHappyPath() {
  mockTransaction.mockImplementation(
    async (cb: (tx: { topicAssignment: typeof delegate }) => Promise<unknown>) =>
      cb({ topicAssignment: delegate }),
  );
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockCreateMany.mockResolvedValue({ count: 0 });
}

type ScoreData = { score: number };

const baseOpts = (rows: number[]): GuardedReplaceOptions<number, ScoreData> => ({
  table: "topic_assignment",
  rows,
  batchSize: 1000,
  toData: (batch) => batch.map((n) => ({ score: n })),
  // The real `pick` receives `db.write | Prisma.TransactionClient`; under the
  // mock both carry the same `topicAssignment` delegate. Cast the broad client
  // param down to the mock shape — only `topicAssignment` is exercised.
  pick: (client) => (client as unknown as { topicAssignment: typeof delegate }).topicAssignment,
});

describe("guardedReplace sanity guard (projection-wipe hardening)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireHappyPath();
  });

  it("throws on an implausible drop AND never calls deleteMany (the table is not wiped)", async () => {
    // Live 70,000 rows; incoming only 3,000 — a partial/empty upstream scan.
    // Floor = max(50, ceil(70000 * 0.5)) = 35,000, so 3,000 is well below it.
    mockCount.mockResolvedValue(70000);
    const rows = Array.from({ length: 3000 }, (_, i) => i);

    await expect(guardedReplace(baseOpts(rows))).rejects.toThrow(
      /topic_assignment sanity guard: incoming 3000 rows is below the floor 35000 \(live 70000/,
    );
    // The guard runs BEFORE the transaction, so nothing was deleted or inserted.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it("passes a normal shrink within the threshold — deleteMany + createMany run", async () => {
    // Live 70,000; incoming 65,000 (a ~7% drop) is comfortably above the
    // 35,000 floor, so the rebuild proceeds.
    mockCount.mockResolvedValue(70000);
    const rows = Array.from({ length: 65000 }, (_, i) => i);

    const inserted = await guardedReplace(baseOpts(rows));

    expect(inserted).toBe(65000);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    // 65,000 rows / 1,000 batch = 65 createMany calls.
    expect(mockCreateMany).toHaveBeenCalledTimes(65);
  });

  it("passes a first/empty load (live 0) regardless of incoming count", async () => {
    mockCount.mockResolvedValue(0);
    const rows = Array.from({ length: 5 }, (_, i) => i);

    const inserted = await guardedReplace(baseOpts(rows));

    expect(inserted).toBe(5);
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
  });

  it("replaceFloor: relative floor for large tables, min-floor for small, 0 for empty", () => {
    expect(replaceFloor(0)).toBe(0); // first/empty load always allowed
    expect(replaceFloor(70000)).toBe(70000 * (1 - MAX_SHRINK_FRACTION)); // 35000
    expect(replaceFloor(80)).toBe(MIN_FLOOR); // ceil(80*0.5)=40 < 50 -> floor at MIN_FLOOR
  });
});
