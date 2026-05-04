import { NextResponse, type NextRequest } from "next/server";
import { handleAnalyticsBeacon } from "@/lib/api/analytics";

/**
 * POST /api/analytics — client-side analytics beacon endpoint (D-05).
 *
 * Receives `navigator.sendBeacon` payloads from search result clicks
 * (ANALYTICS-02 CTR). Logs structured `search_click` event to stdout and
 * returns 204. Fire-and-forget — must not block client navigation.
 *
 * Auth: intentionally unauthenticated (beacon pattern). Rate limiting at
 * CDN/LB in production, out of app scope per Phase 6 § Security Domain.
 *
 * NOT included in openapi.yaml (Phase 6 DOCS-01) — write endpoints
 * deferred to DOCS-03 (Phase 7).
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const payload = await request.json().catch(() => null);
  if (payload === null) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  handleAnalyticsBeacon(payload);
  return new NextResponse(null, { status: 204 });
}
