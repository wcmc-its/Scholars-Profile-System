/**
 * GET /api/scholars/[cwid]/opportunities — GrantRecs Phase 2 forward matcher
 * ("Grants for me"). PUBLIC per-cwid (decision D): the match is derived from
 * already-public publications + opportunities and takes an explicit cwid with no
 * cookies, so the personalization works regardless of the edge cache. The
 * CloudFront behavior is CachingDisabled + AllViewer (so `sort`/`weights`/`limit`
 * are forwarded, matching the other query-reading API routes); the edge does not
 * cache, and we set a short browser `max-age`. Phase 3 renders it as "Grants for
 * me" by probing /api/auth/session then calling this for the logged-in cwid.
 *
 * Response carries the DISTINCT axis vector per opportunity; `sort` + `weights`
 * re-order / re-blend at query time without re-running the match (spec §7.3/§8).
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/error-response";
import {
  DEFAULT_WEIGHTS,
  matchOpportunitiesForScholar,
  prestigeAxisWeight,
  type MatchWeights,
  type RankSort,
} from "@/lib/api/match-opportunities";

const CWID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const SORT_ALLOWLIST: ReadonlySet<RankSort> = new Set(["fit", "deadline", "stage", "prestige"]);
const WEIGHT_KEYS = ["topic", "stage", "mesh", "deadline"] as const;
const MAX_LIMIT = 100;

/** Parse `weights=topic:1,stage:0.5,...` into a full MatchWeights, or null if malformed. */
function parseWeights(raw: string | null): MatchWeights | null {
  // prestige isn't a query-overridable WEIGHT_KEY — it's env-gated. Seed it from
  // the flag so flipping PRESTIGE_AXIS_WEIGHT actually takes effect on this route
  // (the route always passes weights, so the matcher's own flag-injection path
  // would otherwise never fire here). Launch default 0 = badge+sort only.
  const base: MatchWeights = { ...DEFAULT_WEIGHTS, prestige: prestigeAxisWeight() };
  if (raw === null) return base;
  const out: MatchWeights = { ...base };
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split(":");
    if (!WEIGHT_KEYS.includes(k as (typeof WEIGHT_KEYS)[number])) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    out[k as keyof MatchWeights] = n;
  }
  return out;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  const { cwid } = await params;
  if (!CWID_RE.test(cwid)) return apiError("invalid cwid", 400);

  const sp = request.nextUrl.searchParams;

  const sortRaw = sp.get("sort") ?? "fit";
  if (!SORT_ALLOWLIST.has(sortRaw as RankSort)) return apiError("invalid sort", 400);

  const weights = parseWeights(sp.get("weights"));
  if (weights === null) return apiError("invalid weights", 400);

  let limit = 50;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) return apiError("invalid limit", 400);
    limit = Math.min(n, MAX_LIMIT);
  }

  const results = await matchOpportunitiesForScholar(cwid, {
    sort: sortRaw as RankSort,
    weights,
    limit,
  });

  return NextResponse.json(
    { cwid, count: results.length, results },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" } },
  );
}
