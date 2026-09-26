"use client";

/**
 * The ONE publication feed shared by the topic page, the method family page and
 * the method category page (Topic & Method refactor phase 4). It replaces
 * `components/topic/publication-feed.tsx`, `components/method/publication-feed.tsx`
 * and the category "All work" row, which were three copies of one row + toolbar.
 *
 * One `PubRow`: title → publication modal, journal · year, the topic-only
 * "Best fit" line (#327, present only on topic hits), author chips, the meta band
 * (PMID / PMCID / DOI / lazy Abstract / citations / Impact) and the family-only
 * entity usage snippets (#1166, present only on entity-filtered family hits).
 *
 * Capabilities, set by the adapters at the bottom of this file:
 *   - `relevanceTiers` (topics): the #326 Show select (Strongly / All relevant),
 *     its visibility rule (hidden when the parent topic has no also-tier) and the
 *     fall-back to the also tier when the strongly tier is empty;
 *   - entity usage snippets (family pages, via the `?entity=` filter);
 *   - the non-research publication-type toggle (every feed).
 *
 * Two presentations of the same rows:
 *   - `loadMore` off (TAXONOMY_FEED_LOAD_MORE off, the default): today's
 *     numbered pagination, and on topics the stacked "Also relevant" section.
 *   - `loadMore` on: a "Show 20 more · 40 of 279" button, `?shown=N` kept in the
 *     URL so Back restores the loaded rows, and on topics ONE "All relevant" list.
 */
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Compass } from "lucide-react";
import { highlightSnippet } from "@/components/method/highlight-snippet";
import { SnippetUsageBadge } from "@/components/method/snippet-usage-badge";
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { pubTitleProps } from "@/components/publication/pub-html";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
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
import { PublicationsHeadingRow } from "@/components/taxonomy/publications-heading-row";
import {
  FEED_CHUNK,
  loadMoreLabel,
  nextChunkSize,
  readShownParam,
  writeShownParam,
} from "@/lib/taxonomy/feed-load-more";
import { sanitizePubTitle } from "@/lib/utils";

type Sort = "newest" | "most_cited" | "by_impact";
type Filter = "research_articles_only" | "all";
/** #326 — "strongly" shows the strongly-relevant tier only (default); "all"
 *  adds the also-relevant tier. */
type ShowTier = "strongly" | "all";

export type FeedHit = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number;
  publicationType: string | null;
  citationCount: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  pmcid: string | null;
  /** Inline `Impact: NN`; null when unscored or SEARCH_PUB_TAB_IMPACT is off. */
  impactScore: number | null;
  /** #316 — topic hits only; the hover text for `Impact: NN`. */
  impactJustification?: string | null;
  authors: ComponentProps<typeof AuthorChipRow>["authors"];
  /** #1881 — drives the lazy Abstract link (#1537); the text is never shipped. */
  hasAbstract?: boolean;
  /** #327 — topic hits only: the paper's argmax topic when it is another topic. */
  topTopic?: { id: string; label: string } | null;
  /** #1166 — family hits under `?entity=` only: usage sentences, best first. */
  entityUsages?: Array<{
    sentence: string;
    matchedSpan: { start: number; end: number } | null;
    usage: "used" | "appears";
  }>;
  /** Topic hits: the pub's primary subtopic (per-row area label). */
  primarySubtopicId?: string | null;
  /** Category-wide hits: the pub's family label (per-row area label). */
  familyLabel?: string | null;
};

type FeedResponse = {
  hits: FeedHit[];
  total: number;
  totalAllTypes: number;
  totalResearchOnly: number;
  /** #326 — topics only: in-scope counts per tier, whatever `tier` was asked. */
  tierTotals?: { strongly: number; also: number };
  /** #326 refinement — topics only: parent-topic-scope tier totals. */
  parentTierTotals?: { strongly: number; also: number };
  page: number;
  pageSize: number;
};

