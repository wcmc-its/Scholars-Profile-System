import { getHeapStatistics } from "node:v8";

/**
 * Fraction of the V8 heap limit above which a warm task reports unhealthy on
 * `/api/health`. On 2026-11-20/21 prod tasks climbed to "JavaScript heap out of
 * memory" over 15-20 minutes while that check stayed 200, so they took traffic
 * until they crashed. The ALB marks a target unhealthy after 3 failed checks
 * 30s apart (cdk/lib/app-stack.ts), so a task held above this for ~90s is
 * drained and replaced by ECS well before it would OOM.
 *
 * Lives here, not in the route: Next rejects non-config exports from route.ts.
 */
export const HEAP_UNHEALTHY_RATIO = 0.85;

/** Used V8 heap as a fraction of this process's heap limit (--max-old-space-size). */
export function heapUsedRatio(): number {
  const { used_heap_size, heap_size_limit } = getHeapStatistics();
  return used_heap_size / heap_size_limit;
}
