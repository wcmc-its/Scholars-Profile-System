/**
 * GET /api/units/[kind]/[code]/members   (kind = department | division | center)
 *
 * #974 Phase 2 / #2537 — the UNCACHEABLE companion to the (cacheable) dept/
 * division/center roster page. When the user selects one or more "Methods &
 * tools" facet options and/or an Appointment role-category chip, the client
 * fetches this route to get the roster filtered accordingly, paginated, with
 * the same `DepartmentFacultyHit[]`-shaped hits (incl. Phase-1 `topMethods`
 * chips) the SSR roster returns.
 *
 * Facet support by kind:
 *   - department/division: `?method=` (OR within, #974), `?type=` (#2537), or
 *     both together (AND across the two facets) — routed through
 *     `getUnitMembersFiltered`.
 *   - center: `?type=` ONLY (#2537), routed through `getCenterMembersByType`.
 *     Centers' method facet is a client-side (already-loaded-page) filter, not
 *     an API call — a `?method=` here 400s rather than silently ignoring it.
 *
 * Uncacheable via `dynamic = "force-dynamic"` (Next emits `Cache-Control: private,
 * no-store`, so CloudFront never caches it). It ALSO needs an explicit edge behavior:
 * this route is in the uncacheable ALL_VIEWER list in
 * cdk/lib/edge-stack.ts, because the cacheable default behavior's query allow-list
 * omits `method`/`type`, so without AllViewer those filters would be stripped before
 * the origin (the #490/#624 EdgeStack guard enforces a forwarding behavior for any
 * query-reading route). The edge behavior glob for this route in
 * `cdk/lib/edge-stack.ts` already matches any `kind` path segment, so
 * kind=center needs no CDK change (#2537 scout note). The roster PAGE is
 * unaffected — it never reads `?method`/`?type` server-side and adds no
 * per-viewer call.
 *
 * Security: same allowlist-regex posture as the methods scholars endpoint — code +
 * each `method` key validated against a strict charset, `type` validated against
 * the closed `FILTERABLE_ROLE_GROUPS` label set, no request/param logging.
 * Public-only overlay gate + the master/facet flag live in the loaders
 * (`getUnitMembersFiltered`, `getCenterMembersByType`): a suppressed/#801-sensitive
 * family is dropped before any DB select, so it can never be selected nor returned
 * in chips, and a hidden identity class is never loaded (#536/#2202 carve).
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getUnitMembersFiltered } from "@/lib/api/unit-members";
import { getCenterMembersByType } from "@/lib/api/centers";
import { FILTERABLE_ROLE_GROUPS, type RoleGroupLabel } from "@/lib/role-groups";
import { isOrgUnitMethodsFacetEnabled } from "@/lib/profile/methods-lens-flags";

export const dynamic = "force-dynamic";

// Dept/division/center codes are ED org codes / center codes (e.g. "N1140",
// "MEYER"): uppercase alnum, plus a minimal `_`/`-` allowance. Strict — a bad
// code is a 400, never logged/queried.
const CODE_RE = /^[A-Za-z0-9_-]+$/;
// `sc::label` overlay key. The label is free-text (any non-empty remainder); the
// supercategory column is an OPEN set (VarChar(128), "guard, don't hard-enum" — it
// has already drifted 13→14), so match any non-`:` prefix rather than re-asserting
// lowercase snake_case stricter than the data layer guarantees (#991) — a future
// non-lowercase supercategory would otherwise 400 a facet key the sidebar offered.
// This only rejects obviously-malformed input; the loader re-gates each pair
// against the public #800/#801 overlay (the real security boundary).
const METHOD_KEY_RE = /^[^:]+::.+$/;

function isValidType(value: string): value is RoleGroupLabel {
  return (FILTERABLE_ROLE_GROUPS as string[]).includes(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; code: string }> },
): Promise<NextResponse> {
  // Flag-gated: the facet feature off ⇒ the route does not exist for clients.
  if (!isOrgUnitMethodsFacetEnabled()) return apiError("not_found", 404);

  const { kind, code } = await params;
  if (kind !== "department" && kind !== "division" && kind !== "center") {
    return apiError("invalid kind", 400);
  }
  if (!CODE_RE.test(code)) {
    return apiError("invalid code", 400);
  }

  const url = new URL(request.url);
  const methods = url.searchParams.getAll("method").filter((m) => METHOD_KEY_RE.test(m));
  const typeRaw = url.searchParams.get("type");
  // "All" is a client-only sentinel (no filter) and never a valid server `type=`
  // — it has no raw DB values to filter on (`groupToRawValues("All") === []`).
  // An unrecognized string 400s the same way.
  if (typeRaw !== null && !isValidType(typeRaw)) {
    return apiError("invalid type", 400);
  }
  const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10) || 0);

  if (kind === "center") {
    // Centers' method facet lives client-side, not through this route.
    if (url.searchParams.has("method")) {
      return apiError("method not supported for center", 400);
    }
    if (typeRaw === null) {
      return apiError("no type", 400);
    }
    const result = await getCenterMembersByType(code, typeRaw, page);
    // force-dynamic origin ⇒ no-store, so CloudFront never caches this response.
    return NextResponse.json(result);
  }

  if (methods.length === 0 && typeRaw === null) {
    return apiError("no method", 400);
  }

  const result = await getUnitMembersFiltered(
    kind,
    code,
    { methodKeys: methods, roleGroup: typeRaw ?? undefined },
    page,
  );
  // force-dynamic origin ⇒ no-store, so CloudFront never caches this response.
  return NextResponse.json(result);
}
