/**
 * GET /api/centers/[slug]/collaboration   (#1137)
 *
 * The UNCACHEABLE data source for the center "Collaboration" tab. Returns the
 * whole co-authorship graph payload for the center (nodes + per-paper member
 * groups); the browser builds edges/rollups and applies all filters. Reads only
 * the path slug — NO query params — so, unlike the methods-facet members route,
 * it needs no EdgeStack query-allowlist behavior (confirm against the #490/#624
 * guard in review).
 *
 * `force-dynamic` ⇒ Next emits `Cache-Control: private, no-store` ⇒ CloudFront
 * never caches it (membership/pub changes stay live). The payload carries only
 * already-public display names + program codes; the loader's public gate keeps
 * hidden scholars out of every node and edge.
 *
 * Gating: the feature flag (404 when off) AND the data-driven program-taxonomy
 * gate (404 for centers with no `CenterProgram` rows — today every center but
 * Meyer). Slug is charset-validated; a bad slug is a 400, never logged/queried.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { prisma } from "@/lib/db";
import { buildCenterCollaboration } from "@/lib/api/center-collaboration";
import { isCenterCollaborationNetworkEnabled } from "@/lib/center-collaboration/flags";

export const dynamic = "force-dynamic";

// Center slugs are lowercase alnum + `_`/`-` (e.g. "meyer_cancer_center").
const SLUG_RE = /^[a-z0-9_-]+$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  // Flag off ⇒ the route does not exist for clients.
  if (!isCenterCollaborationNetworkEnabled()) return apiError("not_found", 404);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return apiError("invalid slug", 400);

  const center = await prisma.center.findUnique({
    where: { slug },
    select: { code: true },
  });
  if (!center) return apiError("not_found", 404);

  // Data-driven gate: the feature exists only for centers with a program taxonomy.
  const programCount = await prisma.centerProgram.count({
    where: { centerCode: center.code },
  });
  if (programCount === 0) return apiError("not_found", 404);

  const payload = await buildCenterCollaboration(center.code);
  if (!payload) return apiError("not_found", 404);

  return NextResponse.json(payload);
}
