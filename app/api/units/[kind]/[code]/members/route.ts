/**
 * GET /api/units/[kind]/[code]/members   (kind = department | division)
 *
 * #974 Phase 2 — the UNCACHEABLE companion to the (cacheable) dept/division roster
 * page. When the user selects one or more "Methods & tools" facet options, the
 * client fetches this route to get the roster filtered to members carrying ≥1 of
 * the selected public method families (OR within the facet), paginated, with the
 * same `DepartmentFacultyHit[]` shape (incl. Phase-1 `topMethods` chips).
 *
 * Uncacheable via `dynamic = "force-dynamic"` (Next emits `Cache-Control: private,
 * no-store`, so CloudFront never caches it). It ALSO needs an explicit edge behavior:
 * this route is in the uncacheable ALL_VIEWER list in
 * cdk/lib/edge-stack.ts, because the cacheable default behavior's query allow-list
 * omits `method`, so without AllViewer the `?method=` filter would be stripped before
 * the origin (the #490/#624 EdgeStack guard enforces a forwarding behavior for any
 * query-reading route). The roster PAGE is unaffected — it never reads `?method`
 * server-side and adds no per-viewer call.
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
// `sc::label` overlay key. The label is free-text (any non-empty remainder); the
// supercategory column is an OPEN set (VarChar(128), "guard, don't hard-enum" — it
// has already drifted 13→14), so match any non-`:` prefix rather than re-asserting
// lowercase snake_case stricter than the data layer guarantees (#991) — a future
// non-lowercase supercategory would otherwise 400 a facet key the sidebar offered.
// This only rejects obviously-malformed input; the loader re-gates each pair
// against the public #800/#801 overlay (the real security boundary).
const METHOD_KEY_RE = /^[^:]+::.+$/;

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
