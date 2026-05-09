import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { searchClient } from "@/lib/search";

// Deep readiness probe. Verifies the process can reach its dependencies
// (Aurora via Prisma, OpenSearch). Not used by the ALB — see /healthz —
// because a DB blip should not cycle tasks. Used by the deploy pipeline
// post-rollout smoke test and on-demand from operators.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TIMEOUT_MS = 2000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function checkDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, TIMEOUT_MS);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkOpenSearch(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withTimeout(searchClient().ping(), TIMEOUT_MS);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const [db, opensearch] = await Promise.all([checkDb(), checkOpenSearch()]);
  const ok = db.ok && opensearch.ok;
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      checks: { db, opensearch },
    },
    { status: ok ? 200 : 503 },
  );
}
