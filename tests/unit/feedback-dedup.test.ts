/**
 * `isDuplicateSubmission` (#538 anti-spam option A) — duplicate-content
 * guard. Verifies the OR-of-clauses query is built correctly, the
 * window cutoff is computed against the passed `now`, and the
 * fast-path (no text fields at all) skips the DB round-trip.
 */
import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  DEDUP_WINDOW_MINUTES,
  isDuplicateSubmission,
  type DedupCandidate,
} from "@/lib/feedback/dedup";

type StubDb = Pick<PrismaClient, "feedbackSubmission"> & {
  _findFirst: ReturnType<typeof vi.fn>;
};

/** Hand-rolled stub: captures the args + returns whatever the test asks.
 *  The cast through `unknown` is acceptable here — the helper only uses
 *  `feedbackSubmission.findFirst`, and forcing every test to provide a
 *  full Prisma delegate would obscure intent. */
function stubDb(returnRow: { id: string } | null): StubDb {
  const findFirst = vi.fn().mockResolvedValue(returnRow);
  return {
    feedbackSubmission: { findFirst },
    _findFirst: findFirst,
  } as unknown as StubDb;
}

const FROZEN_NOW = new Date("2026-05-28T15:00:00.000Z");

const EMPTY: DedupCandidate = {
  whatHelped: null,
  whatMissing: null,
  oneChange: null,
  taskFailureIntent: null,
};

describe("isDuplicateSubmission", () => {
  it("fast-paths to false when every field is null (metric-only submission)", async () => {
    const db = stubDb(null);
    const result = await isDuplicateSubmission(db, EMPTY, FROZEN_NOW);
    expect(result).toBe(false);
    expect(db._findFirst).not.toHaveBeenCalled();
  });

  it("returns true when the DB finds a matching row", async () => {
    const db = stubDb({ id: "match-row" });
    const result = await isDuplicateSubmission(
      db,
      { ...EMPTY, whatHelped: "duplicate text" },
      FROZEN_NOW,
    );
    expect(result).toBe(true);
  });

  it("returns false when the DB finds no matching row", async () => {
    const db = stubDb(null);
    const result = await isDuplicateSubmission(
      db,
      { ...EMPTY, oneChange: "unique change" },
      FROZEN_NOW,
    );
    expect(result).toBe(false);
  });

  it("queries with a cutoff = now - DEDUP_WINDOW_MINUTES", async () => {
    const db = stubDb(null);
    await isDuplicateSubmission(db, { ...EMPTY, whatHelped: "x" }, FROZEN_NOW);
    const call = db._findFirst.mock.calls[0][0];
    const expected = new Date(FROZEN_NOW.getTime() - DEDUP_WINDOW_MINUTES * 60 * 1000);
    expect(call.where.submittedAt.gte.toISOString()).toBe(expected.toISOString());
  });

  it("only includes non-null fields in the OR clause", async () => {
    const db = stubDb(null);
    await isDuplicateSubmission(
      db,
      { whatHelped: "A", whatMissing: null, oneChange: "B", taskFailureIntent: null },
      FROZEN_NOW,
    );
    const call = db._findFirst.mock.calls[0][0];
    expect(call.where.OR).toEqual([{ whatHelped: "A" }, { oneChange: "B" }]);
  });

  it("includes every text field when all are present", async () => {
    const db = stubDb(null);
    await isDuplicateSubmission(
      db,
      {
        whatHelped: "h",
        whatMissing: "m",
        oneChange: "o",
        taskFailureIntent: "t",
      },
      FROZEN_NOW,
    );
    const call = db._findFirst.mock.calls[0][0];
    expect(call.where.OR).toHaveLength(4);
    expect(call.where.OR).toEqual(
      expect.arrayContaining([
        { whatHelped: "h" },
        { whatMissing: "m" },
        { oneChange: "o" },
        { taskFailureIntent: "t" },
      ]),
    );
  });

  it("treats empty string as null (skips the clause)", async () => {
    const db = stubDb(null);
    await isDuplicateSubmission(
      db,
      { whatHelped: "", whatMissing: null, oneChange: "real", taskFailureIntent: null },
      FROZEN_NOW,
    );
    const call = db._findFirst.mock.calls[0][0];
    expect(call.where.OR).toEqual([{ oneChange: "real" }]);
  });

  it("uses Date.now() by default when no `now` is passed", async () => {
    const db = stubDb(null);
    const before = Date.now();
    await isDuplicateSubmission(db, { ...EMPTY, whatHelped: "x" });
    const after = Date.now();
    const call = db._findFirst.mock.calls[0][0];
    const cutoffMs = call.where.submittedAt.gte.getTime();
    // The cutoff should be roughly 60 minutes before "now", within the
    // test execution window
    const windowMs = DEDUP_WINDOW_MINUTES * 60 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - windowMs);
    expect(cutoffMs).toBeLessThanOrEqual(after - windowMs);
  });

  it("DEDUP_WINDOW_MINUTES is documented at 60", () => {
    expect(DEDUP_WINDOW_MINUTES).toBe(60);
  });
});
