/**
 * One-way "this task has finished its startup warm-up pass" latch.
 *
 * Shared between the warm-up routine ({@link file://./warmup.ts}, fired from
 * the `instrumentation.ts` register() hook at boot) and the ALB target-group
 * health route (`app/api/health/route.ts`). The flag starts `false` and flips
 * to `true` exactly once — when the warm-up pass completes — and NEVER flips
 * back.
 *
 * Why one-way. The ALB health check decides whether a task receives traffic.
 * Reporting this latch (503 while cold, 200 forever after) keeps a freshly
 * placed, cold task OUT of rotation until its lazy caches + connection pools
 * are primed — WITHOUT turning the health check into a continuous deep probe.
 * A continuous deep probe would pull EVERY task out of rotation on a transient
 * DB / OpenSearch blip — the documented reason the ALB check is shallow today
 * (`app/readiness/route.ts`). The latch adds "don't route cold tasks" without
 * adding "flap on dependency blips".
 *
 * Why globalThis, NOT a module-level `let`. `register()` reaches this module
 * through a DYNAMIC `import("./lib/warmup")`; `/api/health` reaches it through a
 * STATIC `import … from "@/lib/warmup-state"`. In the Next.js standalone build
 * those two entry points compile into SEPARATE bundles, each carrying its own
 * copy of this module — so a module-level `let` is duplicated: `markWarmed()`
 * flips the instrumentation copy while `isWarmed()` in the route reads a second
 * copy that stays `false`. The task then 503s forever, the ECS deployment
 * circuit breaker rolls the deploy back, and no new task can ever go healthy
 * (the #695 regression this fixes; it only bites the standalone build, so
 * `next dev` and unit tests never saw it). Sharing one Node *process* is NOT
 * the same as sharing one *module instance*. Anchoring the flag on `globalThis`
 * via a registry `Symbol.for()` makes it genuinely process-wide: every
 * duplicated copy of this module resolves the same symbol and the same slot.
 * (The lazy caches it sits beside — `getMeshMap`, the classifier sets — are each
 * imported from a single graph, so they never hit this; this latch is the one
 * piece of module state read from two.)
 *
 * This module stays intentionally dependency-free so the lightweight
 * `/api/health` route doesn't pull the heavy warm-up import graph (search stack,
 * Prisma) into its bundle just to read a boolean.
 */

// `Symbol.for()` keys the GLOBAL symbol registry, so it returns the identical
// symbol from any bundle copy of this module — the load-bearing detail that lets
// the two compiled copies share one slot on `globalThis`.
const WARMED_KEY = Symbol.for("sps.warmup.latched");

type LatchGlobal = typeof globalThis & { [WARMED_KEY]?: boolean };

/** True once this task's startup warm-up pass has completed. */
export function isWarmed(): boolean {
  return (globalThis as LatchGlobal)[WARMED_KEY] === true;
}

/** Flip the latch on. Idempotent; never un-sets. */
export function markWarmed(): void {
  (globalThis as LatchGlobal)[WARMED_KEY] = true;
}

/** Test-only: reset the latch between cases. */
export function __resetWarmedForTests(): void {
  (globalThis as LatchGlobal)[WARMED_KEY] = false;
}
