"use client";

/**
 * Cross-scholar Method (family) page publication feed — the family-grain analog
 * of `components/topic/publication-feed.tsx`, deliberately slimmed:
 *
 *   - SINGLE untiered list. The family taxonomy has no `Topic.displayThreshold`
 *     analog (§OQ-3b), so there is no strongly/also tier split, no "Show" scope
 *     select, and no `tierTotals`/`parentTierTotals` plumbing.
 *   - No per-row `Impact: NN` justification tooltip and no "Best fit" cross-topic
 *     line (`MethodPublicationHit` carries neither) — those are topic-only.
 *
 * Shared sort + publication-type filter toolbar, paginated. Reuses the author
 * chip row + publication meta + publication modal verbatim. The modal is opened
 * WITHOUT a `currentTopicSlug` (this is a method surface, not a topic surface).
 */
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
  impactScore: number | null;
  abstract: string | null;
  authors: Array<{
    name: string;
    cwid: string;
    slug: string;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
  }>;
};

type FeedResponse = {
  hits: Hit[];
  total: number;
  totalAllTypes: number;
  totalResearchOnly: number;
  page: number;
  pageSize: number;
};

export function FamilyPublicationFeed({
  supercategorySlug,
  familySegment,
  familyLabel,
}: {
  /** The supercategory URL slug segment (path part 1). */
  supercategorySlug: string;
  /** The family URL segment (`${labelSlug}-fam_NNNN`, path part 2). */
  familySegment: string;
  /** Resolved family label, used for the feed heading. */
  familyLabel: string;
}) {
  const [sort, setSort] = useState<Sort>("newest");
  const [filter, setFilter] = useState<Filter>("research_articles_only");
  const [page, setPage] = useState(1);

  const isCuratedSort = sort === "by_impact";
  const heading =
    filter === "research_articles_only"
      ? "Research articles using this method"
      : "All publications using this method";

  // Reset pagination on sort / filter change.
  useEffect(() => {
    setPage(1);
  }, [sort, filter]);

  const { data, loading, error } = useFeedFetch({
    supercategorySlug,
    familySegment,
    sort,
    filter,
    page,
  });

  const sortRowLabel = data ? `${data.total.toLocaleString()} results` : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span>{heading}</span>
            {isCuratedSort && <CuratedTag surface="publication_centric" />}
          </h2>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
        data={data}
        filter={filter}
        setFilter={setFilter}
        sortRowLabel={sortRowLabel}
      />

      <FeedSection
        loading={loading}
        error={error}
        data={data}
        page={page}
        onPageChange={setPage}
        familyLabel={familyLabel}
      />
    </section>
  );
}

/**
 * The "Show all publication types / Hide non-research" filter toggle (#30),
 * mirroring the topic feed's row but without the tier coupling.
 */
function FilterToggleRow({
  data,
  filter,
  setFilter,
  sortRowLabel,
}: {
  data: FeedResponse | null;
  filter: Filter;
  setFilter: (f: Filter) => void;
  sortRowLabel: string | null;
}) {
  if (!data || data.total === 0) return null;
  const { totalAllTypes, totalResearchOnly } = data;
  const hasDelta = totalAllTypes > totalResearchOnly;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>{sortRowLabel ?? ""}</span>
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

function FeedSection({
  loading,
  error,
  data,
  page,
  onPageChange,
  familyLabel,
}: {
  loading: boolean;
  error: string | null;
  data: FeedResponse | null;
  page: number;
  onPageChange: (p: number) => void;
  familyLabel: string;
}) {
  // Skeleton only on first load (no data yet); keep prior rows visible during
  // sort / filter / page refetches (stale-while-revalidate).
  if (loading && data === null) {
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
    return (
      <div className="py-8 text-center">
        <h3 className="text-base font-semibold">No publications found</h3>
        <p className="text-sm text-muted-foreground">
          Publications using {familyLabel} will appear as they are indexed.
        </p>
      </div>
    );
  }
  return (
    <>
      <ul className="divide-y divide-border">
        {data.hits.map((h) => (
          <PubRow key={h.pmid} hit={h} />
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

function PubRow({ hit }: { hit: Hit }) {
  const { open: openModal } = usePublicationModal();
  const titleHtml = sanitizePubTitle(hit.title);
  return (
    <li className="py-4">
      <div className="line-clamp-2 font-semibold leading-snug">
        <button
          type="button"
          onClick={() => openModal(hit.pmid)}
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
      <AuthorChipRow authors={hit.authors} pmid={hit.pmid} />
      <PublicationMeta
        citationCount={hit.citationCount}
        impactScore={hit.impactScore}
        impactJustification={null}
        pmid={hit.pmid}
        pmcid={hit.pmcid}
        doi={hit.doi}
        abstract={hit.abstract}
      />
    </li>
  );
}

function useFeedFetch({
  supercategorySlug,
  familySegment,
  sort,
  filter,
  page,
}: {
  supercategorySlug: string;
  familySegment: string;
  sort: Sort;
  filter: Filter;
  page: number;
}): { data: FeedResponse | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const url = new URL(
      `/api/methods/${encodeURIComponent(supercategorySlug)}/${encodeURIComponent(
        familySegment,
      )}/publications`,
      window.location.origin,
    );
    url.searchParams.set("sort", sort);
    url.searchParams.set("page", String(page));
    url.searchParams.set("filter", filter);

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
  }, [supercategorySlug, familySegment, sort, filter, page]);

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
