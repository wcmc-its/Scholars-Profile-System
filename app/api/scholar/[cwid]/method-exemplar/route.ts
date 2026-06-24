import { NextResponse, type NextRequest } from "next/server";

import { resolveSearchResultEvidence } from "@/lib/api/search-flags";
import { loadMethodExemplar, loadTopicExemplar } from "@/lib/api/method-exemplar";

/**
 * GET /api/scholar/[cwid]/method-exemplar?family=<familyLabel>[&q=<query>]
 * GET /api/scholar/[cwid]/method-exemplar?topic=<parentTopicSlug>[&q=<query>]
 *
 * Lazy, on-hover resolve of the representative papers for a search-result row
 * — `?family=` for a method-badge match, `?topic=` for a topic-badge match (the
 * §7 "one function, three callers"). Optional `&q=` is the active search term:
 * when present the loader surfaces + highlights title-matching papers first, so
 * the disclosure's "Key papers" are about the search, not just the scholar's
 * most-impactful pub in the area. The path keeps its historical `method-` name
 * because its CloudFront behavior already forwards the FULL query string
 * (AllViewer), so `?topic=` / `&q=` are served with NO edge change. Kept off the
 * search-results derive so the cacheable page isn't tainted and the per-row pub
 * lookups only run when a row is actually hovered/focused.
 *
 * - Gated behind `SEARCH_RESULT_EVIDENCE` (the snippet flag): off ⇒
 *   `{ pubs: [], total: 0 }` so prod (flag-off) is inert and the route can't be
 *   probed for data early.
 * - Public surface: the scholar / family / publication gates run INSIDE the
 *   loaders. Never cached; default-safe empty on any error (a disclosure fetch
 *   must never 500).
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** The inert / error / no-selector response — never a dead control on the card. */
const EMPTY: { pubs: unknown[]; total: number } = { pubs: [], total: 0 };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  if (!resolveSearchResultEvidence()) {
    return NextResponse.json(EMPTY, { headers: NO_STORE });
  }

  const { cwid } = await params;
  const sp = request.nextUrl.searchParams;
  const family = sp.get("family")?.trim();
  const topic = sp.get("topic")?.trim();
  const query = sp.get("q")?.trim() || undefined;

  try {
    let result: { pubs: unknown[]; total: number } = EMPTY;
    if (family) {
      result = await loadMethodExemplar(cwid, family, query);
    } else if (topic) {
      result = await loadTopicExemplar(cwid, topic, query);
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch {
    return NextResponse.json(EMPTY, { headers: NO_STORE });
  }
}
