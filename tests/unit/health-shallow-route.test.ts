/**
 * Unit tests for app/api/health/route.ts — the ALB target-group health check.
 *
 * It reports the startup warm-up latch (lib/warmup-state.ts): 503 while a task
 * is still cold, 200 once the warm-up pass completes — and 200 forever after
 * (one-way; no flap on a later dependency blip). Still shallow: it reads one
 * in-memory flag and never touches the DB / auth / external services. The
 * deeper ETL-freshness route is tested in health-route.test.ts.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { GET } from "@/app/api/health/route";
import { isWarmed, markWarmed, __resetWarmedForTests } from "@/lib/warmup-state";

describe("GET /api/health (ALB readiness latch)", () => {
  beforeEach(() => __resetWarmedForTests());

  it("returns 503 + { ok: false, warmed: false } while the task is still cold", async () => {
    expect(isWarmed()).toBe(false);
    const resp = await GET();
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ ok: false, warmed: false });
  });

  it("returns 200 + { ok: true, warmed: true } once warm, and stays 200 (one-way)", async () => {
    markWarmed();
    const resp = await GET();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, warmed: true });
    // A second poll never re-probes or flips back to 503.
    expect((await GET()).status).toBe(200);
  });

  it("does not require any environment variables or auth", async () => {
    // ALB health checks can't carry tokens; a probe that 401s when
    // SCHOLARS_HEALTH_TOKEN is set would deregister every task. The verdict is
    // pure in-memory latch state, so a set token never changes it.
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
