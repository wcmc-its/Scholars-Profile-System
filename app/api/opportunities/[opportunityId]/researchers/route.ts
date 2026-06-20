/**
 * GET /api/opportunities/[opportunityId]/researchers — GrantRecs Phase 2 reverse
 * matcher ("Find researchers for this opportunity"). ADMIN-ONLY: superuser
 * `/edit` gate (decision D); `force-dynamic` so it's never CloudFront-cached.
 * Phase 4 (Pub Manager) is the primary consumer; the engine lives here in SPS.
 *
 * Distinct axes (`topicFit` / `stageAppeal`); `stageLens` toggles the
 * stage-appropriateness blend, `sort` re-orders per axis (spec §7.4/§8).
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/error-response";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { rankResearchersForOpportunity, type ResearcherSort } from "@/lib/api/match-researchers";

export const dynamic = "force-dynamic";

const OPPORTUNITY_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;
const SORT_ALLOWLIST: ReadonlySet<ResearcherSort> = new Set(["fit", "stage"]);
const MAX_LIMIT = 100;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ opportunityId: string }> },
): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session || !session.isSuperuser) {
    // Empty body — no resource/permission leakage (mirrors /edit API guards).
    return new NextResponse(null, { status: 403 });
  }

  const { opportunityId } = await params;
  if (!OPPORTUNITY_ID_RE.test(opportunityId)) return apiError("invalid opportunityId", 400);

  const sp = request.nextUrl.searchParams;

  const sortRaw = sp.get("sort") ?? "fit";
  if (!SORT_ALLOWLIST.has(sortRaw as ResearcherSort)) return apiError("invalid sort", 400);

  const stageLens = sp.get("stageLens") === "1" || sp.get("stageLens") === "true";

  let limit = 25;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) return apiError("invalid limit", 400);
    limit = Math.min(n, MAX_LIMIT);
  }

  const results = await rankResearchersForOpportunity(opportunityId, {
    sort: sortRaw as ResearcherSort,
    stageLens,
    limit,
  });

  return NextResponse.json({ opportunityId, count: results.length, results });
}
