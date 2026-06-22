/**
 * GET /api/opportunities/[opportunityId]/researchers — GrantRecs Phase 2 reverse
 * matcher ("Find researchers for this opportunity"). ADMIN-ONLY: a superuser OR
 * a `development`-role member may read it (GrantRecs Phase 4 widened the original
 * superuser-only gate so the in-progress `/edit/find-researchers` admin surface
 * can be opened to a scoped operator set without full superuser); `force-dynamic`
 * so it's never CloudFront-cached. The SPS `/edit/find-researchers` page is the
 * primary (and only) consumer; the engine lives here in SPS.
 *
 * Distinct axes (`topicFit` / `stageAppeal`); `stageLens` toggles the
 * stage-appropriateness blend, `sort` re-orders per axis (spec §7.4/§8).
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/error-response";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import {
  opportunityTopTopics,
  rankResearchersForOpportunity,
  type ResearcherSort,
} from "@/lib/api/match-researchers";
import { db } from "@/lib/db";
import { OPPORTUNITY_TOPIC_GATE, type OpportunityTopicScore } from "@/lib/search";

export const dynamic = "force-dynamic";

const OPPORTUNITY_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;
const SORT_ALLOWLIST: ReadonlySet<ResearcherSort> = new Set(["fit", "stage"]);
const MAX_LIMIT = 100;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ opportunityId: string }> },
): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session || !(session.isSuperuser || session.isDeveloper)) {
    // Empty body — no resource/permission leakage (mirrors /edit API guards).
    // A superuser OR a development-role member passes (GrantRecs Phase 4); the
    // page gate at /edit/find-researchers reads the same verdict.
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

  // View-model assembly for the redesigned screen: opportunity card fields, the
  // "matching on" chips (the opportunity's top topics), and a slug→label map for
  // the per-row topic evidence. ponytail: re-reads the opportunity row the matcher
  // already loaded — one PK lookup on a tiny table, not worth threading it out.
  const opp = await db.read.opportunity.findUnique({
    where: { opportunityId },
    select: {
      title: true,
      mechanism: true,
      dueDate: true,
      sponsor: true,
      source: true,
      sourceUrl: true,
      status: true,
      topicVector: true,
    },
  });

  const rawVector = opp?.topicVector;
  const matchingTopics = opportunityTopTopics(
    (Array.isArray(rawVector) ? rawVector : []) as OpportunityTopicScore[],
    OPPORTUNITY_TOPIC_GATE,
    8,
  );
  const topicIds = new Set<string>(matchingTopics.map((t) => t.topicId));
  for (const r of results) for (const c of r.topicContributions) topicIds.add(c.topicId);
  const topicLabels: Record<string, string> = {};
  if (topicIds.size > 0) {
    const rows = await db.read.topic.findMany({
      where: { id: { in: [...topicIds] } },
      select: { id: true, label: true },
    });
    for (const t of rows) topicLabels[t.id] = t.label;
  }
  const matchingOn = matchingTopics.map((t) => ({
    topicId: t.topicId,
    label: topicLabels[t.topicId] ?? t.topicId,
    score: t.topicWeight,
  }));
  const opportunity = opp
    ? {
        title: opp.title,
        mechanism: opp.mechanism,
        dueDate: opp.dueDate,
        sponsor: opp.sponsor,
        source: opp.source,
        sourceUrl: opp.sourceUrl,
        status: opp.status,
      }
    : null;

  return NextResponse.json({
    opportunityId,
    count: results.length,
    opportunity,
    matchingOn,
    topicLabels,
    results,
  });
}
