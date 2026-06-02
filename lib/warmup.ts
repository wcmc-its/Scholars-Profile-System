/**
 * Startup cache + connection-pool warm-up. Fired once from the `instrumentation.ts`
 * register() hook (where OTel init also lives), in the Node server runtime only.
 *
 * Why. The SPS app runs on always-on ECS Fargate (it never scales to zero), so
 * this is not a Lambda-style cold start. The latency users hit is the one-time
 * cost the FIRST request to a freshly placed task pays: building the MeSH
 * descriptor map (`getMeshMap`, via the taxonomy resolver), the People
 * classifier sets, and the mentoring-pmid buckets — all lazy-on-first-use — plus
 * opening the OpenSearch, Prisma, and ReciterDB connection pools. Priming them at
 * boot moves that cost off the first user request. Combined with the readiness
 * latch ({@link file://./warmup-state.ts}, surfaced at `/api/health`), a task
 * also stays OUT of the ALB rotation until this pass finishes, so users are never
 * routed to a cold task in the first place.
 *
 * HARD SAFETY CONTRACT — the task is NEVER left dark. Every primer is
 * individually best-effort (a rejection can't abort the others and can't surface
 * as an unhandled rejection), the whole pass is bounded by {@link WARMUP_BUDGET_MS},
 * and {@link markWarmed} runs in `finally`. So the latch ALWAYS flips within the
 * budget regardless of how the primers fare. This is load-bearing: the ECS
 * service runs a deployment circuit breaker with rollback (cdk/lib/app-stack.ts).
 * A task that never reported healthy would roll every deploy back. A degraded
 * dependency must therefore yield a warm-but-degraded task that serves (the same
 * resilience the old shallow check gave) — not a task stuck out of rotation.
 *
 * Fire-and-forget. register() does not await this, so boot/liveness isn't
 * blocked. Primers that outlive the budget keep running and populate their caches
 * when they eventually resolve — a free bonus once the latch is already set.
 */
import { markWarmed } from "@/lib/warmup-state";
import { prisma } from "@/lib/db";
import { searchClient } from "@/lib/search";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { getPeopleClassifierSets } from "@/lib/api/people-classifier-sets";
import { getMentoringPmidBuckets } from "@/lib/api/mentoring-pmids";
import { searchPeople, searchPublications } from "@/lib/api/search";

/**
 * Upper bound on the warm-up pass. The latch flips no later than this after a
 * task starts. Sized comfortably under the ECS health-check grace period
 * (cdk/lib/app-stack.ts) and below the ALB's first poll interval (30s), so in
 * the happy path the task's very first health poll already sees 200 and
 * time-to-healthy is unchanged from before.
 */
const WARMUP_BUDGET_MS = 15_000;

/**
 * A neutral, always-runnable query that exercises the taxonomy resolver (≥ 3
 * chars, so the resolver isn't short-circuited) and both search corpora without
 * depending on any one MeSH descriptor existing in the loaded ETL data.
 */
const WARMUP_QUERY = "cancer";

let started = false;

/** Resolve when every task settles OR the budget elapses, whichever is first. */
async function settleWithin(ms: number, tasks: Promise<unknown>[]): Promise<void> {
  const all = Promise.allSettled(tasks).then(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    const t: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);
    // Never let the budget timer itself keep the process alive.
    t.unref?.();
  });
  await Promise.race([all, timeout]);
}

/**
 * Run the warm-up pass once. Subsequent calls are no-ops (register() fires it
 * once, but the guard keeps a stray double-invoke — e.g. dev HMR — cheap).
 */
export async function warmUp(): Promise<void> {
  if (started) return;
  started = true;
  try {
    // Each primer is `.catch`-wrapped so a single failure can't reject the
    // aggregate or escape as an unhandled rejection. We discard the results —
    // the only thing that matters is the side effect of populating the
    // module-level caches and opening the connection pools.
    const primers: Promise<unknown>[] = [
      prisma.$queryRaw`SELECT 1`,
      searchClient().ping(),
      matchQueryToTaxonomy(WARMUP_QUERY),
      getPeopleClassifierSets(),
      getMentoringPmidBuckets(),
      searchPeople({ q: WARMUP_QUERY, countOnly: true }),
      searchPublications({ q: WARMUP_QUERY, countOnly: true }),
    ].map((p) => p.catch(() => undefined));
    await settleWithin(WARMUP_BUDGET_MS, primers);
  } finally {
    // Join the ALB rotation now: warm in the happy path, degraded-but-serving
    // if a dependency was down. NEVER left dark — see the safety contract above.
    markWarmed();
  }
}

/** Test-only: reset the once-guard so a fresh `warmUp()` can run. */
export function __resetWarmupForTests(): void {
  started = false;
}
