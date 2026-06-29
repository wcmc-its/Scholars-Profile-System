import { NextResponse, type NextRequest } from "next/server";

import { stripDeprioritized } from "@/lib/api/deprioritized-terms";
import { resolveSearchEvidenceRows } from "@/lib/api/search-flags";
import { searchFunding } from "@/lib/api/search-funding";
import type { EvidenceGrant } from "@/lib/api/result-evidence";

/**
 * GET /api/scholar/[cwid]/grants?q=<query>
 *
 * Lazy per-scholar topic-matching grants for the Scholars-card "Funding" evidence
 * row (handoff: generalized evidence rows). Mirrors the method-exemplar fetcher —
 * off-by-default flag, never cached, default-safe empty, never 500. The card calls
 * this only for scholars with grantCount > 0 and a non-empty query, and renders the
 * Funding row only when ≥1 grant comes back (hide-when-empty, §4.1/§5).
 *
 * Gated behind SEARCH_EVIDENCE_ROWS: off ⇒ { grants: [], total: 0 } so prod is inert
 * and the route can't be probed for data early.
 *
 * ponytail: eager per-card fetch (one searchFunding call per grant-having card).
 * searchFunding also runs facet aggs + Prisma hydration, so it is heavier than a
 * bare lookup. If staging latency bites, hoist presence+count to a SINGLE funding
 * terms-agg over wcmInvestigatorCwids on the people-search path (1 query/search) and
 * keep this route only for the on-expand record list.
 *
 * Matching is TEXT-only (no meshResolution/scope threaded), per spec §2 (text is the
 * base mechanism; MeSH is an optional boost). Consequence: the "N grants" count here
 * can differ from the Funding tab's count for the same query (the tab threads the
 * resolved MeSH concept). ponytail: thread meshResolution in if that divergence
 * proves confusing during the staging soak — left text-only for v1.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** The inert / error / no-match response — never a dead control on the card. */
const EMPTY: { grants: EvidenceGrant[]; total: number } = { grants: [], total: 0 };

/** Top-N representative grants in the disclosure (parity with rep-papers' 3). */
const GRANT_CAP = 3;

function year(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  if (!resolveSearchEvidenceRows()) {
    return NextResponse.json(EMPTY, { headers: NO_STORE });
  }

  const { cwid } = await params;
  const query = request.nextUrl.searchParams.get("q")?.trim();
  // Funding row is topic-scoped: no query ⇒ no topic to match ⇒ no row. (Also avoids
  // searchFunding's meaningless match_all relevance sort on an empty q.)
  if (!query) {
    return NextResponse.json(EMPTY, { headers: NO_STORE });
  }

  // #1339: match on the generic-stripped SIGNIFICANT query, mirroring KEY PAPERS
  // (#692/#707). Raw `q` lets an academic-common term ("health") admit grants on its
  // own (searchFunding is OR), so "children's health" surfaced health-only grants even
  // though "children's" matched none. stripDeprioritized's never-empty contract keeps
  // contentQuery non-empty whenever `query` is; a fully-generic query ("health") falls
  // back to itself, same as KEY PAPERS.
  // ponytail: no min_score floor — the strip removes the spurious admission; add a
  // relevance floor only if a weak survivor still mis-renders during the soak.
  const { contentQuery } = stripDeprioritized(query);

  try {
    const result = await searchFunding({
      q: contentQuery,
      filters: { investigator: [cwid] },
      sort: "relevance",
      page: 0,
    });
    const grants: EvidenceGrant[] = result.hits.slice(0, GRANT_CAP).map((h) => ({
      projectId: h.projectId,
      title: h.title,
      sponsor: h.primeSponsor || null,
      startYear: year(h.startDate),
      endYear: year(h.endDate),
      isActive: h.isActive,
    }));
    return NextResponse.json({ grants, total: result.total }, { headers: NO_STORE });
  } catch {
    return NextResponse.json(EMPTY, { headers: NO_STORE });
  }
}
