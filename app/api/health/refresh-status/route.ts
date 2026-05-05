import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Phase 4h: ETL health endpoint per Q5'. Returns the last successful run per
 * source and a freshness flag (>26h stale = not green). Production CloudWatch
 * alarm queries this.
 *
 * Auth: Phase 7 will gate this behind admin SAML (T-07-health-auth).
 * Stopgap: if SCHOLARS_HEALTH_TOKEN is set, require a matching
 * `Authorization: Bearer <token>` header (consistent with SCHOLARS_REVALIDATE_TOKEN).
 */
export async function GET(request: NextRequest) {
  const healthToken = process.env.SCHOLARS_HEALTH_TOKEN;
  if (healthToken) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader !== `Bearer ${healthToken}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const sources = ["ED", "ReCiter", "ASMS", "InfoEd", "COI", "ReCiterAI-projection", "OpenSearch-index"];
  const out: Array<{
    source: string;
    lastSuccessAt: string | null;
    hoursSinceSuccess: number | null;
    fresh: boolean;
    lastStatus: string | null;
    rowsProcessed: number | null;
  }> = [];

  for (const source of sources) {
    const lastSuccess = await prisma.etlRun.findFirst({
      where: { source, status: "success" },
      orderBy: { completedAt: "desc" },
    });
    const lastAny = await prisma.etlRun.findFirst({
      where: { source },
      orderBy: { startedAt: "desc" },
    });
    const completedAt = lastSuccess?.completedAt ?? null;
    const hours = completedAt
      ? (Date.now() - completedAt.getTime()) / (1000 * 60 * 60)
      : null;
    out.push({
      source,
      lastSuccessAt: completedAt ? completedAt.toISOString() : null,
      hoursSinceSuccess: hours === null ? null : Math.round(hours * 10) / 10,
      fresh: hours !== null && hours < 26,
      lastStatus: lastAny?.status ?? null,
      rowsProcessed: lastSuccess?.rowsProcessed ?? null,
    });
  }

  const allFresh = out.every((s) => s.fresh);

  // Phase 6 ANALYTICS-03 / D-09 — surface latest completeness snapshot.
  // Returns null when no snapshot exists yet (distinguishes "not yet
  // computed" from "computed at 0%"). Status code semantics unchanged —
  // completeness does NOT gate fresh/stale 200/503; CloudWatch reads the
  // boolean to drive its own alarm.
  const latestSnapshot = await prisma.completenessSnapshot.findFirst({
    orderBy: { snapshotAt: "desc" },
  });

  return NextResponse.json(
    {
      allFresh,
      sources: out,
      completenessPercent: latestSnapshot?.completenessPercent ?? null,
      belowThreshold: latestSnapshot?.belowThreshold ?? null,
    },
    { status: allFresh ? 200 : 503 },
  );
}
