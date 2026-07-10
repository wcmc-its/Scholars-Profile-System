"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RoleChipRow,
  filterByRoleCategory,
  type RoleCategory,
} from "@/components/department/role-chip-row";
import { PersonRow } from "@/components/department/person-row";
import {
  RosterFacet,
  type FacetOption,
} from "@/components/center/center-roster-facets";
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
import type { DepartmentFacultyHit } from "@/lib/api/departments";

export function DepartmentFacultyClient({
  faculty,
  total,
  roleCategoryCounts,
  page,
  pageSize,
  deptSlug,
  divisionSlug,
  methodFacet,
  unitKind,
  unitCode,
}: {
  faculty: DepartmentFacultyHit[];
  total: number;
  roleCategoryCounts: Record<string, number>;
  page: number;
  pageSize: number;
  deptSlug: string;
  divisionSlug: string | null;
  /** #974 Phase 2 — unit-wide PUBLIC method-family facet buckets. Renders the
   *  sidebar only when present + non-empty (flag on + data). */
  methodFacet?: FacetOption[];
  /** #974 Phase 2 — unit identity for the client-fetch filter route. */
  unitKind?: "department" | "division";
  unitCode?: string;
}) {
  const [activeCategory, setActiveCategory] = useState<RoleCategory>("All");
  const [sortOrder, setSortOrder] = useState<"name-asc" | "name-desc">("name-asc");

  // #974 Phase 2 — Methods facet selection (CLIENT state; values are sc::label
  // overlay keys). When non-empty, the rendered roster is the API's filtered page;
  // when empty, the SSR page-0 roster (`faculty`/`total`/`page`) renders unchanged.
  const [selMethods, setSelMethods] = useState<ReadonlySet<string>>(new Set());
  const [fetchPage, setFetchPage] = useState(1); // 1-based, like the SSR `page`
  const [filtered, setFiltered] = useState<{
    hits: DepartmentFacultyHit[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  // Distinct from an empty result: a failed method-filter fetch (network / 5xx)
  // must not read as "no scholars match" — the API returning [] and the request
  // dying are different facts. Drives a retryable error state in the body.
  const [error, setError] = useState(false);
  // Bumped by the Retry affordance to re-run the fetch effect after a failure
  // (same selection + page, so nothing else in the dep list changes).
  const [retryNonce, setRetryNonce] = useState(0);

  const hasFacet = Boolean(methodFacet && methodFacet.length > 0 && unitKind && unitCode);

  // Deep-link: read `?method=` on mount and seed the selection (the page HTML is
  // the cached unfiltered shell; the edge strips the param for the origin, so the
  // client reapplies the filter here). Only valid keys present in the facet count.
  useEffect(() => {
    if (!hasFacet) return;
    const params = new URLSearchParams(window.location.search);
    const valid = new Set(methodFacet!.map((o) => o.value));
    const seeded = params.getAll("method").filter((m) => valid.has(m));
    if (seeded.length > 0) {
      setSelMethods(new Set(seeded));
      // #991 — restore the shared `?page=` too, so a filtered+paged deep-link
      // (e.g. ?method=X&page=3) opens on the intended page rather than silently
      // loading page 1 (which the replaceState effect would then rewrite back).
      const pageParam = Number.parseInt(params.get("page") ?? "1", 10);
      if (Number.isFinite(pageParam) && pageParam > 1) setFetchPage(pageParam);
    }
    // mount-only; methodFacet/hasFacet are stable for a given render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the selection (+ page) in `?method=&page=` via replaceState — keeps
  // the URL shareable without a navigation (the page stays the cached shell).
  useEffect(() => {
    if (!hasFacet) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("method");
    params.delete("page");
    for (const v of selMethods) params.append("method", v);
    if (selMethods.size > 0) {
      // Filtered view paginates client-side via `fetchPage`.
      if (fetchPage > 1) params.set("page", String(fetchPage));
    } else if (page > 1) {
      // No method filter: reflect the SSR `page` prop, NOT whatever `?page=` is
      // already in the URL. This preserves a genuine unfiltered arrival at
      // `?page=3` while dropping a stale filtered `?page=N` when the user
      // deselects the last method (the unfiltered roster then renders SSR
      // `page`, so the address bar must agree with it).
      params.set("page", String(page));
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [selMethods, fetchPage, hasFacet, page]);

  // Fetch the filtered roster whenever the selection or page changes. No selection
  // → clear the filtered state so the SSR roster renders.
  useEffect(() => {
    if (!hasFacet) return;
    if (selMethods.size === 0) {
      setFiltered(null);
      setError(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    for (const v of selMethods) params.append("method", v);
    params.set("page", String(Math.max(0, fetchPage - 1)));
    fetch(`/api/units/${unitKind}/${unitCode}/members?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { hits: DepartmentFacultyHit[]; total: number }) => {
        setFiltered({ hits: data.hits, total: data.total });
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        // Keep the previous `filtered` (don't overwrite with an empty result —
        // that would render as "No scholars match these filters."). Surface a
        // retryable error instead.
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [selMethods, fetchPage, hasFacet, unitKind, unitCode, retryNonce]);

  const isFiltered = hasFacet && selMethods.size > 0;
  const baseHits = isFiltered ? (filtered?.hits ?? []) : faculty;
  const renderedTotal = isFiltered ? (filtered?.total ?? 0) : total;
  const currentPage = isFiltered ? fetchPage : page;

  // Role chip + sort apply over the CURRENTLY rendered set (page-only, as today).
  const visible = useMemo(() => {
    const base = filterByRoleCategory(baseHits, activeCategory);
    return sortOrder === "name-desc"
      ? [...base].sort((a, b) => b.preferredName.localeCompare(a.preferredName))
      : base;
  }, [baseHits, activeCategory, sortOrder]);

  const makeToggle = useCallback(
    (value: string) => {
      setSelMethods((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
      setFetchPage(1); // changing the selection resets to the first filtered page
    },
    [],
  );

  // Pagination URL builder — the unfiltered case navigates (cacheable links);
  // appends ?page= and preserves the division path.
  const buildHref = (p: number) => {
    const base = divisionSlug
      ? `/departments/${deptSlug}/divisions/${divisionSlug}`
      : `/departments/${deptSlug}`;
    return p === 1 ? base : `${base}?page=${p}`;
  };

  const totalPages = Math.max(1, Math.ceil(renderedTotal / pageSize));

  if (faculty.length === 0) {
    return (
      <div className="py-8 text-center">
        <h3 className="text-base font-semibold">No faculty listed</h3>
        <p className="text-sm text-muted-foreground">
          {divisionSlug
            ? "Faculty in this division will appear after the next ETL refresh."
            : "Faculty in this department will appear after the next ETL refresh."}
        </p>
      </div>
    );
  }

  const start = renderedTotal === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, renderedTotal);
  const scholarsLabel = renderedTotal === 1 ? "scholar" : "scholars";

  // The numbered-pagination control. In the filtered view, page links drive client
  // state (setFetchPage) instead of navigating; the unfiltered view keeps hrefs.
  const pagination = (
    <div className="mt-8">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              {...(isFiltered
                ? {
                    href: "#",
                    onClick: (e: React.MouseEvent) => {
                      e.preventDefault();
                      if (currentPage > 1) setFetchPage(currentPage - 1);
                    },
                  }
                : { href: buildHref(Math.max(1, page - 1)) })}
              aria-disabled={currentPage <= 1}
            />
          </PaginationItem>
          {(() => {
            const pages: (number | "ellipsis")[] = [];
            if (totalPages <= 6) {
              for (let i = 1; i <= totalPages; i++) pages.push(i);
            } else {
              const win: number[] = [];
              for (
                let i = Math.max(2, currentPage - 2);
                i <= Math.min(totalPages - 1, currentPage + 2);
                i++
              )
                win.push(i);
              pages.push(1);
              if (win[0] > 2) pages.push("ellipsis");
              win.forEach((p) => pages.push(p));
              if (win[win.length - 1] < totalPages - 1) pages.push("ellipsis");
              pages.push(totalPages);
            }
            return pages.map((p, i) =>
              p === "ellipsis" ? (
                <PaginationItem key={`e${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <PaginationLink
                    {...(isFiltered
                      ? {
                          href: "#",
                          onClick: (e: React.MouseEvent) => {
                            e.preventDefault();
                            setFetchPage(p);
                          },
                        }
                      : { href: buildHref(p) })}
                    isActive={p === currentPage}
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              ),
            );
          })()}
          <PaginationItem>
            <PaginationNext
              {...(isFiltered
                ? {
                    href: "#",
                    onClick: (e: React.MouseEvent) => {
                      e.preventDefault();
                      if (currentPage < totalPages) setFetchPage(currentPage + 1);
                    },
                  }
                : { href: buildHref(Math.min(totalPages, page + 1)) })}
              aria-disabled={currentPage >= totalPages}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );

  // Shared body: the count line, Role chip row, person rows, and pagination.
  const body = (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">
          {isFiltered && loading
            ? "Loading…"
            : `Showing ${start}–${end} of ${renderedTotal.toLocaleString()} ${scholarsLabel}`}
        </span>
        <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as typeof sortOrder)}>
          <SelectTrigger aria-label="Sort by" className="h-8 w-[160px] text-sm">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name-asc">Name A–Z</SelectItem>
            <SelectItem value="name-desc">Name Z–A</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mb-6">
        <RoleChipRow
          faculty={baseHits}
          roleCategoryCounts={isFiltered ? undefined : roleCategoryCounts}
          totalCount={isFiltered ? undefined : total}
          active={activeCategory}
          onChange={setActiveCategory}
        />
      </div>
      {isFiltered && error ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Couldn’t load matching scholars.{" "}
          <button
            type="button"
            onClick={() => {
              setError(false);
              setRetryNonce((n) => n + 1);
            }}
            className="underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </p>
      ) : isFiltered && loading && filtered === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No scholars match these filters.
        </p>
      ) : (
        <div className="flex flex-col">
          {visible.map((hit) => (
            <PersonRow key={hit.cwid} hit={hit} methodChips={hit.topMethods} />
          ))}
        </div>
      )}
      {totalPages > 1 && pagination}
    </>
  );

  // No facet (flag off or no families) → today's single-column layout, untouched.
  if (!hasFacet) {
    return body;
  }

  // Facet present → aside + main, mirroring the center grouped layout.
  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <aside className="md:w-[200px] md:shrink-0">
        <div className="md:sticky md:top-[76px] md:max-h-[calc(100vh-76px)] md:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Filter
            </span>
            {selMethods.size > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelMethods(new Set());
                  setFetchPage(1);
                }}
                className="cursor-pointer text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          <RosterFacet
            title="Methods & tools"
            options={methodFacet!}
            selected={selMethods}
            onToggle={makeToggle}
            collapseAfter={8}
            searchable
            searchPlaceholder="Search methods…"
            noMatchLabel="No methods match"
          />
        </div>
      </aside>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}
