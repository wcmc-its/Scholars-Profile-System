"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";
import { PublicationCard } from "@/components/department/publication-card";
import type { DeptPublicationCard } from "@/lib/api/dept-highlights";
import type { PubSort } from "@/lib/api/dept-lists";
import {
  TRANSLATIONAL_STAGES,
  translationalStageDisplay,
  type TranslationalStage,
} from "@/lib/translational-stage";

type DeptPublicationsListProps = {
  hits: DeptPublicationCard[];
  total: number;
  page: number;
  pageSize: number;
  sort: PubSort;
  /** SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET — show the Stage select. */
  stageFilter?: boolean;
  /** The picked stage (`?stage=`); null for all stages. */
  stage?: TranslationalStage | null;
  basePath: string;
  /**
   * Path that paging and sort links stay on. Defaults to `basePath`; the
   * research-area view passes `{basePath}/areas/{topic}` so they keep the
   * area filter.
   */
  listBasePath?: string;
  /** Research-area filter in effect: a removable chip linking to `clearHref`. */
  activeArea?: { label: string; clearHref: string } | null;
};

export function DeptPublicationsList(props: DeptPublicationsListProps) {
  // useSearchParams() forces a CSR bailout during prerender (Next.js 15
  // strict mode). Suspense lets the static build emit the fallback.
  return (
    <Suspense fallback={null}>
      <DeptPublicationsListInner {...props} />
    </Suspense>
  );
}

function DeptPublicationsListInner({
  hits,
  total,
  page,
  pageSize,
  sort,
  stageFilter = false,
  stage = null,
  basePath,
  listBasePath,
  activeArea = null,
}: DeptPublicationsListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const listPath = listBasePath ?? basePath;

  function setSort(next: PubSort) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("tab", "publications");
    params.set("sort", next);
    params.delete("page");
    router.push(`${listPath}?${params.toString()}`, { scroll: false });
  }

  function setStage(next: TranslationalStage | "all") {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("tab", "publications");
    if (next === "all") params.delete("stage");
    else params.set("stage", next);
    params.delete("page");
    router.push(`${listPath}?${params.toString()}`, { scroll: false });
  }

  function buildHref(p: number): string {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("tab", "publications");
    if (sort) params.set("sort", sort);
    if (p === 1) params.delete("page");
    else params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${listPath}?${qs}` : listPath;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const areaChip = activeArea && (
    <div className="mb-4 flex">
      <a
        href={activeArea.clearHref}
        aria-label={`Remove research area filter: ${activeArea.label}`}
        className="border-apollo-slate text-apollo-slate bg-apollo-slate-tint hover:bg-apollo-slate-tint inline-flex min-h-[26px] max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] leading-tight no-underline hover:no-underline"
      >
        Research area: {activeArea.label}
        <span aria-hidden="true">×</span>
      </a>
    </div>
  );

  const stageSelect = stageFilter ? (
    <Select value={stage ?? "all"} onValueChange={(v) => setStage(v as TranslationalStage | "all")}>
      <SelectTrigger aria-label="Translational stage" className="h-8 w-[240px] text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All stages</SelectItem>
        {TRANSLATIONAL_STAGES.map((st) => (
          <SelectItem key={st} value={st}>
            {translationalStageDisplay(st)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : null;

  if (total === 0) {
    return (
      <>
        {areaChip}
        {/* A picked stage with no papers keeps the select, so it can be undone. */}
        {stage && stageSelect ? <div className="mb-4 flex justify-end">{stageSelect}</div> : null}
        <div className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {stage ? "No publications at this stage." : "No publications listed."}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {areaChip}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-sm text-muted-foreground">
          Showing {start.toLocaleString()}&ndash;{end.toLocaleString()} of{" "}
          {total.toLocaleString()} publications
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {stageSelect}
          <Select value={sort} onValueChange={(v) => setSort(v as PubSort)}>
            <SelectTrigger aria-label="Sort by" className="h-8 w-[180px] text-sm">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="most_cited">Most cited</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <ul className="flex flex-col divide-y divide-[var(--color-border)]">
        {hits.map((p) => (
          <li key={p.pmid} className="py-4">
            <PublicationCard pub={p} />
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-8">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href={buildHref(Math.max(1, page - 1))}
                  aria-disabled={page <= 1}
                />
              </PaginationItem>
              {(() => {
                const pages: (number | "ellipsis")[] = [];
                if (totalPages <= 6) {
                  for (let i = 1; i <= totalPages; i++) pages.push(i);
                } else {
                  const win: number[] = [];
                  for (
                    let i = Math.max(2, page - 2);
                    i <= Math.min(totalPages - 1, page + 2);
                    i++
                  )
                    win.push(i);
                  pages.push(1);
                  if (win[0] > 2) pages.push("ellipsis");
                  win.forEach((p) => pages.push(p));
                  if (win[win.length - 1] < totalPages - 1)
                    pages.push("ellipsis");
                  pages.push(totalPages);
                }
                return pages.map((p, i) =>
                  p === "ellipsis" ? (
                    <PaginationItem key={`e${i}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={p}>
                      <PaginationLink href={buildHref(p)} isActive={p === page}>
                        {p}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                );
              })()}
              <PaginationItem>
                <PaginationNext
                  href={buildHref(Math.min(totalPages, page + 1))}
                  aria-disabled={page >= totalPages}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </>
  );
}
