import { NextResponse, type NextRequest } from "next/server";

import { resolveSearchResultEvidence } from "@/lib/api/search-flags";
import { loadMethodExemplar } from "@/lib/api/method-exemplar";

/**
 * GET /api/scholar/[cwid]/method-exemplar?family=<familyLabel>
 *
 * Lazy, on-hover resolve of the ONE representative paper for a scholar's matched
 * method FAMILY — the Variant-2 method-badge hover (`docs/search-snippet-
 * handoff.md` §7). Kept off the search-results derive so the cacheable results
 * page isn't tainted and the per-row pub lookups only run when a row is actually
 * hovered/focused.
 *
 * - Gated behind `SEARCH_RESULT_EVIDENCE` (the snippet flag): off ⇒ `{ pub: null }`
 *   so prod (flag-off) is inert and the route can't be probed for data early.
 * - Public surface: the #800/#801 overlay gate runs INSIDE `loadMethodExemplar`
 *   (forceSensitive, identical to the badge), so a suppressed/sensitive family
 *   yields null even when requested directly. Never cached; default-safe null on
 *   any error (a hover must never surface a 500).
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  if (!resolveSearchResultEvidence()) {
    return NextResponse.json({ pub: null }, { headers: NO_STORE });
  }

  const { cwid } = await params;
  const family = request.nextUrl.searchParams.get("family")?.trim();
  if (!family) {
    return NextResponse.json({ pub: null }, { headers: NO_STORE });
  }

  try {
    const pub = await loadMethodExemplar(cwid, family);
    return NextResponse.json({ pub }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ pub: null }, { headers: NO_STORE });
  }
}