export type PublicationFeedProps = {
  /** Same-origin API path of the feed route. */
  endpoint: string;
  /** Scope params appended after sort/page/filter/tier, in order (e.g.
   *  `subtopic`, `entity`). A change resets the feed. Null/empty values are
   *  omitted. */
  scopeParams?: Array<[string, string | null]>;
  /** #326 Show select + tier requests (topics). */
  relevanceTiers?: boolean;
  /** Passed to the publication modal (topic pages). Omitted ⇒ `open(pmid)`. */
  modalTopicSlug?: string;
  /** Term highlighted inside entity usage snippets (#1166). */
  entityTerm?: string | null;
  /** Heading count override (e.g. "12 of 40 articles"); defaults to the count. */
  formatCount?: (data: FeedResponse, filter: Filter) => string;
  /** Rendered between the heading row and the type toggle. */
  headerSlot?: ReactNode;
  /** Empty-state body copy. */
  emptyBody: string;
  /** TAXONOMY_FEED_LOAD_MORE — Load more + `?shown=` + one merged tier list. */
  loadMore?: boolean;
  /** TAXONOMY_FEED_LOAD_MORE — the per-row area label ("· {subarea}"). */
  areaLabelFor?: (hit: FeedHit) => string | null;
};

/** Build a feed URL. Param order is part of the (tested) request contract. */
function feedUrl(
  endpoint: string,
  o: {
    sort: Sort;
    page: number;
    limit?: number;
    filter: Filter;
    tier?: "strongly" | "also";
    scopeParams: Array<[string, string | null]>;
  },
): string {
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("sort", o.sort);
  url.searchParams.set("page", String(o.page));
  if (o.limit !== undefined && o.limit !== FEED_CHUNK) {
    url.searchParams.set("limit", String(o.limit));
  }
  url.searchParams.set("filter", o.filter);
  if (o.tier) url.searchParams.set("tier", o.tier);
  for (const [k, v] of o.scopeParams) if (v) url.searchParams.set(k, v);
  return url.toString();
}

async function fetchFeed(url: string): Promise<FeedResponse> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as FeedResponse;
}

