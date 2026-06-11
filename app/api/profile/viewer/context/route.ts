import { NextResponse, type NextRequest } from "next/server";

import { resolveViewerContext } from "@/lib/auth/viewer-context";

/**
 * GET /api/profile/viewer/context — #866 internal-viewer status probe.
 *
 * Returns ONLY the requester's internal-viewer status — no scholar data, no PII —
 * so a client island can decide whether to show an internal-only affordance
 * without leaking anything. It exists because public surfaces are CloudFront-
 * cached with the Cookie header stripped, so a server component cannot vary by
 * viewer; the island instead probes this (uncacheable) route at mount.
 *
 * Used by the #847 scholar-list export button so it appears for the full #866
 * internal-viewer audience — an authenticated session OR (when the network
 * signal flag is on) an on-WCM-network source IP — not just logged-in viewers.
 * The export route itself enforces the 401; this is purely so the right viewers
 * see a button that will actually succeed.
 *
 * Rides the `/api/profile/*` CloudFront behavior (uncacheable + forwards
 * `CloudFront-Viewer-Address`), so the on-network branch can read the source IP
 * with no new edge behavior. Never cached. Default-safe: an external viewer gets
 * `{ internal: false, basis: null }`.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const vc = await resolveViewerContext(request);
  return NextResponse.json(
    { internal: vc.internal, basis: vc.basis },
    { headers: NO_STORE },
  );
}
