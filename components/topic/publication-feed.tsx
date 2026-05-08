"use client";

import { useEffect, useState } from "react";
import { AuthorChipRow } from "@/components/publication/author-chip-row";
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

type Sort = "newest" | "most_cited" | "by_impact" | "curated";
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

export function PublicationFeed({
  topicSlug,
  activeSubtopic,
  subtopicLabel,
  subtopicShortDescription,
}: {
  topicSlug: string;
  activeSubtopic: string | null;
  subtopicLabel: string | null;
  subtopicShortDescription: string | null;
}) {
  const [sort, setSort] = useState<Sort>("newest");
  const [filter, setFilter] = useState<Filter>("research_articles_only");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isCuratedSort = sort === "by_impact" || sort === "curated";
  const heading =
    activeSubtopic && subtopicLabel ? subtopicLabel : "All publications in this area";

  // Reset to page 1 on sort/subtopic/filter change.
  useEffect(() => {
    setPage(1);
  }, [sort, activeSubtopic, filter]);

  useEffect(() => {
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
  }, [topicSlug, sort, activeSubtopic, page, filter]);

  const showSubtopicSubtitle =
    activeSubtopic !== null && subtopicShortDescription !== null && subtopicShortDescription.trim() !== "";

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span>{heading}</span>
            {isCuratedSort && <CuratedTag surface="publication_centric" />}
          </h2>
          {showSubtopicSubtitle && (
            <p className="text-sm text-muted-foreground">{subtopicShortDescription}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort by</span>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="most_cited">Most cited</SelectItem>
              <SelectItem value="by_impact">By impact (ReCiterAI)</SelectItem>
              <SelectItem value="curated">Curated by ReCiterAI</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      {loading ? (
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <div className="text-sm text-muted-foreground">
          Could not load publications. Try refreshing.
        </div>
      ) : !data || data.total === 0 ? (
        <div className="py-8 text-center">
          <h3 className="text-base font-semibold">No publications found</h3>
          <p className="text-sm text-muted-foreground">
            Publications in this area will appear as they are indexed.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>{data.total.toLocaleString()} results</span>
            {filter === "research_articles_only" && data.totalAllTypes > data.totalResearchOnly ? (
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
              >
                Show all publication types ({(data.totalAllTypes - data.totalResearchOnly).toLocaleString()} more) →
              </button>
            ) : filter === "all" && data.totalAllTypes > data.totalResearchOnly ? (
              <button
                type="button"
                onClick={() => setFilter("research_articles_only")}
                className="text-xs text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
              >
                Hide non-research types →
              </button>
            ) : null}
          </div>
          <ul className="divide-y divide-border">
            {data.hits.map((h) => (
              <li key={h.pmid} className="py-4">
                <div className="line-clamp-2 font-semibold leading-snug">
                  {h.pubmedUrl ? (
                    <a
                      href={h.pubmedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {h.title}
                    </a>
                  ) : (
                    h.title
                  )}
                </div>
                <AuthorChipRow authors={h.authors} />
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  {h.journal && <span className="italic">{h.journal}</span>}
                  {h.year ? <span>· {h.year}</span> : null}
                  {h.citationCount !== null && h.citationCount > 0 && (
                    <span className="font-medium text-[var(--color-accent-slate)]">
                      · {h.citationCount.toLocaleString()} citations
                    </span>
                  )}
                  {h.doi && (
                    <a
                      href={`https://doi.org/${h.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      · DOI
                    </a>
                  )}
                  {h.pubmedUrl && (
                    <a
                      href={h.pubmedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      · PubMed
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <PaginationRow
            total={data.total}
            pageSize={data.pageSize}
            page={page}
            onPageChange={setPage}
          />
        </>
      )}
    </section>
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
