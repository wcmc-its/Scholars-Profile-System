/**
 * Unit tests for app/api/health/route.ts — the ALB target-group health check.
 *
 * It reports the startup warm-up latch (lib/warmup-state.ts): 503 while a task
 * is still cold, 200 once the warm-up pass completes. The latch is one-way (no
 * flap on a later dependency blip); the only thing that turns a warm task 503
 * is its own V8 heap above HEAP_UNHEALTHY_RATIO (lib/heap-health.ts), so the
 * ALB drains it before it OOMs. Still shallow: it never touches the DB / auth /
 * external services. The deeper ETL-freshness route is tested in
 * health-route.test.ts.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const heapStats = vi.hoisted(() => ({ used_heap_size: 0, heap_size_limit: 1 }));
vi.mock("node:v8", () => ({ getHeapStatistics: () => heapStats }));

import { GET } from "@/app/api/health/route";
import { HEAP_UNHEALTHY_RATIO } from "@/lib/heap-health";
import { isWarmed, markWarmed, __resetWarmedForTests } from "@/lib/warmup-state";

const LIMIT = 3 * 1024 ** 3;
function setHeapRatio(ratio: number): void {
  heapStats.heap_size_limit = LIMIT;
  heapStats.used_heap_size = Math.round(LIMIT * ratio);
}

describe("GET /api/health (ALB readiness latch)", () => {
  beforeEach(() => {
    __resetWarmedForTests();
    setHeapRatio(0.3);
  });

  it("returns 503 + { ok: false, warmed: false } while the task is still cold", async () => {
    expect(isWarmed()).toBe(false);
    const resp = await GET();
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ ok: false, warmed: false });
  });

  it("reports cold, not heap, when a cold task's heap is also high", async () => {
    setHeapRatio(0.95);
    const resp = await GET();
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ ok: false, warmed: false });
  });

  it("returns 200 + { ok: true, warmed: true } once warm with a healthy heap, and stays 200", async () => {
    markWarmed();
    const resp = await GET();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, warmed: true });
    // A second poll never flips back to 503 while the heap stays healthy.
    expect((await GET()).status).toBe(200);
  });

  it("returns 503 + reason heap once warm with the heap above the threshold", async () => {
    markWarmed();
    setHeapRatio(0.9);
    const resp = await GET();
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({
      ok: false,
      warmed: true,
      reason: "heap",
      heapUsedRatio: 0.9,
    });
  });

  it("treats the threshold itself as healthy and recovers when the heap drops", async () => {
    markWarmed();
    setHeapRatio(HEAP_UNHEALTHY_RATIO);
    expect((await GET()).status).toBe(200);
    setHeapRatio(0.86);
    expect((await GET()).status).toBe(503);
    setHeapRatio(0.5);
    expect((await GET()).status).toBe(200);
  });

  it("does not require any environment variables or auth", async () => {
    // ALB health checks can't carry tokens; a probe that 401s when
    // SCHOLARS_HEALTH_TOKEN is set would deregister every task. The verdict is
    // pure in-process state, so a set token never changes it.
    markWarmed();
    const original = process.env.SCHOLARS_HEALTH_TOKEN;
    process.env.SCHOLARS_HEALTH_TOKEN = "any-value";
    try {
      expect((await GET()).status).toBe(200);
    } finally {
      if (original === undefined) {
        delete process.env.SCHOLARS_HEALTH_TOKEN;
      } else {
        process.env.SCHOLARS_HEALTH_TOKEN = original;
      }
    }
  });
});
