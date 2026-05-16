"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { CuratedTag } from "@/components/topic/curated-tag";
import { sanitizePubTitle } from "@/lib/utils";

type Sort = "newest" | "most_cited" | "by_impact";
type Filter = "research_articles_only" | "all";
type Tier = "strongly" | "also";
/**
 * Issue #326 refinement — top-of-list scope control. Replaces the prior
 * bottom "View additional articles…" disclosure button. "strongly" shows
 * the strongly-relevant tier only (default); "all" stacks the also-relevant
 * tier below it, divided by the "Also relevant" h3.
 */
type ShowTier = "strongly" | "all";

type Hit = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  publicationType: string | null;
  citationCount: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  pmcid: string | null;
  /**
   * Issue #305 — topic-context impact score for the row at this topic's
   * `parentTopicId`. Renders inline as `Impact: NN` in the meta row when
   * non-null. Null when the row has no LLM-scored impact value OR when
   * `SEARCH_PUB_TAB_IMPACT` is off (API short-circuits to null).
   */
  impactScore: number | null;
  /**
   * Issue #316 PR-C — GPT-generated rubric justification for `impactScore`.
   * When present, the inline `Impact: NN` becomes a hover/focus tooltip
   * trigger revealing this text. Null when impactScore is null or the
   * publication has no impact data.
   */
  impactJustification: string | null;
  authors: Array<{
    name: string;
    cwid: string;
    slug: string;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
  }>;
  /** Issue #288 PR-A — inline abstract disclosure. Null when the publication
   *  has no abstract; the disclosure component returns null in that case. */
  abstract: string | null;
  /**
   * Issue #327 — paper's argmax topic, surfaced inline as "Best fit: X"
   * on its own row below the bibliographic line. Server filters out the
   * self-reference (paper's top topic == current page's topic) so a
   * non-null value here always means "this paper belongs more centrally
   * somewhere else".
   */
  topTopic: { id: string; label: string } | null;
};

type FeedResponse = {
  hits: Hit[];
  total: number;
  totalAllTypes: number;
  totalResearchOnly: number;
  /**
   * Issue #326 — counts within the active filter scope partitioned by
   * tier (`score >= displayThreshold` vs `<`). Always present; the
   * `tier` query param controls only which rows fill `hits`. Used to
   * populate the option-label counts on the top-of-list "Show" select
   * (subtopic-scoped counts, so the labels reflect what's actually in
   * view).
   */
  tierTotals: { strongly: number; also: number };
  /**
   * Issue #326 refinement — parent-topic-scope tier totals: ignores
   * subtopic filter, respects pub-type filter. Used to decide whether
   * the scope select renders at all, keeping the control visible on
   * subtopic views whose own also-count is 0 so the topic → subtopic
   * UX stays consistent.
   */
  parentTierTotals: { strongly: number; also: number };
  page: number;
  pageSize: number;
};

/**
 * Topic-detail publication feed (issue #326 two-tier display).
 *
 * Two list sections share a single sort/filter/subtopic toolbar:
 *
 *   1. "Strongly relevant" — papers with `PublicationTopic.score`
 *      ≥ `Topic.displayThreshold ?? 0.5`. Always visible (when the tier
 *      has results). Renders without an explicit "Strongly relevant"
 *      heading — these are the papers the user expects to see.
 *
 *   2. "Also relevant" — papers between the 0.3 upstream `score_floor`
 *      and `displayThreshold`. Hidden behind a top-of-list scope control
 *      (`Show: [Strongly relevant ▼]`) that toggles between strongly-only
 *      and stacked-with-also views. Defaults to "Strongly relevant" on
 *      every mount (no localStorage / URL persistence per #324 open Q2).
 *      The select supersedes the prior bottom "View additional articles…"
 *      disclosure — same affordance, single discoverable location
 *      parallel to `Sort by`.
 *
 * Edge cases:
 *   - Also-tier is empty in the active filter scope → select hidden.
 *   - Strongly-tier is empty in the active filter scope but Also-tier
 *     has results → render the Also-tier list inline without the select
 *     (the strongly-only option would be misleading). Rare today (default
 *     0.5 threshold; some topics may tune higher).
 *
 * Sort / filter / subtopic changes re-fetch both tiers and reset their
 * page counters to 1 independently. The scope control state survives
 * sort/filter/subtopic changes — switching mode is a separate concern
 * from re-ordering within the current scope.
 */
