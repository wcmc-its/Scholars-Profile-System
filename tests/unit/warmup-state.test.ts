/**
 * Unit tests for lib/warmup-state.ts — the startup readiness latch.
 *
 * The latch is reached from TWO separate Next.js bundles: instrumentation.ts's
 * dynamic `import("./lib/warmup")` (which calls markWarmed) and
 * app/api/health/route.ts's static `import … from "@/lib/warmup-state"` (which
 * calls isWarmed). In the standalone build those are distinct module copies, so
 * a module-level `let` gives each its own flag — markWarmed() flips one copy
 * while isWarmed() reads another that stays false, and the task 503s forever
 * (the #695 regression). The latch must therefore live on a process-global slot.
 * These tests pin that mechanism so a refactor back to module-local state is
 * caught here, not by a wedged deploy.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { isWarmed, markWarmed, __resetWarmedForTests } from "@/lib/warmup-state";

const WARMED_KEY = Symbol.for("sps.warmup.latched");
const slot = (): unknown => (globalThis as Record<symbol, unknown>)[WARMED_KEY];

describe("warmup-state latch", () => {
  beforeEach(() => __resetWarmedForTests());

  it("starts cold", () => {
    expect(isWarmed()).toBe(false);
  });

  it("markWarmed() flips it on — idempotent and one-way", () => {
    markWarmed();
    expect(isWarmed()).toBe(true);
    markWarmed();
    expect(isWarmed()).toBe(true);
  });

  it("stores the flag on globalThis under the registry symbol, not a module-local let", () => {
    markWarmed();
    expect(slot()).toBe(true);
  });

  it("reflects a write made through the global slot by another module copy", () => {
    // Simulate the instrumentation-bundle copy flipping the shared global; the
    // route-bundle copy (this import) MUST observe it. A module-level `let`
    // fails this assertion — which is exactly the deploy-wedging #695 bug.
    expect(isWarmed()).toBe(false);
    (globalThis as Record<symbol, unknown>)[WARMED_KEY] = true;
    expect(isWarmed()).toBe(true);
  });

  it("requires an exact boolean true (no coercion of a stray global value)", () => {
    (globalThis as Record<symbol, unknown>)[WARMED_KEY] = 1;
    expect(isWarmed()).toBe(false);
  });
});
