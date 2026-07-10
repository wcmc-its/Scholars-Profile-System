import { NextResponse } from "next/server";
import { isWarmed } from "@/lib/warmup-state";

export const dynamic = "force-dynamic";

/**
 * ALB target-group health check. Shallow by design — it reads ONE in-memory
 * flag and never touches the database, secrets, or external services. A deep
 * check here would pull every task out of rotation on a transient dependency
 * blip (see `app/readiness/route.ts` for the deep probe, used by the deploy
 * smoke test and operators, deliberately NOT by the ALB).
 *
 * The flag is the startup warm-up latch (`lib/warmup-state.ts`): false until
 * this task's one-time warm-up pass (`lib/warmup.ts`) completes, true forever
 * after. Returning 503 while cold keeps a freshly placed task OUT of the ALB
 * rotation until its lazy caches + connection pools are primed, so the first
 * real user request doesn't pay the warm-up cost. Because the latch is one-way,
 * a later DB / OpenSearch blip never flips it back — once warm this stays a
 * cheap, non-flapping liveness signal, exactly like the old shallow check.
 *
 * The warm-up self-bounds (WARMUP_BUDGET_MS ~15s and always latches), so this
 * can report 503 for at most that window after a task starts — well inside the
 * ECS health-check grace period (cdk/lib/app-stack.ts) and the deployment
 * circuit breaker's tolerance, so it can never wedge a deploy.
 *
 * ETL freshness is monitored in-VPC by the #595 `etl:freshness` Step Functions
 * step, which reads `etl_run` directly. There is no HTTP freshness endpoint.
 */
export async function GET(): Promise<NextResponse> {
  const warmed = isWarmed();
  return NextResponse.json({ ok: warmed, warmed }, { status: warmed ? 200 : 503 });
}
