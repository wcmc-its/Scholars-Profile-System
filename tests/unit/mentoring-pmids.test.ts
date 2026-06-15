import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mentoring buckets reach ReciterDB (WCM-side MariaDB) via
// withReciterConnection and Prisma. Mock both so the cache/timeout behaviour can
// be exercised without a real DB. `vi.hoisted` lets the mock factory reference
// the shared spy without a temporal-dead-zone error.
const { withReciterConnection } = vi.hoisted(() => ({
  withReciterConnection: vi.fn(),
}));

// #928 P2 — the bridge path (MENTORING_COPUB_BRIDGE on) derives buckets from
// these local tables instead of ReciterDB.
const { phdFindMany, postdocFindMany, aocFindMany, copubPubFindMany } = vi.hoisted(() => ({
  phdFindMany: vi.fn(async () => [] as unknown[]),
  postdocFindMany: vi.fn(async () => [] as unknown[]),
  aocFindMany: vi.fn(async () => [] as unknown[]),
  copubPubFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany },
    postdocMentorRelationship: { findMany: postdocFindMany },
    aocMentee: { findMany: aocFindMany },
    menteeCopublicationPub: { findMany: copubPubFindMany },
  },
}));

// Each test needs fresh module-level cache/inflight singletons.
async function freshModule() {
  vi.resetModules();
  return import("@/lib/api/mentoring-pmids");
}

beforeEach(() => {
  // Default: flag OFF (live ReciterDB path) and empty local tables.
  delete process.env.MENTORING_COPUB_BRIDGE;
  phdFindMany.mockResolvedValue([]);
  postdocFindMany.mockResolvedValue([]);
  aocFindMany.mockResolvedValue([]);
  copubPubFindMany.mockResolvedValue([]);
});

afterEach(() => {
  withReciterConnection.mockReset();
  delete process.env.MENTORING_COPUB_BRIDGE;
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

describe("getMentoringPmidBuckets — bridge derivation (MENTORING_COPUB_BRIDGE on, issue #928 P2)", () => {
  beforeEach(() => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    // ReciterDB must never be touched on the bridge path.
    withReciterConnection.mockRejectedValue(
      new Error("ReciterDB must not be touched when the bridge is on"),
    );
  });

  it("derives the buckets from local tables and never calls ReciterDB", async () => {
    // s1 is an AOC student who is also tagged MDPHD (same pair, two programs);
    // s2 is AOC-2025 (-> md); s3 is a PhD mentee; s4 is a postdoc; the (mX,sX)
    // co-pub has no program record so it lands in `all` only.
    aocFindMany.mockResolvedValue([
      { mentorCwid: "m1", menteeCwid: "s1", programType: "AOC" },
      { mentorCwid: "m1", menteeCwid: "s1", programType: "MDPHD" },
      { mentorCwid: "m2", menteeCwid: "s2", programType: "AOC-2025" },
    ]);
    phdFindMany.mockResolvedValue([
      { mentorCwid: "m3", menteeCwid: "s3", programType: "PhD" },
    ]);
    postdocFindMany.mockResolvedValue([{ mentorCwid: "m4", menteeCwid: "s4" }]);
    copubPubFindMany.mockResolvedValue([
      { mentorCwid: "m1", menteeCwid: "s1", pmid: 111 },
      { mentorCwid: "m2", menteeCwid: "s2", pmid: 222 },
      { mentorCwid: "m3", menteeCwid: "s3", pmid: 333 },
      { mentorCwid: "m4", menteeCwid: "s4", pmid: 444 },
      { mentorCwid: "mX", menteeCwid: "sX", pmid: 555 },
    ]);

    const mod = await freshModule();
    const buckets = await mod.getMentoringPmidBuckets();

    expect(withReciterConnection).not.toHaveBeenCalled();
    expect(new Set(buckets.all)).toEqual(new Set(["111", "222", "333", "444", "555"]));
    // pmid 111's pair is both AOC (-> md) and MDPHD (-> mdphd).
    expect(new Set(buckets.byProgram.md)).toEqual(new Set(["111", "222"]));
    expect(buckets.byProgram.mdphd).toEqual(["111"]);
    expect(buckets.byProgram.phd).toEqual(["333"]);
    expect(buckets.byProgram.postdoc).toEqual(["444"]);
    expect(buckets.byProgram.ecr).toEqual([]);
  });

  it("yields empty buckets (honest degradation) when the bridge table is empty / not yet imported", async () => {
    copubPubFindMany.mockResolvedValue([]);
    const mod = await freshModule();

    const buckets = await mod.getMentoringPmidBuckets();
    expect(buckets).toEqual(mod.EMPTY_MENTORING_BUCKETS);
    expect(withReciterConnection).not.toHaveBeenCalled();
  });
});
