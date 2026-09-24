/**
 * GET /api/units/[kind]/[code]/members   (kind = department | division | center)
 *
 * #974 Phase 2 / #2537 / Unit Page v2 — the UNCACHEABLE companion to the
 * (cacheable) dept/division/center roster page. When the user selects one or
 * more "Methods & tools" facet options, an Appointment role-category chip, a
 * non-default roster sort, or types a name/title filter, the client fetches this
 * route to get the roster filtered and ranked accordingly, paginated, with the
 * same `DepartmentFacultyHit[]`-shaped hits (incl. Phase-1 `topMethods` chips
 * and the Unit Page v2 `topMesh` TOPICS chips, one batched people-index lookup
 * per page) the SSR roster returns.
 *
 * Params by kind:
 *   - all kinds: `?sort=last|pubs|grants` (roster toolbar; invalid ⇒ 400,
 *     absent ⇒ "last"), `?q=` (name/title filter, ≤100 chars after trim, else
 *     400), `?type=` (#2537), `?page=` (0-indexed). With none of them the
 *     response is the plain ranked roster.
 *   - department/division: `?method=` (OR within, #974), AND across the other
 *     facets — routed through `getUnitMembersFiltered`. A department also
 *     accepts `?div=` (Unit Page v2 Division facet, OR within, AND across); a
 *     division ignores it. `?method=`/`?div=` 404 while ORG_UNIT_METHODS_FACET
 *     is off; sort/q/type are always served.
 *   - center: routed through `getCenterMembersFiltered`. Centers' method facet
 *     is a client-side (already-loaded-page) filter, not an API call — a
 *     `?method=` here 400s rather than silently ignoring it.
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
 * Public-only overlay gate lives in the loaders
 * (`getUnitMembersFiltered`, `getCenterMembersFiltered`): a suppressed/#801-sensitive
 * family is dropped before any DB select, so it can never be selected nor returned
 * in chips, and a hidden identity class is never loaded (#536/#2202 carve).
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getUnitMembersFiltered } from "@/lib/api/unit-members";
import { getCenterMembersFiltered } from "@/lib/api/centers";
import { FILTERABLE_ROLE_GROUPS, type RoleGroupLabel } from "@/lib/role-groups";
import { isOrgUnitMethodsFacetEnabled } from "@/lib/profile/methods-lens-flags";
import {
  isRosterSort,
  normalizeRosterQuery,
  ROSTER_QUERY_MAX,
  type RosterSort,
} from "@/lib/roster-sort";

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
  const { kind, code } = await params;
  if (kind !== "department" && kind !== "division" && kind !== "center") {
    return apiError("invalid kind", 400);
  }
  if (!CODE_RE.test(code)) {
    return apiError("invalid code", 400);
  }

  const url = new URL(request.url);
  // Flag-gated: only the Methods & tools (and the Division facet that rides the
  // same sidebar) belong to the org-unit facet feature. The Appointment chip
  // and the roster toolbar's sort + name filter are served regardless.
  if (
    (url.searchParams.has("method") || url.searchParams.has("div")) &&
    !isOrgUnitMethodsFacetEnabled()
  ) {
    return apiError("not_found", 404);
  }

  const methods = url.searchParams.getAll("method").filter((m) => METHOD_KEY_RE.test(m));
  const typeRaw = url.searchParams.get("type");
  // "All" is a client-only sentinel (no filter) and never a valid server `type=`
  // — it has no raw DB values to filter on (`groupToRawValues("All") === []`).
  // An unrecognized string 400s the same way.
  if (typeRaw !== null && !isValidType(typeRaw)) {
    return apiError("invalid type", 400);
  }
  // Unit Page v2 roster toolbar — closed sort enum (absent ⇒ surname A–Z).
  const sortRaw = url.searchParams.get("sort");
  if (sortRaw !== null && !isRosterSort(sortRaw)) {
    return apiError("invalid sort", 400);
  }
  const sort: RosterSort = sortRaw ?? "last";
  // Name/title filter — free text, matched in memory (never interpolated into
  // SQL), capped so a pathological value is a 400 rather than work.
  const qRaw = url.searchParams.get("q");
  const q = normalizeRosterQuery(qRaw);
  if (qRaw !== null && qRaw.trim().replace(/\s+/g, " ").length > ROSTER_QUERY_MAX) {
    return apiError("invalid q", 400);
  }
  const page = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
  // Unit Page v2 Division facet — division codes, same strict charset as `code`,
  // capped (a department has at most a few dozen divisions).
  const divs = url.searchParams
    .getAll("div")
    .filter((d) => CODE_RE.test(d))
    .slice(0, 64);

  if (kind === "center") {
    // Centers' method facet lives client-side, not through this route.
    if (url.searchParams.has("method")) {
      return apiError("method not supported for center", 400);
    }
    if (url.searchParams.has("div")) {
      return apiError("div not supported for center", 400);
    }
    const result = await getCenterMembersFiltered(
      code,
      { roleGroup: typeRaw ?? undefined, sort, q },
      page,
    );
    // force-dynamic origin ⇒ no-store, so CloudFront never caches this response.
    return NextResponse.json(result);
  }

  const divisionCodes = kind === "department" ? divs : [];
  const result = await getUnitMembersFiltered(
    kind,
    code,
    {
      methodKeys: methods,
      roleGroup: typeRaw ?? undefined,
      ...(divisionCodes.length > 0 ? { divisionCodes } : {}),
      sort,
      q,
    },
    page,
  );
  // force-dynamic origin ⇒ no-store, so CloudFront never caches this response.
  return NextResponse.json(result);
}
