import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PEOPLE_INDEX, searchClient } from "@/lib/search";

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

// Probe what search actually needs: a zero-hit read of the people alias with
// the same client and credentials the app's search path uses. NOT ping():
// that is `HEAD /`, which needs the cluster-level `cluster:monitor/main`
// permission. The app's OpenSearch role (sps_app) is read-only on
// `scholars-*` and is deliberately not granted cluster_monitor, so ping()
// 403s (body-less HEAD, surfaced only as "Response Error") while search works.
async function checkOpenSearch(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withTimeout(
      searchClient().search({
        index: PEOPLE_INDEX,
        body: { size: 0, query: { match_all: {} } },
      }),
      TIMEOUT_MS,
    );
    return { ok: true };
  } catch (e) {
    const status = (e as { meta?: { statusCode?: unknown } } | null)?.meta?.statusCode;
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: typeof status === "number" ? `${message} (HTTP ${status})` : message };
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
