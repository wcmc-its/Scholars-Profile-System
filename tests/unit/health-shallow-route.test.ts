/**
 * Unit tests for app/api/health/route.ts — the shallow liveness probe for
 * the ALB target-group health check. Distinct from the deeper
 * /api/health/refresh-status route tested in health-route.test.ts.
 */
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health (shallow liveness)", () => {
  it("returns 200 with { ok: true }", async () => {
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ ok: true });
  });

  it("does not require any environment variables or auth", async () => {
    // The shallow probe must work even with a blank env — ALB health checks
    // can't carry tokens, and a probe that 401s when SCHOLARS_HEALTH_TOKEN
    // is set would deregister every task in the target group.
    const original = process.env.SCHOLARS_HEALTH_TOKEN;
    process.env.SCHOLARS_HEALTH_TOKEN = "any-value";
    try {
      const resp = await GET();
      expect(resp.status).toBe(200);
    } finally {
      if (original === undefined) {
        delete process.env.SCHOLARS_HEALTH_TOKEN;
      } else {
        process.env.SCHOLARS_HEALTH_TOKEN = original;
      }
    }
  });
});
