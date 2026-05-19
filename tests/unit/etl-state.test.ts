/**
 * Unit tests for lib/etl-state.ts — the reciter→dynamodb consistency
 * window (#118 / B19). Covers the window predicate's boundaries and the
 * mark/clear writers.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    read: { etlState: { findUnique: vi.fn() } },
    write: { etlState: { upsert: vi.fn() } },
  },
}));

import { db } from "@/lib/db";
import {
  isTopicRebuildWindowOpen,
  markTopicRebuildStarted,
  clearTopicRebuildWindow,
  TOPIC_REBUILD_WINDOW_MS,
} from "@/lib/etl-state";

const findUnique = db.read.etlState.findUnique as unknown as Mock;
const upsert = db.write.etlState.upsert as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isTopicRebuildWindowOpen", () => {
  const now = new Date("2026-05-18T12:00:00.000Z");

  it("no etl_state row → window closed", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await isTopicRebuildWindowOpen(now)).toBe(false);
  });

  it("lastTopicRebuildAt null (dynamodb cleared it) → closed", async () => {
    findUnique.mockResolvedValueOnce({ id: 1, lastTopicRebuildAt: null });
    expect(await isTopicRebuildWindowOpen(now)).toBe(false);
  });

  it("rebuild 10 min ago → open", async () => {
    findUnique.mockResolvedValueOnce({
      id: 1,
      lastTopicRebuildAt: new Date(now.getTime() - 10 * 60 * 1000),
    });
    expect(await isTopicRebuildWindowOpen(now)).toBe(true);
  });

  it("rebuild 40 min ago → closed (30-min auto-expiry)", async () => {
    findUnique.mockResolvedValueOnce({
      id: 1,
      lastTopicRebuildAt: new Date(now.getTime() - 40 * 60 * 1000),
    });
    expect(await isTopicRebuildWindowOpen(now)).toBe(false);
  });

  it("rebuild exactly 30 min ago → closed (strict <)", async () => {
    findUnique.mockResolvedValueOnce({
      id: 1,
      lastTopicRebuildAt: new Date(now.getTime() - TOPIC_REBUILD_WINDOW_MS),
    });
    expect(await isTopicRebuildWindowOpen(now)).toBe(false);
  });

  it("lastTopicRebuildAt in the future (clock skew) → open", async () => {
    findUnique.mockResolvedValueOnce({
      id: 1,
      lastTopicRebuildAt: new Date(now.getTime() + 60 * 1000),
    });
    expect(await isTopicRebuildWindowOpen(now)).toBe(true);
  });
});

describe("window writers", () => {
  it("markTopicRebuildStarted upserts id 1 with a fresh timestamp", async () => {
    await markTopicRebuildStarted();
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 1 });
    expect(arg.create.lastTopicRebuildAt).toBeInstanceOf(Date);
    expect(arg.update.lastTopicRebuildAt).toBeInstanceOf(Date);
  });

  it("clearTopicRebuildWindow upserts id 1 with lastTopicRebuildAt null", async () => {
    await clearTopicRebuildWindow();
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 1 });
    expect(arg.create.lastTopicRebuildAt).toBeNull();
    expect(arg.update.lastTopicRebuildAt).toBeNull();
  });
});
