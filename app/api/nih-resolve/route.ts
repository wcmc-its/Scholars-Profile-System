/**
 * POST /api/nih-resolve — batch-resolve NIH grant numbers to RePORTER applIds.
 *
 * Browser cannot hit api.reporter.nih.gov directly (no CORS headers from NIH).
 * This route proxies a single batched POST to the public NIH RePORTER v2 API
 * and returns a per-input mapping. Used by the profile page's GrantsSection
 * client component to upgrade plain-text NIH award numbers into deep links
 * to https://reporter.nih.gov/project-details/<applId> after first paint.
 *
 * Input is sanitized: max 50 award numbers per call, each ≤40 chars,
 * `[A-Z0-9 -]` charset only. Matching is done on the canonicalized
 * (spaceless, uppercase) form so a request for "1 R01 HL144718-01A1" pairs
 * with the API's "1R01HL144718-01A1" project_num. When the exact full grant
 * isn't returned, falls back to the longest project_num that's a prefix-or-
 * substring match — covers the case where the suffix year has rolled forward.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NIH_API = "https://api.reporter.nih.gov/v2/projects/search";
const MAX_BATCH = 50;
const MAX_AWARD_LEN = 40;
const AWARD_RE = /^[A-Z0-9 -]{4,40}$/i;

type Pair = { award: string; applId: number | null };

/** Canonical form for the NIH RePORTER `project_nums` filter:
 *  spaces collapsed away but hyphens preserved (the API parses the dash
 *  between IC+serial and budget-period suffix; "4R33HL16919002" matches
 *  nothing, "4R33HL169190-02" returns the exact project). */
function canonicalize(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ results: [] }, { status: 400 });
  }
  const rawNums =
    body && typeof body === "object" && "nums" in body && Array.isArray((body as { nums: unknown }).nums)
      ? ((body as { nums: unknown[] }).nums as unknown[])
      : [];

  const awards = rawNums
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= MAX_AWARD_LEN && AWARD_RE.test(x))
    .slice(0, MAX_BATCH);

  if (awards.length === 0) {
    return NextResponse.json({ results: [] satisfies Pair[] });
  }

  // Send canonicalized forms to NIH; we'll map back to the caller's awards.
  const canonicalAwards = awards.map(canonicalize);

  let apiData: { results?: Array<{ appl_id: number; project_num: string }> } = {};
  try {
    const resp = await fetch(NIH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteria: { project_nums: canonicalAwards },
        include_fields: ["ApplId", "ProjectNum"],
        limit: 500,
      }),
      // Don't cache at the fetch layer — the browser-side wrapper hits this
      // route at most once per profile render.
      cache: "no-store",
    });
    if (resp.ok) apiData = await resp.json();
  } catch {
    // Network/upstream failure → fall through with empty results.
  }

  const results = (apiData.results ?? []).map((r) => ({
    applId: r.appl_id,
    canonical: canonicalize(r.project_num),
  }));

  // For each input award, find best match: exact canonical equality first,
  // then longest prefix-or-suffix substring. Suffix-year drift is normal
  // (e.g. user has "-02" but RePORTER returned "-03").
  const pairs: Pair[] = awards.map((award, i) => {
    const target = canonicalAwards[i];
    const exact = results.find((r) => r.canonical === target);
    if (exact) return { award, applId: exact.applId };
    let best: { applId: number; len: number } | null = null;
    for (const r of results) {
      const overlap =
        r.canonical.startsWith(target) || target.startsWith(r.canonical)
          ? Math.min(r.canonical.length, target.length)
          : 0;
      if (overlap >= 8 && (best === null || overlap > best.len)) {
        best = { applId: r.applId, len: overlap };
      }
    }
    return { award, applId: best?.applId ?? null };
  });

  return NextResponse.json({ results: pairs });
}
