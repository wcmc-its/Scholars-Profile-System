import { NextResponse, type NextRequest } from "next/server";

import { stripDeprioritized } from "@/lib/api/deprioritized-terms";
import { resolveFundingConceptGrants, resolveSearchEvidenceRows } from "@/lib/api/search-flags";
import { searchFunding } from "@/lib/api/search-funding";
import type { MeshResolution } from "@/lib/api/search-taxonomy";
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
 * Matching is TEXT-only UNLESS `SEARCH_FUNDING_CONCEPT_GRANTS` is on (#1359 Tier 2):
 * with the flag + a `descriptorUis`/`label` concept (mirrors the key-paper route's
 * params), the route threads a MeSH resolution into `searchFunding` so a grant
 * surfaces by concept tag even without a literal text hit, and returns a row-level
 * `strength` ("tagged" when the concept axis admitted a surfaced grant, else
 * "mention") that the card turns into "N of M grants tagged <Concept>" vs the
 * "mention '<query>'" line. Flag off / no concept ⇒ text-only, byte-identical to v1.
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

  // #1359 Tier 2 — thread the page-resolved concept (passed by the card, mirroring
  // the key-paper route's `descriptorUis`/`label`) so grants surface by concept tag,
  // not just literal text. Flag-gated for the recall A/B; absent concept ⇒ null ⇒
  // text-only. `searchFunding` reads only `.descendantUis` (admission) and `.name`
  // (the phrase boost / concept label), so a minimal resolution is sufficient.
  const sp = request.nextUrl.searchParams;
  const descriptorUis = (sp.get("descriptorUis") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const label = sp.get("label")?.trim() ?? "";
  const meshResolution: MeshResolution | null =
    resolveFundingConceptGrants() && descriptorUis.length > 0
      ? {
          descriptorUi: descriptorUis[0],
          name: label,
          matchedForm: label,
          confidence: "exact",
          scopeNote: null,
          entryTerms: [],
          curatedTopicAnchors: [],
          descendantUis: descriptorUis,
        }
      : null;

  try {
    const result = await searchFunding({
      q: contentQuery,
      filters: { investigator: [cwid] },
      sort: "relevance",
      page: 0,
      // Omitted ⇒ `expanded` scope: admit text OR concept-tagged (the recall gain).
      ...(meshResolution ? { meshResolution } : {}),
    });
    const grants: EvidenceGrant[] = result.hits.slice(0, GRANT_CAP).map((h) => ({
      projectId: h.projectId,
      title: h.title,
      // #1359 — carry the matched-term highlight (already computed by searchFunding)
      // so KEY FUNDING marks the query term in grant titles, like key papers.
      titleHighlight: h.titleHighlight,
      sponsor: h.primeSponsor || null,
      startYear: year(h.startDate),
      endYear: year(h.endDate),
      isActive: h.isActive,
      // Per-ROW concept admission. The page-level `strength` below cannot answer this:
      // on a mixed page it reads "tagged" while individual rows are literal-text hits.
      // A concept-captioned card block needs the row fact, not the page's.
      matchedConcept: h.matchedConcept,
    }));
    // Row-level reason strength: "tagged" when the concept axis admitted ≥1 surfaced
    // grant (mirrors composeMatchReason's tagged>mention precedence), else "mention".
    // ponytail: read off the returned page hits' `matchedConcept` — a concept-only
    // grant ranked below the page could leave a mixed row labeled "mention". A display
    // label, not the admission set; upgrade by returning a concept count from
    // searchFunding if the mislabel proves confusing during the soak.
    const strength: "tagged" | "mention" =
      meshResolution !== null && result.hits.some((h) => h.matchedConcept) ? "tagged" : "mention";
    return NextResponse.json({ grants, total: result.total, strength }, { headers: NO_STORE });
  } catch {
    return NextResponse.json(EMPTY, { headers: NO_STORE });
  }
}
