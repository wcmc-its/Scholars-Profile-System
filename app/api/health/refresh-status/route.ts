import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Phase 4h: ETL health endpoint per Q5'. Returns the last successful run per
 * source and a freshness flag (>26h stale = not green). Production CloudWatch
 * alarm queries this.
 *
 * Auth: Phase 7 will gate this behind admin SAML. Until then it's open in dev.
 */
export async function GET() {
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
  return NextResponse.json(
    { allFresh, sources: out },
    { status: allFresh ? 200 : 503 },
  );
}
