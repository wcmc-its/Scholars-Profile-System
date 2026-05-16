"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
   * Issue #327 — paper-level top topic for the inline "Top topic: X"
   * affordance below the title. Server filters out the self-reference
   * (paper's top topic == current page's topic) so a non-null value here
   * always means "this paper belongs more centrally somewhere else".
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
   * decide whether to render the "View additional articles…" toggle.
   */
  tierTotals: { strongly: number; also: number };
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
 *      and `displayThreshold`. Hidden behind a collapsible toggle:
 *      *"View additional articles that are relevant"*. Toggle resets to
 *      collapsed on every mount (no localStorage / URL persistence per
 *      #324 open Q2 spec lean).
 *
 * Edge cases:
 *   - Also-tier is empty in the active filter scope → toggle hidden.
 *   - Strongly-tier is empty in the active filter scope but Also-tier
 *     has results → render the Also-tier list directly without a toggle.
 *     Rare today (default 0.5 threshold; some topics may tune higher).
 *
 * Sort / filter / subtopic changes re-fetch both tiers and reset their
 * page counters to 1 independently.
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
  // Toggle defaults to collapsed on every mount (#326 acceptance criteria —
  // page reload resets to collapsed). No localStorage / URL param.
  const [alsoOpen, setAlsoOpen] = useState(false);

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

  // Reset the Also-tier page when the toggle reopens — restarts pagination
  // at page 1 each time the user re-expands the section.
  useEffect(() => {
    if (alsoOpen) setAlsoPage(1);
  }, [alsoOpen]);

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
  //   (a) the user opened the toggle, OR
  //   (b) the strongly tier has 0 results in the current scope but Also has
  //       some — we surface them directly so the page isn't blank.
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
    enabled: alsoOpen || renderAlsoInline,
  });

  const tierTotals = strongly.data?.tierTotals ?? null;
  // Toggle only appears when there are results to reveal AND the strongly
  // tier has at least one entry of its own. When strongly is empty we
  // render the Also list directly (`renderAlsoInline` above), so the
  // toggle would be redundant.
  const showAlsoToggle =
    tierTotals !== null && tierTotals.strongly > 0 && tierTotals.also > 0;

  // Sort-row count: prefer the strongly tier's total when it has results;
  // otherwise fall back to the also count so the displayed number always
  // reflects what the user is looking at.
  const sortRowCount = strongly.data
    ? renderAlsoInline
      ? also.data?.total ?? null
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
          <span className="text-sm text-muted-foreground">Sort by</span>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="w-[200px]">
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

      {showAlsoToggle && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setAlsoOpen((s) => !s)}
            aria-expanded={alsoOpen}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            <span
              aria-hidden="true"
              className={`inline-block transition-transform ${alsoOpen ? "rotate-90" : ""}`}
            >
              ▸
            </span>
            {alsoOpen
              ? "Hide additional articles"
              : `View additional articles that are relevant (${tierTotals.also.toLocaleString()})`}
          </button>
        </div>
      )}

      {(alsoOpen || renderAlsoInline) && (
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
  const hasMetaRow = Boolean(hit.journal || hit.year || hit.topTopic);
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
      {hasMetaRow && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {hit.journal && (
            <span
              className="italic"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(hit.journal) }}
            />
          )}
          {hit.journal && hit.year ? <span aria-hidden="true">·</span> : null}
          {hit.year ? <span>{hit.year}</span> : null}
          {hit.topTopic && (
            <>
              {(hit.journal || hit.year) && <span aria-hidden="true">·</span>}
              {/* Issue #327 — inline label appears only when the paper's
                  top topic differs from the current page's topic (server
                  enforces that invariant; UI just renders what it gets). */}
              <span>
                Top topic:{" "}
                <Link
                  href={`/topics/${hit.topTopic.id}`}
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
                >
                  {hit.topTopic.label}
                </Link>
              </span>
            </>
          )}
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
