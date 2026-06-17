/**
 * Startup warm-up safety contract (lib/warmup.ts).
 *
 * The load-bearing guarantee is NOT that the caches get warm — it's that the
 * readiness latch ALWAYS flips within the budget no matter how the dependencies
 * behave. The ECS service runs a deployment circuit breaker with rollback
 * (cdk/lib/app-stack.ts); a task that never reported healthy would roll every
 * deploy back. So a total outage or a hung dependency must still yield a
 * warm-but-degraded task that joins the ALB rotation, never a task left dark.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// All warm-up primers are mocked so this test exercises only the latch / budget
// control flow — no real Prisma, OpenSearch, or search stack is loaded.
const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ping: vi.fn(),
  matchTax: vi.fn(),
  classifier: vi.fn(),
  mentoring: vi.fn(),
  peeps: vi.fn(),
  pubs: vi.fn(),
  spotlights: vi.fn(),
  browse: vi.fn(),
  homeStats: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock("@/lib/search", () => ({ searchClient: () => ({ ping: mocks.ping }) }));
vi.mock("@/lib/api/search-taxonomy", () => ({ matchQueryToTaxonomy: mocks.matchTax }));
vi.mock("@/lib/api/people-classifier-sets", () => ({
  getPeopleClassifierSets: mocks.classifier,
}));
vi.mock("@/lib/api/mentoring-pmids", () => ({ getMentoringPmidBuckets: mocks.mentoring }));
vi.mock("@/lib/api/search", () => ({
  searchPeople: mocks.peeps,
  searchPublications: mocks.pubs,
}));
vi.mock("@/lib/api/home", () => ({
  getSpotlights: mocks.spotlights,
  getBrowseAllResearchAreas: mocks.browse,
  getHomeStats: mocks.homeStats,
}));

import { warmUp, __resetWarmupForTests } from "@/lib/warmup";
import { isWarmed, __resetWarmedForTests } from "@/lib/warmup-state";

describe("warmUp — readiness latch safety contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWarmupForTests();
    __resetWarmedForTests();
    // Worst case by default: every dependency is down.
    mocks.queryRaw.mockRejectedValue(new Error("db down"));
    mocks.ping.mockRejectedValue(new Error("opensearch down"));
    mocks.matchTax.mockRejectedValue(new Error("taxonomy down"));
    mocks.classifier.mockRejectedValue(new Error("classifier down"));
    mocks.mentoring.mockRejectedValue(new Error("reciterdb down"));
    mocks.peeps.mockRejectedValue(new Error("search down"));
    mocks.pubs.mockRejectedValue(new Error("search down"));
    mocks.spotlights.mockRejectedValue(new Error("home down"));
    mocks.browse.mockRejectedValue(new Error("home down"));
    mocks.homeStats.mockRejectedValue(new Error("home down"));
  });

  it("flips the latch even when every dependency fails (never leaves the task dark)", async () => {
    expect(isWarmed()).toBe(false);
    await warmUp();
    expect(isWarmed()).toBe(true);
  });

  it("flips the latch within the budget when a dependency hangs forever", async () => {
    vi.useFakeTimers();
    try {
      mocks.mentoring.mockReturnValue(new Promise(() => {})); // never resolves
      const p = warmUp();
      // Synchronous body done, the budget race is pending → not yet warmed.
      expect(isWarmed()).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      await p;
      expect(isWarmed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only runs once (the boot-time once-guard)", async () => {
    await warmUp();
    mocks.queryRaw.mockClear();
    await warmUp();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
