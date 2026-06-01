import { afterEach, describe, expect, it, vi } from "vitest";

// The mentoring buckets reach ReciterDB (WCM-side MariaDB) via
// withReciterConnection and Prisma. Mock both so the cache/timeout behaviour can
// be exercised without a real DB. `vi.hoisted` lets the mock factory reference
// the shared spy without a temporal-dead-zone error.
const { withReciterConnection } = vi.hoisted(() => ({
  withReciterConnection: vi.fn(),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: vi.fn(async () => []) },
    postdocMentorRelationship: { findMany: vi.fn(async () => []) },
  },
}));

// Each test needs fresh module-level cache/inflight singletons.
async function freshModule() {
  vi.resetModules();
  return import("@/lib/api/mentoring-pmids");
}

afterEach(() => {
  withReciterConnection.mockReset();
  vi.useRealTimers();
});

describe("getMentoringPmidBuckets resilience (ReciterDB unreachable)", () => {
  it("degrades to empty buckets and negative-caches the failure (no re-query within the window)", async () => {
    // Source 1's withReciterConnection rejects, mimicking the prod
    // `pool failed to retrieve a connection from pool` (45028).
    withReciterConnection.mockRejectedValue(
      new Error("pool failed to retrieve a connection from pool"),
    );
    const mod = await freshModule();

    const first = await mod.getMentoringPmidBuckets();
    expect(first).toEqual(mod.EMPTY_MENTORING_BUCKETS);
    const callsAfterFirst = withReciterConnection.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Within NEGATIVE_TTL_MS the empty result is served from cache — ReciterDB
    // is NOT hit again (the whole point: one slow render per window, not every).
    const second = await mod.getMentoringPmidBuckets();
    expect(second).toEqual(mod.EMPTY_MENTORING_BUCKETS);
    expect(withReciterConnection.mock.calls.length).toBe(callsAfterFirst);
  });

  it("caps a wedged refresh at REFRESH_TIMEOUT_MS and returns empty (no ~10s stall)", async () => {
    const mod = await freshModule();
    vi.useFakeTimers();
    // ReciterDB connection never settles (the mariadb acquireTimeout case).
    withReciterConnection.mockReturnValue(new Promise<never>(() => {}));

    const pending = mod.getMentoringPmidBuckets();
    // Advance past the 2s cap; the race rejects and the caller degrades.
    await vi.advanceTimersByTimeAsync(2100);

    await expect(pending).resolves.toEqual(mod.EMPTY_MENTORING_BUCKETS);
  });

  it("caches a successful (reachable) load and serves it without re-querying", async () => {
    // conn.query returns no rows -> empty-but-OK buckets, cached for the full TTL.
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) =>
        fn({ query: async () => [] }),
    );
    const mod = await freshModule();

    await mod.getMentoringPmidBuckets();
    const n = withReciterConnection.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(1);

    const again = await mod.getMentoringPmidBuckets();
    expect(again).toEqual(mod.EMPTY_MENTORING_BUCKETS);
    // Served from the success cache — no new ReciterDB round-trip.
    expect(withReciterConnection.mock.calls.length).toBe(n);
  });
});
