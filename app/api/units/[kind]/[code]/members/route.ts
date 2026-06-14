/**
 * GET /api/units/[kind]/[code]/members   (kind = department | division)
 *
 * #974 Phase 2 — the UNCACHEABLE companion to the (cacheable) dept/division roster
 * page. When the user selects one or more "Methods & tools" facet options, the
 * client fetches this route to get the roster filtered to members carrying ≥1 of
 * the selected public method families (OR within the facet), paginated, with the
 * same `DepartmentFacultyHit[]` shape (incl. Phase-1 `topMethods` chips).
 *
 * Uncacheable by ORIGIN headers, not a dedicated edge behavior: `dynamic =
 * "force-dynamic"` makes Next emit `Cache-Control: private, no-store` so CloudFront
 * never caches it (mirrors `/api/methods/[supercategory]/families/[familyId]/
 * scholars`, which is also uncacheable purely via origin no-store). The roster PAGE
 * is unaffected — it never reads `?method` (stripped at the edge anyway) and adds
 * no per-viewer call. Do NOT add an edge-stack.ts behavior for this route.
 *
 * Security: same allowlist-regex posture as the methods scholars endpoint — code +
 * each `method` key validated against a strict charset, no request/param logging.
 * Public-only overlay gate + the master/facet flag live in the loader
 * (`getUnitMembersByMethods`): a suppressed/#801-sensitive family is dropped before
 * any DB select, so it can never be selected nor returned in chips.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getUnitMembersByMethods } from "@/lib/api/unit-members";
import { isOrgUnitMethodsFacetEnabled } from "@/lib/profile/methods-lens-flags";

export const dynamic = "force-dynamic";

// Dept/division codes are ED org codes (e.g. "N1140"): uppercase alnum, plus a
// minimal `_`/`-` allowance. Strict — a bad code is a 400, never logged/queried.
const CODE_RE = /^[A-Za-z0-9_-]+$/;
// `sc::label` overlay key — supercategory is snake_case lower-alnum; the label is
// free-text (any non-empty remainder). The loader re-gates each pair publicly.
const METHOD_KEY_RE = /^[a-z0-9_]+::.+$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; code: string }> },
): Promise<NextResponse> {
  // Flag-gated: the facet feature off ⇒ the route does not exist for clients.
  if (!isOrgUnitMethodsFacetEnabled()) return apiError("not_found", 404);

  const { kind, code } = await params;
  if (kind !== "department" && kind !== "division") {
    return apiError("invalid kind", 400);
  }
  if (!CODE_RE.test(code)) {
    return apiError("invalid code", 400);
  }

  const url = new URL(request.url);
  const methods = url.searchParams.getAll("method").filter((m) => METHOD_KEY_RE.test(m));
  if (methods.length === 0) {
    return apiError("no method", 400);
  }
  const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10) || 0);

  const result = await getUnitMembersByMethods(kind, code, methods, page);
  // force-dynamic origin ⇒ no-store, so CloudFront never caches this response.
  return NextResponse.json(result);
}