export function PublicationFeed({
  topicSlug,
  activeSubtopic,
  subtopicLabel,
  subtopicShortDescription,
  suppressSubtopicHeader = false,
}: {
  topicSlug: string;
  activeSubtopic: string | null;
  subtopicLabel: string | null;
  subtopicShortDescription: string | null;
  /**
   * When the parent layout renders the subtopic heading + description above
   * the researcher list (issue #172 reorder), suppress the duplicate heading
   * here. The result count and sort control stay; only the title/subtitle
   * block is hidden.
   */
  suppressSubtopicHeader?: boolean;
}) {
  const [sort, setSort] = useState<Sort>("newest");
  const [filter, setFilter] = useState<Filter>("research_articles_only");
  const [stronglyPage, setStronglyPage] = useState(1);
  const [alsoPage, setAlsoPage] = useState(1);
  // Scope control defaults to "strongly" on every mount (#326 acceptance
  // criterion — page reload resets the scope). No localStorage / URL param.
  const [showTier, setShowTier] = useState<ShowTier>("strongly");

  const isCuratedSort = sort === "by_impact";
  const heading =
    activeSubtopic && subtopicLabel
      ? subtopicLabel
      : filter === "research_articles_only"
        ? "Research articles in this area"
        : "All publications in this area";

  // Reset both page counters on sort/subtopic/filter change.
  useEffect(() => {
    setStronglyPage(1);
    setAlsoPage(1);
  }, [sort, activeSubtopic, filter]);

  // Reset the Also-tier page each time the user switches into the stacked
  // "All relevant" scope — restart pagination at page 1.
  useEffect(() => {
    if (showTier === "all") setAlsoPage(1);
  }, [showTier]);

  const strongly = useTierFetch({
    topicSlug,
    activeSubtopic,
    sort,
    filter,
    tier: "strongly",
    page: stronglyPage,
    enabled: true,
  });

  // The Also-tier fetch fires under either:
  //   (a) the user switched the scope control to "all", OR
  //   (b) the strongly tier has 0 results in the current scope but Also has
  //       some — we surface them inline so the page isn't blank.
  const stronglyEmpty =
    strongly.data !== null && (strongly.data.tierTotals.strongly ?? 0) === 0;
  const alsoAvailable =
    strongly.data !== null && (strongly.data.tierTotals.also ?? 0) > 0;
  const renderAlsoInline = stronglyEmpty && alsoAvailable;
  const also = useTierFetch({
    topicSlug,
    activeSubtopic,
    sort,
    filter,
    tier: "also",
    page: alsoPage,
    enabled: showTier === "all" || renderAlsoInline,
  });

  const tierTotals = strongly.data?.tierTotals ?? null;
  const parentTierTotals = strongly.data?.parentTierTotals ?? null;
  // The scope select appears when:
  //   1. The parent topic has also-tier papers under the active pub-type
  //      filter — i.e., switching to "All relevant" could plausibly reveal
  //      more papers, even if the current subtopic happens to have 0
  //      also-tier rows. (Keeps UI consistent across topic → subtopic.)
  //   2. The current scope has at least one strongly-tier row — when
  //      strongly is empty we render the Also list inline via
  //      `renderAlsoInline`, so the "Strongly relevant" option would be
  //      misleading.
  // The option-label counts use `tierTotals` (subtopic-scoped) so the
  // user sees what's actually in view — if subtopic also=0, both options
  // show the same count and the user can tell switching is a no-op.
  const showTierSelect =
    parentTierTotals !== null &&
    parentTierTotals.also > 0 &&
    tierTotals !== null &&
    tierTotals.strongly > 0;

  // Sort-row count: reflect what the user is actually looking at. In
  // "All relevant" the count is the combined tier total so it doesn't
  // read as "12 results" while 25 rows are on screen.
  const sortRowCount = strongly.data
    ? renderAlsoInline
      ? also.data?.total ?? null
      : showTier === "all" && tierTotals
        ? tierTotals.strongly + tierTotals.also
        : strongly.data.total
    : null;
  const sortRowLabel =
    sortRowCount !== null ? `${sortRowCount.toLocaleString()} results` : null;

  return (
    <section className="flex flex-col gap-4">
      <header
        className={
          suppressSubtopicHeader
            ? "flex flex-wrap items-center justify-between gap-3 border-y border-border py-2"
            : "flex flex-wrap items-start justify-between gap-4"
        }
      >
        {suppressSubtopicHeader ? (
          // Issue #172: heading + description moved above the researcher list.
          // Header collapses to a "sort-row" — results count on the left,
          // sort control on the right, hairline border top + bottom.
          <span className="text-sm text-muted-foreground">{sortRowLabel ?? ""}</span>
        ) : (
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <span>{heading}</span>
              {isCuratedSort && <CuratedTag surface="publication_centric" />}
            </h2>
            {activeSubtopic !== null &&
              subtopicShortDescription !== null &&
              subtopicShortDescription.trim() !== "" && (
                <p className="text-sm text-muted-foreground">{subtopicShortDescription}</p>
              )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {showTierSelect && tierTotals && (
            <>
              <span className="text-sm text-muted-foreground">Show</span>
              <Select
                value={showTier}
                onValueChange={(v) => setShowTier(v as ShowTier)}
              >
                <SelectTrigger className="w-[200px]" aria-label="Show">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="strongly">
                    Strongly relevant ({tierTotals.strongly.toLocaleString()})
                  </SelectItem>
                  <SelectItem value="all">
                    All relevant (
                    {(tierTotals.strongly + tierTotals.also).toLocaleString()})
                  </SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
          <span className="text-sm text-muted-foreground">Sort by</span>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="w-[200px]" aria-label="Sort by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="by_impact">By impact (ReCiterAI)</SelectItem>
              <SelectItem value="most_cited">Most cited</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <FilterToggleRow
        data={strongly.data}
        filter={filter}
        setFilter={setFilter}
        suppressSubtopicHeader={suppressSubtopicHeader}
        sortRowLabel={sortRowLabel}
      />

      {/* Strongly relevant tier (default visible). Renders only when the
          tier has results; if the tier is empty in the active scope but
          Also has results, we fall through to render the Also list
          inline below — see renderAlsoInline. */}
      {!renderAlsoInline && (
        <TierSection
          loading={strongly.loading}
          error={strongly.error}
          data={strongly.data}
          page={stronglyPage}
          onPageChange={setStronglyPage}
          topicSlug={topicSlug}
          emptyState
        />
      )}

      {(showTier === "all" || renderAlsoInline) && (
        <div className={renderAlsoInline ? "" : "mt-2 border-t border-border pt-4"}>
          {!renderAlsoInline && (
            <h3 className="mb-3 text-base font-semibold">Also relevant</h3>
          )}
          <TierSection
            loading={also.loading}
            error={also.error}
            data={also.data}
            page={alsoPage}
            onPageChange={setAlsoPage}
            topicSlug={topicSlug}
            emptyState={renderAlsoInline}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Sort-row companion: the "Show all publication types / Hide non-research"
 * filter toggle (#30). Sourced from the strongly-tier response because the
 * Also-tier shares the same totals (publication-type counts ignore tier).
 */
function FilterToggleRow({
  data,
  filter,
  setFilter,
  suppressSubtopicHeader,
  sortRowLabel,
}: {
  data: FeedResponse | null;
  filter: Filter;
  setFilter: (f: Filter) => void;
  suppressSubtopicHeader: boolean;
  sortRowLabel: string | null;
}) {
  if (!data || data.total === 0 && data.tierTotals.also === 0) return null;
  const totalAllTypes = data.totalAllTypes;
  const totalResearchOnly = data.totalResearchOnly;
  const hasDelta = totalAllTypes > totalResearchOnly;
  if (!hasDelta && suppressSubtopicHeader) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      {/* In subtopic mode the count lives in the sticky header row; here
          we keep the row so the filter-toggle still has a home. */}
      {suppressSubtopicHeader ? <span /> : <span>{sortRowLabel ?? ""}</span>}
      {filter === "research_articles_only" && hasDelta ? (
        <button
          type="button"
          onClick={() => setFilter("all")}
          className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          Show all publication types ({(totalAllTypes - totalResearchOnly).toLocaleString()} more) →
        </button>
      ) : filter === "all" && hasDelta ? (
        <button
          type="button"
          onClick={() => setFilter("research_articles_only")}
          className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          Hide non-research types →
        </button>
      ) : null}
    </div>
  );
}

function TierSection({
  loading,
  error,
  data,
  page,
  onPageChange,
  topicSlug,
  emptyState,
}: {
  loading: boolean;
  error: string | null;
  data: FeedResponse | null;
  page: number;
  onPageChange: (p: number) => void;
  topicSlug: string;
  /** When true the section renders an empty-state card; when false it
   *  renders nothing on empty (used for the strongly tier when the Also
   *  fallback is taking over, and for the Also tier inside the toggle). */
  emptyState: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-muted-foreground">
        Could not load publications. Try refreshing.
      </div>
    );
  }
  if (!data || data.total === 0) {
    if (!emptyState) return null;
    return (
      <div className="py-8 text-center">
        <h3 className="text-base font-semibold">No publications found</h3>
        <p className="text-sm text-muted-foreground">
          Publications in this area will appear as they are indexed.
        </p>
      </div>
    );
  }
  return (
    <>
      <ul className="divide-y divide-border">
        {data.hits.map((h) => (
          <PubRow key={h.pmid} hit={h} topicSlug={topicSlug} />
        ))}
      </ul>
      <PaginationRow
        total={data.total}
        pageSize={data.pageSize}
        page={page}
        onPageChange={onPageChange}
      />
    </>
  );
}

function PubRow({ hit, topicSlug }: { hit: Hit; topicSlug: string }) {
  const { open: openModal } = usePublicationModal();
  const titleHtml = sanitizePubTitle(hit.title);
  return (
    <li className="py-4">
      <div className="line-clamp-2 font-semibold leading-snug">
        <button
          type="button"
          onClick={() => openModal(hit.pmid, { currentTopicSlug: topicSlug })}
          className="text-left hover:underline"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      </div>
      {(hit.journal || hit.year) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {hit.journal && (
            <span
              className="italic"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(hit.journal) }}
            />
          )}
          {hit.journal && hit.year ? <span aria-hidden="true">·</span> : null}
          {hit.year ? <span>{hit.year}</span> : null}
        </div>
      )}
      {/* Issue #327 — paper's argmax topic when it differs from the current
          page's topic (server filters out the self-reference). Lives on its
          own line below the bibliographic row with a leading Compass icon
          so it reads as a cross-listing signal, not as journal metadata. */}
      {hit.topTopic && (
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Compass className="h-3 w-3" aria-hidden="true" />
          <span>
            Best fit:{" "}
            <Link
              href={`/topics/${hit.topTopic.id}`}
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
            >
              {hit.topTopic.label}
            </Link>
          </span>
        </div>
      )}
      <AuthorChipRow authors={hit.authors} pmid={hit.pmid} />
      <PublicationMeta
        citationCount={hit.citationCount}
        impactScore={hit.impactScore}
        impactJustification={hit.impactJustification}
        pmid={hit.pmid}
        pmcid={hit.pmcid}
        doi={hit.doi}
        abstract={hit.abstract}
      />
    </li>
  );
}

function useTierFetch({
  topicSlug,
  activeSubtopic,
  sort,
  filter,
  tier,
  page,
  enabled,
}: {
  topicSlug: string;
  activeSubtopic: string | null;
  sort: Sort;
  filter: Filter;
  tier: Tier;
  page: number;
  enabled: boolean;
}): { data: FeedResponse | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Stop showing loading state when disabled, but keep stale data so
      // toggling the Also-tier off-then-on doesn't flash empty content.
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const url = new URL(
      `/api/topics/${encodeURIComponent(topicSlug)}/publications`,
      window.location.origin,
    );
    url.searchParams.set("sort", sort);
    url.searchParams.set("page", String(page));
    url.searchParams.set("filter", filter);
    url.searchParams.set("tier", tier);
    if (activeSubtopic) url.searchParams.set("subtopic", activeSubtopic);

    fetch(url.toString())
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: FeedResponse) => {
        if (!cancelled) setData(j);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [topicSlug, activeSubtopic, sort, filter, tier, page, enabled]);

  return { data, loading, error };
}

function PaginationRow({
  total,
  pageSize,
  page,
  onPageChange,
}: {
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const pages: (number | "ellipsis")[] = [];
  if (totalPages <= 6) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    const window: number[] = [];
    for (
      let i = Math.max(2, page - 2);
      i <= Math.min(totalPages - 1, page + 2);
      i++
    )
      window.push(i);
    pages.push(1);
    if (window[0] > 2) pages.push("ellipsis");
    window.forEach((p) => pages.push(p));
    if (window[window.length - 1] < totalPages - 1) pages.push("ellipsis");
    pages.push(totalPages);
  }

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            onClick={() => onPageChange(Math.max(1, page - 1))}
            aria-disabled={page <= 1}
          />
        </PaginationItem>
        {pages.map((p, i) =>
          p === "ellipsis" ? (
            <PaginationItem key={`e${i}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink
                onClick={() => onPageChange(p)}
                isActive={p === page}
              >
                {p}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <PaginationNext
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            aria-disabled={page >= totalPages}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
