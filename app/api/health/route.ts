import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Shallow liveness probe for the ALB target-group health check. Returns 200
 * with a fixed body; never touches the database, secrets, or external
 * services. ALB defaults poll this every 30s — anything heavier here would
 * pin the cluster pool or trip the rate limit on a dependency it doesn't
 * actually need.
 *
 * The deeper ETL-freshness health endpoint is at
 * /api/health/refresh-status — separate route, hits Prisma, returns 503
 * when ETL is stale. That one is for ops dashboards / CloudWatch alarms,
 * not for ALB health checks.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true });
}
