/**
 * `lib/api/popover-context.ts` — `fetchRecentPubs` source switch (issue #928 P2).
 *
 * `fetchRecentPubs` is the only ReciterDB-backed lookup in the popover-context
 * module (every sibling already reads local tables). In-VPC the live ReciterDB
 * query is unreachable, so when MENTORING_COPUB_BRIDGE is on it reads the
 * scholar's recent CONFIRMED pubs from the local publication_author +
 * publication tables instead. Off ⇒ the live query, unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withReciterConnection } = vi.hoisted(() => ({ withReciterConnection: vi.fn() }));
const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn(async () => [] as unknown[]) }));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@/lib/api/manual-layer", () => ({
  loadHiddenAuthorshipCounts: vi.fn(async () => new Map()),
}));

import { fetchRecentPubs } from "@/lib/api/popover-context";

beforeEach(() => {
  delete process.env.MENTORING_COPUB_BRIDGE;
  queryRaw.mockResolvedValue([]);
});

afterEach(() => {
  withReciterConnection.mockReset();
  queryRaw.mockReset();
  delete process.env.MENTORING_COPUB_BRIDGE;
});

describe("fetchRecentPubs — source switch (issue #928 P2)", () => {
  it("flag ON: reads recent confirmed pubs from local tables, never ReciterDB", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    queryRaw.mockResolvedValue([
      { pmid: "222", title: "Newer", year: 2023 },
      { pmid: "111", title: "Older", year: 2021 },
    ]);

    const pubs = await fetchRecentPubs("aog2001", 2);

    expect(withReciterConnection).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(pubs).toEqual([
      { pmid: "222", title: "Newer", year: 2023 },
      { pmid: "111", title: "Older", year: 2021 },
    ]);
  });

  it("flag OFF: reads from the live ReciterDB query, never the local table", async () => {
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) =>
        fn({ query: async () => [{ pmid: 111, title: "Live paper", year: 2020 }] }),
    );

    const pubs = await fetchRecentPubs("aog2001", 2);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(withReciterConnection).toHaveBeenCalledTimes(1);
    expect(pubs).toEqual([{ pmid: "111", title: "Live paper", year: 2020 }]);
  });

  it("returns [] for an empty cwid without touching either source", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    expect(await fetchRecentPubs("", 2)).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(withReciterConnection).not.toHaveBeenCalled();
  });

  it("flag ON: degrades to [] (no throw) when the local query fails", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    queryRaw.mockRejectedValue(new Error("aurora down"));
    expect(await fetchRecentPubs("aog2001", 2)).toEqual([]);
  });
});
