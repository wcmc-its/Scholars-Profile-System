import { NextResponse, type NextRequest } from "next/server";
import {
  searchPeople,
  searchPublications,
  type PeopleSort,
  type PublicationsSort,
} from "@/lib/api/search";
import {
  searchFunding,
  type FundingFilters,
  type FundingRoleBucket,
  type FundingSort,
  type FundingStatus,
} from "@/lib/api/search-funding";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { parseMeshParam, resolveConceptMode } from "@/lib/api/search-flags";

export const dynamic = "force-dynamic";

// Valid topic slug pattern — same as topic page slug (D-02 candidate (e): topic.id is the slug).
// Rejects non-slug shapes to prevent blind-comparison probing (T-03-06-01).
const TOPIC_SLUG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "people";
  const rawPage = parseInt(params.get("page") ?? "0", 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;

  // Issue #259 §1.5 — taxonomy match (curated + MeSH resolution) computed
  // once at the top so all three branches can log resolution outcome.
  // matchQueryToTaxonomy short-circuits on q < 3 normalized chars, so the
  // cost here is one Map lookup + one indexed etl_run row when the cache
  // is hot. Same call the server-rendered /search page makes; the duplication
  // is acceptable until call sites consolidate.
  //
  // Issue #259 SPEC §7.5 — split-scope timing. `taxonomyMatchMs` measures
  // the resolver in isolation so a resolver regression doesn't dilute the
  // §3.1 (c) +10ms p95 guardrail (which targets the rebalance's body
  // construction + OpenSearch round-trip, not the resolver).
  const taxonomyStart = Date.now();
  const taxonomyMatch = await matchQueryToTaxonomy(q);
  const taxonomyMatchMs = Date.now() - taxonomyStart;
  // Issue #259 §6.2 — `?mesh=off` wins over `?mesh=strict` regardless of
  // URL ordering. `parseMeshParam` uses `getAll + includes` so the rule
  // holds for `?mesh=strict&mesh=off`, which the raw `params.get` shape
  // got wrong (it returns the first value only). Single source of truth
  // shared with the SSR page so route handler and page agree on a URL.
  const { meshOff, meshStrict } = parseMeshParam(params);
  const effectiveMeshResolution = meshOff ? null : taxonomyMatch.meshResolution;
  const conceptMode = resolveConceptMode();
  const meshResolutionDescriptorUi =
    taxonomyMatch.meshResolution?.descriptorUi ?? null;
  const meshResolutionConfidence =
    taxonomyMatch.meshResolution?.confidence ?? null;

  // Issue #78 — Funding tab. Multi-select facets are repeated params,
  // OR within group, AND across groups. Mirrors the people/publications
  // pattern.
  if (type === "funding") {
    const sort = (params.get("sort") ?? "relevance") as FundingSort;
    const status = params.getAll("status").filter(
      (s): s is FundingStatus =>
        s === "active" || s === "ending_soon" || s === "recently_ended",
    );
    const role = params.getAll("role").filter(
      (r): r is FundingRoleBucket =>
        r === "PI" || r === "Multi-PI" || r === "Co-I",
    );
    const filters: FundingFilters = {
      funder: orUndefined(params.getAll("funder")),
      directFunder: orUndefined(params.getAll("directFunder")),
      programType: orUndefined(params.getAll("programType")),
      mechanism: orUndefined(params.getAll("mechanism")),
      status: status.length > 0 ? status : undefined,
      department: orUndefined(params.getAll("department")),
      role: role.length > 0 ? role : undefined,
    };
    const result = await searchFunding({ q, page, sort, filters });
    console.log(
      JSON.stringify({
        event: "search_query",
        q,
        type: "funding",
        resultCount: result.total,
        filters,
        meshResolutionDescriptorUi,
        meshResolutionConfidence,
        // SPEC §7.5 — resolver scope. Logged on every branch so a resolver
        // regression (orthogonal to the rebalance) is observable here too.
        taxonomyMatchMs,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(result);
  }

  if (type === "publications") {
    const sort = (params.get("sort") ?? "relevance") as PublicationsSort;
    const yearMin = params.get("yearMin") ? parseInt(params.get("yearMin")!, 10) : undefined;
    const yearMax = params.get("yearMax") ? parseInt(params.get("yearMax")!, 10) : undefined;
    const publicationType = params.get("publicationType") ?? undefined;
    const journal = params.getAll("journal");
    const wcmAuthorRoleRaw = params.getAll("wcmAuthorRole");
    const wcmAuthorRole = wcmAuthorRoleRaw.filter(
      (r): r is "first" | "senior" | "middle" =>
        r === "first" || r === "senior" || r === "middle",
    );
    // Issue #259 SPEC §7.5 — `searchLatencyMs` covers the body construction
    // + OpenSearch round-trip + Prisma hydration. Excludes the resolver
    // (captured separately as `taxonomyMatchMs`) so the §3.1 (c) guardrail
    // attributes regressions to the rebalance code path, not unrelated
    // resolver drift.
    const searchStart = Date.now();
    const result = await searchPublications({
      q,
      page,
      sort,
      filters: {
        yearMin,
        yearMax,
        publicationType,
        journal: journal.length > 0 ? journal : undefined,
        wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
      },
      // Issue #259 §5 — pass the MeSH resolution computed at the top of
      // the handler. Under `SEARCH_PUB_TAB_CONCEPT_MODE=expanded` and this
      // non-null, searchPublications produces the §5.2 four-clause body.
      // Under `strict` (default at PR-3 merge), it produces the same
      // `concept_filtered` / `concept_fallback` body as today's prod.
      // §1.11 — `effectiveMeshResolution` honors `?mesh=off`; when off,
      // this is null and the pub query falls back to the §1.2 shape.
      meshResolution: effectiveMeshResolution,
      // §6.2 — chip's "Narrow to this concept only" opt-in. Forces
      // strict-mode admission under flag = `expanded`. `?mesh=off`
      // precedence is already enforced upstream by nulling the resolution.
      meshStrict,
    });
    const searchLatencyMs = Date.now() - searchStart;
    // ANALYTICS-02 (D-02): structured search-query log (publications branch).
    // Issue #259 §1.2 — queryShape attributes result-count and ranking
    // changes to the code path that served the request. Same enum and
    // field name as the people branch so downstream analytics can group
    // by `type + queryShape`.
    console.log(
      JSON.stringify({
        event: "search_query",
        q,
        type: "publications",
        resultCount: result.total,
        queryShape: result.queryShape,
        // SPEC §7.5 — resolved mode (after the legacy `OR_OF_EVIDENCE`
        // fallback). Captures the per-request shape without analysts
        // having to know which env mapping was active.
        conceptMode,
        filters: { yearMin, yearMax, publicationType, journal, wcmAuthorRole },
        meshResolutionDescriptorUi,
        meshResolutionConfidence,
        // Issue #259 §5.4.2 / SPEC §7.5. Bucketed in the post-flip retro plot
        // to attribute recall lift to descendant-set size (small subtree →
        // small lift, broad descriptor → big lift). `null` when resolution
        // is null (mesh=off, no-match, or under-3-char query) so downstream
        // queries can distinguish "no resolution" from "resolution with a
        // self-only descendant set" (length 1).
        meshDescendantSetSize: result.meshDescendantSetSize,
        // SPEC §7.5 — anchor-set size mirrors the descendant convention:
        // `null` distinguishes "no resolution" from "resolution with zero
        // anchors" (which exercises the `concept_fallback` strict-mode path).
        meshAnchorCount: result.meshAnchorCount,
        // Issue #259 §1.11 — opt-out signal. True when the request set
        // `?mesh=off`; logging the rate per descriptor tells us when the
        // chip's broaden affordance is over- or under-used.
        meshOff,
        // §6.2 — chip-engaged narrow-mode opt-in. True when `?mesh=strict`
        // present (and `?mesh=off` absent).
        meshStrict,
        // SPEC §7.5 — split-scope latency. `taxonomyMatchMs` is the resolver
        // alone; `searchLatencyMs` is the rebalance scope (body construction
        // + OpenSearch + hydration). The §3.1 (c) guardrail targets the
        // latter; the former is logged on every branch (people/funding too)
        // so resolver-only regressions are attributable.
        taxonomyMatchMs,
        searchLatencyMs,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(result);
  }

  const sort = (params.get("sort") ?? "relevance") as PeopleSort;
  // Issue #8/#9: facets are repeated params, OR'd within a group.
  const deptDiv = params.getAll("deptDiv");
  const personType = params.getAll("personType");
  const activityRaw = params.getAll("activity");
  const activity = activityRaw.filter(
    (a): a is "has_grants" | "recent_pub" => a === "has_grants" || a === "recent_pub",
  );
  // URL contract: `?includeIncomplete=false` opts INTO the sparse-profile
  // cull (only scholars with overview + ≥3 pubs + active grant). Any other
  // value — including the param being absent — leaves the filter unset so
  // the result matches the /search page (which never sends the param).
  // Previously this was `=== "true"`, which silently coerced "absent" to
  // `false` and triggered the cull on every API call, producing API totals
  // far below the page totals (#152's `isComplete` filter applied to every
  // headless caller by accident).
  const rawIncludeIncomplete = params.get("includeIncomplete");
  const includeIncomplete =
    rawIncludeIncomplete === null ? undefined : rawIncludeIncomplete === "true";

  // D-10 topic filter: validate slug shape before passing to searchPeople.
  const topicRaw = params.get("topic");
  let topic: string | undefined;
  if (topicRaw !== null && topicRaw.length > 0) {
    if (!TOPIC_SLUG_RE.test(topicRaw)) {
      return NextResponse.json({ error: "invalid topic" }, { status: 400 });
    }
    topic = topicRaw;
  }

  const result = await searchPeople({
    q,
    page,
    sort,
    filters: {
      deptDiv: deptDiv.length > 0 ? deptDiv : undefined,
      personType: personType.length > 0 ? personType : undefined,
      activity: activity.length > 0 ? activity : undefined,
      includeIncomplete,
    },
    topic,
  });
  // ANALYTICS-02 (D-02): structured search-query log (people branch).
  // Issue #259 §1.1 — queryShape attributes result-count and ranking
  // changes to the code path that served the request. Reserved enum
  // values name future §1.6 shapes up front (see PeopleQueryShape).
  console.log(
    JSON.stringify({
      event: "search_query",
      q,
      type: "people",
      resultCount: result.total,
      queryShape: result.queryShape,
      filters: { deptDiv, personType, activity, includeIncomplete },
      meshResolutionDescriptorUi,
      meshResolutionConfidence,
      taxonomyMatchMs,
      ts: new Date().toISOString(),
    }),
  );
  return NextResponse.json(result);
}

function orUndefined<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined;
}
