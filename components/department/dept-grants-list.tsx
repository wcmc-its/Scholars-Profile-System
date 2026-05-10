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
import { GrantCard } from "@/components/department/grant-card";
import type { DeptGrantCard } from "@/lib/api/dept-highlights";
import type { GrantSort } from "@/lib/api/dept-lists";

type DeptGrantsListProps = {
  hits: DeptGrantCard[];
  total: number;
  page: number;
  pageSize: number;
  sort: GrantSort;
  basePath: string;
};

export function DeptGrantsList(props: DeptGrantsListProps) {
  // useSearchParams() forces a CSR bailout during prerender (Next.js 15
  // strict mode). Suspense lets the static build emit the fallback.
  return (
    <Suspense fallback={null}>
      <DeptGrantsListInner {...props} />
    </Suspense>
  );
}

function DeptGrantsListInner({
  hits,
  total,
  page,
  pageSize,
  sort,
  basePath,
}: DeptGrantsListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSort(next: GrantSort) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("tab", "grants");
    params.set("sort", next);
    params.delete("page");
    router.push(`${basePath}?${params.toString()}`);
  }

  function buildHref(p: number): string {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("tab", "grants");
    if (sort) params.set("sort", sort);
    if (p === 1) params.delete("page");
    else params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  if (total === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-muted-foreground">No active grants listed.</p>
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">
          Showing {start.toLocaleString()}&ndash;{end.toLocaleString()} of{" "}
          {total.toLocaleString()} active grants
        </span>
        <Select value={sort} onValueChange={(v) => setSort(v as GrantSort)}>
          <SelectTrigger className="h-8 w-[180px] text-sm">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="most_recent">Most recent</SelectItem>
            <SelectItem value="end_date">End date</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ul className="flex flex-col divide-y divide-[var(--color-border)]">
        {hits.map((g, i) => (
          <li key={g.externalId ?? `g-${i}`} className="py-4">
            <GrantCard grant={g} />
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
