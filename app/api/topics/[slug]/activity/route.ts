/**
 * GET /api/topics/[slug]/activity?kind=grant|trial|scholars
 *
 * `kind=scholars` returns the Activities Scholars chips' per-scholar counts
 * (`getTopicActivityScholars`); it reads only `subtopic`.
 *
 * CSR endpoint for a research area's grants and clinical trials
 * (TOPIC_FEED_GRANTS_TRIALS; service lib/api/topic-activity.ts). 404 while the
 * flag is off, before any param is read.
 *
 * Security: same allow-list style as `/api/topics/[slug]/publications`. Every
 * param is validated before the service runs:
 *   kind      → KIND_ALLOWLIST (required)
 *   sort      → SORT_ALLOWLIST (default "newest")
 *   tier      → TIER_ALLOWLIST (optional; omitted = both tiers)
 *   subtopic  → SUBTOPIC_RE (primary subarea only; see the service)
 *   cwid      → CWID_PATTERN; the service refuses unknown / inactive /
 *               #536-hidden cwids with the same empty result
 *   limit     → `parseFeedLimit` (whole 20-row chunks, at most 200)
 *   page      → positive integer, depth-capped by `clampFeedPage`
 *   slug      → TOPIC_SLUG_RE
 * Error bodies are static strings; param values are never echoed or logged.
 *
 * Edge: `/api/topics/*` falls to the cacheable default behavior, which strips
 * the query string, so cdk/lib/edge-stack.ts lists this path as uncacheable
 * (AllViewer). That needs a manual Sps-Edge deploy per env before the page
 * control can use it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import {
  getTopicActivity,
  getTopicActivityScholars,
  type TopicActivityKind,
  type TopicActivitySort,
} from "@/lib/api/topic-activity";
import type { TopicPublicationTier } from "@/lib/api/topics";
import { CWID_PATTERN } from "@/lib/cwid";
import { isTopicFeedGrantsTrialsOn } from "@/lib/taxonomy-flags";
import { clampFeedPage, parseFeedLimit } from "@/lib/taxonomy/feed-load-more";

export const dynamic = "force-dynamic";

const KIND_ALLOWLIST: ReadonlySet<TopicActivityKind> = new Set(["grant", "trial"]);
const SORT_ALLOWLIST: ReadonlySet<TopicActivitySort> = new Set([
  "newest",
  "best_match",
  "status",
  "ending",
]);
const TIER_ALLOWLIST: ReadonlySet<TopicPublicationTier> = new Set(["strongly", "also"]);
const SUBTOPIC_RE = /^[a-z0-9_]+$/;
const TOPIC_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  if (!isTopicFeedGrantsTrialsOn()) {
    return apiError("not found", 404);
  }
  const { slug } = await params;
  if (!TOPIC_SLUG_RE.test(slug)) {
    return apiError("invalid topic slug", 400);
  }

  const sp = request.nextUrl.searchParams;

  const kindRaw = sp.get("kind");
  if (kindRaw === "scholars") {
    const sub = sp.get("subtopic");
    if (sub !== null && !SUBTOPIC_RE.test(sub)) {
      return apiError("invalid subtopic", 400);
    }
    const result = await getTopicActivityScholars(slug, { subtopic: sub ?? undefined });
    if (result === null) {
      return apiError("topic not found", 404);
    }
    return NextResponse.json(result);
  }
  if (kindRaw === null || !KIND_ALLOWLIST.has(kindRaw as TopicActivityKind)) {
    return apiError("invalid kind", 400);
  }
  const kind = kindRaw as TopicActivityKind;

  const sortRaw = sp.get("sort") ?? "newest";
  if (!SORT_ALLOWLIST.has(sortRaw as TopicActivitySort)) {
    return apiError("invalid sort", 400);
  }
  const sort = sortRaw as TopicActivitySort;

  let tier: TopicPublicationTier | undefined;
  const tierRaw = sp.get("tier");
  if (tierRaw !== null) {
    if (!TIER_ALLOWLIST.has(tierRaw as TopicPublicationTier)) {
      return apiError("invalid tier", 400);
    }
    tier = tierRaw as TopicPublicationTier;
  }

  let subtopic: string | undefined;
  const subtopicRaw = sp.get("subtopic");
  if (subtopicRaw !== null) {
    if (!SUBTOPIC_RE.test(subtopicRaw)) {
      return apiError("invalid subtopic", 400);
    }
    subtopic = subtopicRaw;
  }

  let cwid: string | undefined;
  const cwidRaw = sp.get("cwid");
  if (cwidRaw !== null) {
    if (!CWID_PATTERN.test(cwidRaw)) {
      return apiError("invalid cwid", 400);
    }
    cwid = cwidRaw;
  }

  const limit = parseFeedLimit(sp.get("limit"));
  if (limit === "invalid") {
    return apiError("invalid limit", 400);
  }

  const pageNum = parseInt(sp.get("page") ?? "1", 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    return apiError("invalid page", 400);
  }
  const page = clampFeedPage(pageNum, limit);

  const result = await getTopicActivity(slug, {
    kind,
    sort,
    tier,
    subtopic,
    cwid,
    page,
    pageSize: limit,
  });
  if (result === null) {
    return apiError("topic not found", 404);
  }
  // 1-indexed for API consumers, as the publication route returns it.
  return NextResponse.json({ ...result, page: page + 1 });
}
