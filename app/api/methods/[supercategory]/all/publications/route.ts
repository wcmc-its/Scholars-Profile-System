/**
 * GET /api/methods/[supercategory]/all/publications
 *
 * TAXONOMY_FEED_LOAD_MORE — the method category page's "All families" feed:
 * every publicly visible family's pubs in the category as one sorted, type-
 * filtered, paged list, each hit carrying its family label. Flag off ⇒ 404
 * (the route does not exist yet as far as the public is concerned).
 *
 * Path: the static `all` segment sits under `/api/methods/[supercategory]/`,
 * so the URL shape is `/api/methods/*` + `/*` + `/publications` and rides the
 * existing CloudFront behavior for the family feed (CachingDisabled +
 * AllViewer) — no edge change, no query-string strip. It cannot shadow a real
 * family feed: the client always sends the full `${labelSlug}-fam_NNNN`
 * family segment, never a bare "all".
 *
 * Gating (all in the loader, `getSupercategoryAllWork`): master lens, the
 * #800 suppression / #801 sensitivity overlay per family, active + #536
 * public-role scholars only (denylist + fail-closed check), #356 dark pubs
 * removed. An all-suppressed or unknown supercategory is a 404
 * (`getSupercategory`).
 *
 * Security: every input is validated before the service layer (the family
 * route's threat model): SORT_ALLOWLIST, FILTER_ALLOWLIST, SUPERCATEGORY_SLUG_RE,
 * page integer ≥ 1 clamped to MAX_PAGE, `limit` via `parseFeedLimit` (whole
 * 20-row chunks, at most 200). Static error strings only; no param echo, no
 * logging of the URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import {
  getSupercategory,
  getSupercategoryPublications,
  type MethodPublicationFilter,
  type MethodPublicationSort,
} from "@/lib/api/methods";
import { isTaxonomyFeedLoadMoreOn } from "@/lib/taxonomy-flags";
import { parseFeedLimit } from "@/lib/taxonomy/feed-load-more";

export const dynamic = "force-dynamic";

const SORT_ALLOWLIST: ReadonlySet<MethodPublicationSort> = new Set([
  "newest",
  "most_cited",
  "by_impact",
]);
const FILTER_ALLOWLIST: ReadonlySet<MethodPublicationFilter> = new Set([
  "research_articles_only",
  "all",
]);
const SUPERCATEGORY_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_PAGE = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ supercategory: string }> },
): Promise<NextResponse> {
  if (!isTaxonomyFeedLoadMoreOn()) {
    return apiError("not found", 404);
  }
  const { supercategory } = await params;
  if (!SUPERCATEGORY_SLUG_RE.test(supercategory)) {
    return apiError("invalid supercategory", 400);
  }

  const sp = request.nextUrl.searchParams;

  const sortRaw = sp.get("sort") ?? "newest";
  if (!SORT_ALLOWLIST.has(sortRaw as MethodPublicationSort)) {
    return apiError("invalid sort", 400);
  }
  const sort = sortRaw as MethodPublicationSort;

  const filterRaw = sp.get("filter") ?? "research_articles_only";
  if (!FILTER_ALLOWLIST.has(filterRaw as MethodPublicationFilter)) {
    return apiError("invalid filter", 400);
  }
  const filter = filterRaw as MethodPublicationFilter;

  const limit = parseFeedLimit(sp.get("limit"));
  if (limit === "invalid") {
    return apiError("invalid limit", 400);
  }

  const pageStr = sp.get("page") ?? "1";
  if (!/^\d{1,6}$/.test(pageStr) || Number(pageStr) < 1) {
    return apiError("invalid page", 400);
  }
  // URL is 1-indexed; service is 0-indexed; clamp to MAX_PAGE.
  const page = Math.min(Number(pageStr), MAX_PAGE) - 1;

  const sc = await getSupercategory(supercategory);
  if (!sc) {
    return apiError("supercategory not found", 404);
  }

  const result = await getSupercategoryPublications(sc.id, {
    sort,
    filter,
    page,
    pageSize: limit,
  });
  if (result === null) {
    return apiError("supercategory not found", 404);
  }
  return NextResponse.json({ ...result, page: result.page + 1 });
}
