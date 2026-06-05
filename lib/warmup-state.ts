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
 * Module singleton. In the Next.js standalone server the instrumentation hook
 * and every route handler share one Node process, so this flag is process-wide
 * — the same assumption the lazy caches (`getMeshMap`, the People classifier
 * sets, the mentoring buckets) already rely on.
 *
 * This module is intentionally dependency-free so the lightweight `/api/health`
 * route doesn't pull the heavy warm-up import graph (search stack, Prisma) into
 * its bundle just to read a boolean.
 */
let warmed = false;

/** True once this task's startup warm-up pass has completed. */
export function isWarmed(): boolean {
  return warmed;
}

/** Flip the latch on. Idempotent; never un-sets. */
export function markWarmed(): void {
  warmed = true;
}

/** Test-only: reset the latch between cases. */
export function __resetWarmedForTests(): void {
  warmed = false;
}
