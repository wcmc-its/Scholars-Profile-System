/**
 * GET /api/topics/[slug]/publications
 *
 * CSR endpoint for the Topic detail page publication feed.
 * Implements D-08 client-component contract + D-09 endpoint spec.
 *
 * Security: All query param and path param inputs are validated against strict
 * allowlists / regex before reaching the service layer. See threat model:
 *   T-03-05-01 sort injection → SORT_ALLOWLIST
 *   T-03-05-02 subtopic injection → SUBTOPIC_RE
 *   T-03-05-03 filter bypass → FILTER_ALLOWLIST
 *   T-03-05-04 path traversal → TOPIC_SLUG_RE
 *   T-03-05-05 DoS via page → MAX_PAGE clamp
 *   T-03-05-06 input echo → static error strings only
 *
 * Does NOT add CORS headers (same-origin only, matching all other /api/* routes).
 * Does NOT log request URL or param values (silent rejection per T-03-05-06).
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getTopicPublications,
  type TopicPublicationSort,
  type TopicPublicationFilter,
} from "@/lib/api/topics";

export const dynamic = "force-dynamic";

const SORT_ALLOWLIST: ReadonlySet<TopicPublicationSort> = new Set([
  "newest",
  "most_cited",
  "by_impact",
]);
const FILTER_ALLOWLIST: ReadonlySet<TopicPublicationFilter> = new Set([
  "research_articles_only",
  "all",
]);
const SUBTOPIC_RE = /^[a-z0-9_]+$/;
const TOPIC_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_PAGE = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  if (!TOPIC_SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "invalid topic slug" }, { status: 400 });
  }

  const sp = request.nextUrl.searchParams;

  const sortRaw = sp.get("sort") ?? "newest";
  if (!SORT_ALLOWLIST.has(sortRaw as TopicPublicationSort)) {
    return NextResponse.json({ error: "invalid sort" }, { status: 400 });
  }
  const sort = sortRaw as TopicPublicationSort;

  const filterRaw = sp.get("filter") ?? "research_articles_only";
  if (!FILTER_ALLOWLIST.has(filterRaw as TopicPublicationFilter)) {
    return NextResponse.json({ error: "invalid filter" }, { status: 400 });
  }
  const filter = filterRaw as TopicPublicationFilter;

  let subtopic: string | undefined;
  const subtopicRaw = sp.get("subtopic");
  if (subtopicRaw !== null) {
    if (!SUBTOPIC_RE.test(subtopicRaw)) {
      return NextResponse.json({ error: "invalid subtopic" }, { status: 400 });
    }
    subtopic = subtopicRaw;
  }

  const pageStr = sp.get("page") ?? "1";
  const pageNum = parseInt(pageStr, 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    return NextResponse.json({ error: "invalid page" }, { status: 400 });
  }
  // URL is 1-indexed; service is 0-indexed; clamp to MAX_PAGE.
  const page = Math.min(pageNum, MAX_PAGE) - 1;

  const result = await getTopicPublications(slug, { sort, subtopic, page, filter });
  if (result === null) {
    return NextResponse.json({ error: "topic not found" }, { status: 404 });
  }

  // Return result with page converted back to 1-indexed for API consumers.
  return NextResponse.json({ ...result, page: page + 1 });
}