export function PublicationFeed({
  endpoint,
  scopeParams = [],
  relevanceTiers = false,
  modalTopicSlug,
  entityTerm = null,
  formatCount,
  headerSlot,
  emptyBody,
  loadMore = false,
  areaLabelFor,
}: PublicationFeedProps) {
  const [sort, setSort] = useState<Sort>("newest");
  const [filter, setFilter] = useState<Filter>("research_articles_only");
  // #326 — defaults to "strongly" on every mount (no persistence).
  const [showTier, setShowTier] = useState<ShowTier>("strongly");
  const scopeKey = JSON.stringify(scopeParams);
  const isCuratedSort = sort === "by_impact";

  // ---- numbered pages (flag off) -------------------------------------------
  const [stronglyPage, setStronglyPage] = useState(1);
  const [alsoPage, setAlsoPage] = useState(1);
  useEffect(() => {
    setStronglyPage(1);
    setAlsoPage(1);
  }, [sort, scopeKey, filter]);
  // Restart the also tier at page 1 on each switch into "All relevant".
  useEffect(() => {
    if (showTier === "all") setAlsoPage(1);
  }, [showTier]);

  const primaryUrl = loadMore
    ? null
    : feedUrl(endpoint, {
        sort,
        page: stronglyPage,
        filter,
        tier: relevanceTiers ? "strongly" : undefined,
        scopeParams,
      });
  const primary = usePagedFetch(primaryUrl);
  const stronglyEmpty =
    primary.data !== null && (primary.data.tierTotals?.strongly ?? 0) === 0;
  const alsoAvailable = primary.data !== null && (primary.data.tierTotals?.also ?? 0) > 0;
  const pagedAlsoInline = relevanceTiers && stronglyEmpty && alsoAvailable;
  const alsoUrl =
    !loadMore && relevanceTiers && (showTier === "all" || pagedAlsoInline)
      ? feedUrl(endpoint, { sort, page: alsoPage, filter, tier: "also", scopeParams })
      : null;
  const also = usePagedFetch(alsoUrl);

  // ---- Load more (flag on) -------------------------------------------------
  const listKey = `${endpoint}|${sort}|${filter}|${relevanceTiers ? showTier : "-"}|${scopeKey}`;
  // Whether the current list's first chunk took the #326 also-fallback, so its
  // later chunks keep asking for every tier.
  const prevMerged = useRef(false);
  const fetchChunk = useCallback(
    async (page: number, limit: number, prev: FeedResponse | null) => {
      const base = { sort, page, limit, filter, scopeParams };
      if (!relevanceTiers || showTier === "all") {
        return { data: await fetchFeed(feedUrl(endpoint, base)), merged: false };
      }
      // Strongly only. #326: when the strongly tier is empty but the also tier
      // is not, show the also rows (= every row) instead of a blank feed.
      if (prev) {
        const merged = prevMerged.current;
        return {
          data: await fetchFeed(
            feedUrl(endpoint, merged ? base : { ...base, tier: "strongly" }),
          ),
          merged,
        };
      }
      const strongly = await fetchFeed(feedUrl(endpoint, { ...base, tier: "strongly" }));
      const t = strongly.tierTotals;
      if (t && t.strongly === 0 && t.also > 0) {
        return { data: await fetchFeed(feedUrl(endpoint, base)), merged: true };
      }
      return { data: strongly, merged: false };
    },
    // scopeParams is captured through scopeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, sort, filter, relevanceTiers, showTier, scopeKey],
  );
  const list = useLoadMoreList({ enabled: loadMore, key: listKey, fetchChunk, prevMerged });

  // ---- derived view --------------------------------------------------------
  const data = loadMore ? list.data : primary.data;
  const tierTotals = data?.tierTotals ?? null;
  const parentTierTotals = data?.parentTierTotals ?? null;
  const alsoInline = loadMore ? list.merged : pagedAlsoInline;
  const showTierSelect =
    relevanceTiers &&
    parentTierTotals !== null &&
    parentTierTotals.also > 0 &&
    tierTotals !== null &&
    tierTotals.strongly > 0;

  let countLabel: string | null = null;
  if (data) {
    if (formatCount) {
      countLabel = formatCount(data, filter);
    } else if (relevanceTiers) {
      // One count definition (phase 4): DISTINCT pmids across every relevance
      // tier under the active type filter, whatever Show says — the same
      // number as the rail row (`getSubtopicRail`). Not strongly + also:
      // `score` is per (pmid, cwid, topic), so a paper whose co-authors' rows
      // straddle the threshold is in BOTH tier counts. The Show options keep
      // their per-tier counts; the Load more denominator is the current Show
      // option's count (`total`).
      countLabel = (
        filter === "all" ? data.totalAllTypes : data.totalResearchOnly
      ).toLocaleString();
    } else {
      countLabel = data.total.toLocaleString();
    }
  }

  const rowProps = { modalTopicSlug, entityTerm, areaLabelFor };

  return (
    <section className="flex flex-col gap-4">
      <PublicationsHeadingRow
        countLabel={countLabel}
        badge={isCuratedSort ? <CuratedTag surface="publication_centric" /> : null}
      >
        {showTierSelect && tierTotals && (
          <div className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
            Show
            <Select value={showTier} onValueChange={(v) => setShowTier(v as ShowTier)}>
              <SelectTrigger className="w-[200px]" aria-label="Show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strongly">
                  Strongly relevant ({tierTotals.strongly.toLocaleString()})
                </SelectItem>
                <SelectItem value="all">
                  All relevant ({(tierTotals.strongly + tierTotals.also).toLocaleString()})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
          Sort by
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
      </PublicationsHeadingRow>

      {headerSlot}

      <FilterToggleRow data={data} filter={filter} setFilter={setFilter} />

      {loadMore ? (
        <LoadMoreSection list={list} emptyBody={emptyBody} rowProps={rowProps} />
      ) : (
        <>
          {!pagedAlsoInline && (
            <PagedSection
              loading={primary.loading}
              error={primary.error}
              data={primary.data}
              page={stronglyPage}
              onPageChange={setStronglyPage}
              emptyBody={emptyBody}
              emptyState
              rowProps={rowProps}
            />
          )}
          {relevanceTiers && (showTier === "all" || alsoInline) && (
            <div className={alsoInline ? "" : "mt-2 border-t border-border pt-4"}>
              {!alsoInline && <h4 className="mb-3 text-base font-semibold">Also relevant</h4>}
              <PagedSection
                loading={also.loading}
                error={also.error}
                data={also.data}
                page={alsoPage}
                onPageChange={setAlsoPage}
                emptyBody={emptyBody}
                emptyState={alsoInline}
                rowProps={rowProps}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** One page per URL; `null` disables (keeping the last data, not loading). */
function usePagedFetch(url: string | null): {
  data: FeedResponse | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (url === null) {
      // Keep stale data so toggling a tier off-then-on doesn't flash empty.
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFeed(url)
      .then((j) => {
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
  }, [url]);

  return { data, loading, error };
}

type LoadMoreList = {
  rows: FeedHit[];
  data: FeedResponse | null;
  /** Rows requested so far (a multiple of the chunk): the next offset. */
  loaded: number;
  /** The first chunk came from the #326 also-fallback (one merged list). */
  merged: boolean;
  loading: boolean;
  error: string | null;
  /** pmid of the first row of the last appended chunk (focus target). */
  focusPmid: string | null;
  announcement: string;
  loadMore: () => void;
};

type ChunkFetcher = (
  page: number,
  limit: number,
  prev: FeedResponse | null,
) => Promise<{ data: FeedResponse; merged: boolean }>;

/**
 * Load-more list state. The first load of the FIRST key honors `?shown=N`
 * (one request with `limit=N`); every later key change (rail item, Show, Sort,
 * type toggle) starts again at one chunk and drops `?shown=` from the URL.
 */
function useLoadMoreList({
  enabled,
  key,
  fetchChunk,
  prevMerged,
}: {
  enabled: boolean;
  key: string;
  fetchChunk: ChunkFetcher;
  prevMerged: { current: boolean };
}): LoadMoreList {
  const [state, setState] = useState<Omit<LoadMoreList, "loadMore">>({
    rows: [],
    data: null,
    loaded: 0,
    merged: false,
    loading: enabled,
    error: null,
    focusPmid: null,
    announcement: "",
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const fetchRef = useRef(fetchChunk);
  fetchRef.current = fetchChunk;
  // The mount key restores `?shown=`; once the key has changed, never again.
  // (Keyed on the value, not on "first effect run", so a StrictMode re-run of
  // the mount effect still restores.)
  const initialKeyRef = useRef<string | null>(null);
  const keyChangedRef = useRef(false);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (initialKeyRef.current === null) initialKeyRef.current = key;
    if (key !== initialKeyRef.current) keyChangedRef.current = true;
    const initial = !keyChangedRef.current;
    const restore = initial ? readShownParam(window.location.search) : null;
    // Initial load: normalise the URL to what is actually restored (a crafted
    // ?shown=999 / 35 / abc reads back as 200 / 40 / nothing). Later keys:
    // a filter change starts over at one chunk.
    writeShownParam(initial ? restore : null);
    const limit = restore ?? FEED_CHUNK;
    const id = ++reqRef.current;
    setState((s) => ({ ...s, loading: true, error: null, focusPmid: null }));
    fetchRef
      .current(1, limit, null)
      .then(({ data, merged }) => {
        if (id !== reqRef.current) return;
        prevMerged.current = merged;
        setState({
          rows: data.hits,
          data,
          loaded: limit,
          merged,
          loading: false,
          error: null,
          focusPmid: null,
          announcement: "",
        });
      })
      .catch((err: unknown) => {
        if (id !== reqRef.current) return;
        setState((s) => ({ ...s, loading: false, error: String(err) }));
      });
  }, [enabled, key, prevMerged]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (s.loading || !s.data) return;
    const page = s.loaded / FEED_CHUNK + 1;
    const id = ++reqRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchRef
      .current(page, FEED_CHUNK, s.data)
      .then(({ data }) => {
        if (id !== reqRef.current) return;
        const seen = new Set(s.rows.map((r) => r.pmid));
        const added = data.hits.filter((h) => !seen.has(h.pmid));
        const rows = [...s.rows, ...added];
        const loaded = s.loaded + FEED_CHUNK;
        writeShownParam(loaded);
        setState({
          rows,
          data,
          loaded,
          merged: s.merged,
          loading: false,
          error: null,
          focusPmid: added[0]?.pmid ?? null,
          announcement: `Showing ${rows.length.toLocaleString()} of ${data.total.toLocaleString()} publications`,
        });
      })
      .catch((err: unknown) => {
        if (id !== reqRef.current) return;
        setState((prev) => ({ ...prev, loading: false, error: String(err) }));
      });
  }, []);

  return { ...state, loadMore };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type RowProps = {
  modalTopicSlug?: string;
  entityTerm: string | null;
  areaLabelFor?: (hit: FeedHit) => string | null;
};

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 w-full rounded-lg" />
      ))}
    </div>
  );
}

function FeedError() {
  return (
    <div className="text-sm text-muted-foreground">
      Could not load publications. Try refreshing.
    </div>
  );
}

function FeedEmpty({ body }: { body: string }) {
  return (
    <div className="py-8 text-center">
      <h3 className="text-base font-semibold">No publications found</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function PagedSection({
  loading,
  error,
  data,
  page,
  onPageChange,
  emptyBody,
  emptyState,
  rowProps,
}: {
  loading: boolean;
  error: string | null;
  data: FeedResponse | null;
  page: number;
  onPageChange: (p: number) => void;
  emptyBody: string;
  /** false ⇒ render nothing when empty (the also tier inside the toggle). */
  emptyState: boolean;
  rowProps: RowProps;
}) {
  // #294 — skeleton only on first load; keep prior rows during refetches.
  if (loading && data === null) return <FeedSkeleton />;
  if (error) return <FeedError />;
  if (!data || data.total === 0) {
    return emptyState ? <FeedEmpty body={emptyBody} /> : null;
  }
  return (
    <>
      <ul className="divide-y divide-border">
        {data.hits.map((h) => (
          <PubRow key={h.pmid} hit={h} {...rowProps} />
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

function LoadMoreSection({
  list,
  emptyBody,
  rowProps,
}: {
  list: LoadMoreList;
  emptyBody: string;
  rowProps: RowProps;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // Keyboard users continue in place: focus the first newly loaded row.
  useLayoutEffect(() => {
    if (!list.focusPmid) return;
    const items = listRef.current?.querySelectorAll<HTMLElement>("li[data-pmid]") ?? [];
    for (const el of items) {
      if (el.dataset.pmid === list.focusPmid) {
        el.focus();
        break;
      }
    }
  }, [list.focusPmid]);

  const { data, rows } = list;
  let body: ReactNode;
  if (list.loading && data === null) body = <FeedSkeleton />;
  else if (list.error && data === null) body = <FeedError />;
  else if (!data || (data.total === 0 && rows.length === 0)) body = <FeedEmpty body={emptyBody} />;
  else {
    const total = data.total;
    const next = nextChunkSize(list.loaded, total);
    body = (
      <>
        <ul ref={listRef} className="divide-y divide-border">
          {rows.map((h) => (
            <PubRow key={h.pmid} hit={h} focusable {...rowProps} />
          ))}
        </ul>
        {list.error && <FeedError />}
        {next > 0 && (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={list.loadMore}
              disabled={list.loading}
              aria-busy={list.loading || undefined}
              className="max-sm:min-h-11 max-sm:w-full"
              data-testid="feed-load-more"
            >
              {list.loading ? "Loading…" : loadMoreLabel(list.loaded, rows.length, total)}
            </Button>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {body}
      <div aria-live="polite" role="status" className="sr-only" data-testid="feed-announcement">
        {list.announcement}
      </div>
    </>
  );
}

/**
 * The "Show all publication types / Hide non-research" toggle (#30). The count
 * lives in the "Publications N" row; this row only holds the toggle.
 */
function FilterToggleRow({
  data,
  filter,
  setFilter,
}: {
  data: FeedResponse | null;
  filter: Filter;
  setFilter: (f: Filter) => void;
}) {
  if (!data || (data.total === 0 && (data.tierTotals?.also ?? 0) === 0)) return null;
  const { totalAllTypes, totalResearchOnly } = data;
  const hasDelta = totalAllTypes > totalResearchOnly;
  if (!hasDelta) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
      {filter === "research_articles_only" ? (
        <button
          type="button"
          onClick={() => setFilter("all")}
          className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          Show all publication types ({(totalAllTypes - totalResearchOnly).toLocaleString()} more) →
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setFilter("research_articles_only")}
          className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          Hide non-research types →
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export function PubRow({
  hit,
  modalTopicSlug,
  entityTerm = null,
  areaLabelFor,
  focusable = false,
}: {
  hit: FeedHit;
  modalTopicSlug?: string;
  entityTerm?: string | null;
  areaLabelFor?: (hit: FeedHit) => string | null;
  /** Load more: rows take programmatic focus (tabIndex -1). */
  focusable?: boolean;
}) {
  const { open: openModal } = usePublicationModal();
  const titleHtml = sanitizePubTitle(hit.title);
  const [usagesExpanded, setUsagesExpanded] = useState(false);
  const usages = hit.entityUsages ?? [];
  const shownUsages = usagesExpanded ? usages : usages.slice(0, 1);
  const moreCount = usages.length - 1;
  const areaLabel = areaLabelFor ? areaLabelFor(hit) : null;
  return (
    <li
      className={focusable ? "py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring" : "py-4"}
      {...(focusable ? { tabIndex: -1, "data-pmid": hit.pmid } : {})}
    >
      <div className="line-clamp-2 font-semibold leading-snug">
        <button
          type="button"
          onClick={() =>
            modalTopicSlug !== undefined
              ? openModal(hit.pmid, { currentTopicSlug: modalTopicSlug })
              : openModal(hit.pmid)
          }
          aria-haspopup="dialog"
          {...pubTitleProps(titleHtml, "text-left hover:underline")}
        />
      </div>
      {/* Kept as `journal || year` (not a boolean) for parity: a row with no
          journal and year 0 has always rendered a stray "0" here. */}
      {(areaLabel ? true : hit.journal || hit.year) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {hit.journal && (
            <span
              className="italic"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(hit.journal) }}
            />
          )}
          {hit.journal && hit.year ? <span aria-hidden="true">·</span> : null}
          {hit.year ? <span>{hit.year}</span> : null}
          {areaLabel ? (
            <>
              {hit.journal || hit.year ? <span aria-hidden="true">·</span> : null}
              <span data-testid="pub-area-label">{areaLabel}</span>
            </>
          ) : null}
        </div>
      )}
      {/* #327 — the paper's argmax topic when it is ANOTHER topic (the server
          drops the self-reference), on its own line so it reads as a
          cross-listing, not as journal metadata. Topic hits only. */}
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
        impactJustification={hit.impactJustification ?? null}
        pmid={hit.pmid}
        pmcid={hit.pmcid}
        doi={hit.doi}
        lazyAbstract={hit.hasAbstract === true}
      />
      {/* #1166/#1166-B — per-(pub × entity) usage sentences on an entity-filtered
          family feed, the entity term <mark>-highlighted (offset-aware, term
          match when the span is null). Best first inline; the rest under
          "+ N more usages". */}
      {usages.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {shownUsages.map((u, i) => (
            <p
              key={i}
              className="border-l-2 border-[var(--color-border-info)] pl-2.5 text-[13px] leading-relaxed text-muted-foreground"
            >
              {/* #1168 — "Where it appears" for a generic mention, else "How it was used". */}
              <SnippetUsageBadge usage={u.usage} />
              {highlightSnippet(u.sentence, entityTerm ?? "", u.matchedSpan)}
            </p>
          ))}
          {moreCount > 0 && (
            <button
              type="button"
              onClick={() => setUsagesExpanded((v) => !v)}
              aria-expanded={usagesExpanded}
              className="pl-2.5 text-xs font-medium text-[var(--color-accent-slate)] hover:underline"
            >
              {usagesExpanded
                ? "Show fewer"
                : `+ ${moreCount} more usage${moreCount === 1 ? "" : "s"}`}
              <span aria-hidden="true">{usagesExpanded ? " ▴" : " ▾"}</span>
            </button>
          )}
        </div>
      )}
    </li>
  );
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
    for (let i = Math.max(2, page - 2); i <= Math.min(totalPages - 1, page + 2); i++) {
      window.push(i);
    }
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
              <PaginationLink onClick={() => onPageChange(p)} isActive={p === page}>
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

// ---------------------------------------------------------------------------
// Page adapters
// ---------------------------------------------------------------------------

/** Topic page feed: relevance tiers, topic-aware modal, "Best fit" rows. */
export function TopicPublicationFeed({
  topicSlug,
  activeSubtopic,
  loadMore = false,
  subtopicLabels,
}: {
  topicSlug: string;
  /** The subtopic title/description live in the rail layout's subhead. */
  activeSubtopic: string | null;
  /** TAXONOMY_FEED_LOAD_MORE. */
  loadMore?: boolean;
  /** TAXONOMY_FEED_LOAD_MORE — subtopic id → display name for the per-row
   *  area label, shown only when no subarea is selected. */
  subtopicLabels?: Record<string, string>;
}) {
  const areaLabelFor = useMemo(() => {
    if (!loadMore || activeSubtopic || !subtopicLabels) return undefined;
    return (hit: FeedHit) =>
      hit.primarySubtopicId ? (subtopicLabels[hit.primarySubtopicId] ?? null) : null;
  }, [loadMore, activeSubtopic, subtopicLabels]);
  return (
    <PublicationFeed
      endpoint={`/api/topics/${encodeURIComponent(topicSlug)}/publications`}
      scopeParams={[["subtopic", activeSubtopic]]}
      relevanceTiers
      modalTopicSlug={topicSlug}
      emptyBody="Publications in this area will appear as they are indexed."
      loadMore={loadMore}
      areaLabelFor={areaLabelFor}
    />
  );
}

/**
 * Method family feed (family page + a selected family on the category page):
 * no tiers (no `displayThreshold` analog at family grain, §OQ-3b), the
 * URL-addressable `?entity=` filter (#1166) with its context chip and usage
 * snippets. The modal opens WITHOUT a topic slug (a method surface).
 */
export function FamilyPublicationFeed({
  supercategorySlug,
  familySegment,
  familyLabel,
  cellLineLabels,
  loadMore = false,
}: {
  /** The supercategory URL slug segment (path part 1). */
  supercategorySlug: string;
  /** The family URL segment (`${labelSlug}-fam_NNNN`, path part 2). */
  familySegment: string;
  /** Resolved family label (empty-state copy). */
  familyLabel: string;
  /** #1166 — entity id → display label; unknown id ⇒ no cell-line filter UI. */
  cellLineLabels?: Record<string, string>;
  /** TAXONOMY_FEED_LOAD_MORE. */
  loadMore?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // #1166 — honored only when its label is known (entity in this family + flag on).
  const cellLineId = searchParams.get("entity");
  const cellLine = cellLineId && cellLineLabels?.[cellLineId] ? cellLineId : null;
  const cellLineLabel = cellLine ? cellLineLabels![cellLine] : null;

  const clearCellLine = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("entity");
    params.delete("page");
    params.delete("shown");
    router.replace(params.toString() ? `${pathname}?${params.toString()}` : pathname, {
      scroll: false,
    });
  };

  return (
    <PublicationFeed
      endpoint={`/api/methods/${encodeURIComponent(supercategorySlug)}/${encodeURIComponent(
        familySegment,
      )}/publications`}
      scopeParams={[["entity", cellLine]]}
      entityTerm={cellLineLabel}
      // "N of M articles" while an entity filter is on; M is the family total
      // for the active type filter.
      formatCount={(data, filter) => {
        if (!cellLine) return data.total.toLocaleString();
        const denom = filter === "all" ? data.totalAllTypes : data.totalResearchOnly;
        return `${data.total.toLocaleString()} of ${denom.toLocaleString()} articles`;
      }}
      emptyBody={`Publications using ${familyLabel} will appear as they are indexed.`}
      loadMore={loadMore}
      headerSlot={
        cellLine && cellLineLabel ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Filtered to</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-background-info)] px-2.5 py-0.5 text-xs text-[var(--color-text-info)]">
              {cellLineLabel}
              <button
                type="button"
                onClick={clearCellLine}
                aria-label={`Clear ${cellLineLabel} filter`}
                className="hover:opacity-70"
              >
                ✕
              </button>
            </span>
            <button
              type="button"
              onClick={clearCellLine}
              className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
            >
              Clear · view all articles
            </button>
          </div>
        ) : null
      }
    />
  );
}

/**
 * TAXONOMY_FEED_LOAD_MORE — the method category page's "All families" feed:
 * every family's gated pmids as one sortable, load-more list, each row labeled
 * with its family (`familyLabel`, chosen server-side).
 */
export function CategoryPublicationFeed({ supercategorySlug }: { supercategorySlug: string }) {
  return (
    <PublicationFeed
      endpoint={`/api/methods/${encodeURIComponent(supercategorySlug)}/all/publications`}
      emptyBody="Publications in this category will appear as they are indexed."
      loadMore
      areaLabelFor={categoryAreaLabel}
    />
  );
}

function categoryAreaLabel(hit: FeedHit): string | null {
  return hit.familyLabel ?? null;
}
