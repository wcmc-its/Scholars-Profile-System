import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";

/**
 * GET /api/auth/session — the header's client-side auth probe (#356 Phase 5).
 *
 * The site header is rendered on every public surface, but those surfaces are
 * served by CloudFront's *cacheable* default behavior, which strips the Cookie
 * header before it reaches the origin (cdk/lib/edge-stack.ts: the cache spec's
 * "single most important knob"). So a server-rendered header on a public page
 * never sees the session cookie and always shows "Sign in", even for a
 * signed-in user.
 *
 * This route lives under `/api/auth/*`, one of the few CloudFront behaviors
 * that forwards cookies (CachingDisabled + AllViewer), so it CAN read the
 * session. `HeaderAuthSlot` fetches it client-side to render the real auth
 * state. Returns only what the header shows (auth flag + the scholar's public
 * slug/name) -- no PII, no session internals.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const session = await getSession().catch(() => null);
  const noStore = { "cache-control": "no-store" };

  if (!session) {
    return NextResponse.json(
      { authenticated: false, scholar: null },
      { headers: noStore },
    );
  }

  const scholar = await db.read.scholar
    .findUnique({
      where: { cwid: session.cwid },
      select: { slug: true, preferredName: true },
    })
    .catch(() => null);

  return NextResponse.json(
    { authenticated: true, scholar },
    { headers: noStore },
  );
}
