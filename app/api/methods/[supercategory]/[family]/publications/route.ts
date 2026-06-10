/**
 * GET /api/methods/[supercategory]/[family]/publications
 *
 * CSR endpoint for the cross-scholar Method (family) page publication feed —
 * the family-grain analog of /api/topics/[slug]/publications. Returns the union
 * of the family's member PMIDs (`ScholarFamily.pmids`) resolved to publications,
 * sorted + publication-type filtered + paginated. Single untiered list: the
 * family taxonomy has no `Topic.displayThreshold` analog (§OQ-3b), so there is
 * no tier partition.
 *
 * Security: All query/path inputs are validated against strict allowlists /
 * regex before reaching the service layer (mirrors the topic feed threat model):
 *   T-03-05-01 sort injection      → SORT_ALLOWLIST
 *   T-03-05-03 filter bypass       → FILTER_ALLOWLIST
 *   T-03-05-04 path traversal      → SUPERCATEGORY_SLUG_RE / FAMILY_SEGMENT_RE
 *   T-03-05-05 DoS via page        → MAX_PAGE clamp
 *   T-03-05-06 input echo          → static error strings only
 *   T-03-05-07 tier bypass (#326)  → TIER_ALLOWLIST (no family tier today; a tier
 *                                    param, if present, is allow-list-validated
 *                                    and then dropped — never forwarded, since
 *                                    the family feed is a single untiered list)
 *
 * The overlay gate (#800 suppression / #801 sensitivity) + master lens gate live
 * in the loader (`getFamilyPublications`), which returns null for a gated/unknown
 * family → 404 here, so a suppressed/sensitive family never yields a feed.
 *
 * Does NOT add CORS headers (same-origin only, matching all other /api/* routes).
 * Does NOT log request URL or param values (silent rejection per T-03-05-06).
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import {
  getFamily,
  getFamilyPublications,
  type MethodPublicationSort,
  type MethodPublicationFilter,
} from "@/lib/api/methods";

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
// #326 tier vocabulary retained for the threat model. The family feed is a
// single untiered list (no `displayThreshold` analog at family grain, §OQ-3b),
// so a tier param is validated-if-present then dropped — never forwarded.
const TIER_ALLOWLIST: ReadonlySet<string> = new Set(["strongly", "also"]);
// Slug segments are deterministic kebab-case (`deriveSlug`) with an optional
// trailing `-fam_NNNN` family-id suffix; allow lowercase alnum + hyphen +
// underscore (the family-id suffix carries an underscore).
const SUPERCATEGORY_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const FAMILY_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_PAGE = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ supercategory: string; family: string }> },
): Promise<NextResponse> {
  const { supercategory, family } = await params;
  if (!SUPERCATEGORY_SLUG_RE.test(supercategory)) {
    return apiError("invalid supercategory", 400);
  }
  if (!FAMILY_SEGMENT_RE.test(family)) {
    return apiError("invalid family", 400);
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

  // #326 — tier is allow-list-validated for the threat model but NOT forwarded:
  // the family feed has no tier partition. An out-of-allowlist value is rejected.
  const tierRaw = sp.get("tier");
  if (tierRaw !== null && !TIER_ALLOWLIST.has(tierRaw)) {
    return apiError("invalid tier", 400);
  }

  const pageStr = sp.get("page") ?? "1";
  const pageNum = parseInt(pageStr, 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    return apiError("invalid page", 400);
  }
  // URL is 1-indexed; service is 0-indexed; clamp to MAX_PAGE.
  const page = Math.min(pageNum, MAX_PAGE) - 1;

  // Resolve the family to its stable (supercategory, familyLabel) identity —
  // re-derives slugs over the live set, applies the overlay gate, null on miss.
  const resolved = await getFamily(supercategory, family);
  if (!resolved) {
    return apiError("family not found", 404);
  }

  const result = await getFamilyPublications(
    resolved.supercategory,
    resolved.familyLabel,
    { sort, page, filter },
  );
  if (result === null) {
    return apiError("family not found", 404);
  }

  // Return result with page converted back to 1-indexed for API consumers.
  return NextResponse.json({ ...result, page: result.page + 1 });
}
