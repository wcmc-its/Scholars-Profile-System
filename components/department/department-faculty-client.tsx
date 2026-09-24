"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RoleChipRow,
  filterByRoleCategory,
  ROLE_CATEGORIES,
  type RoleCategory,
} from "@/components/department/role-chip-row";
import { PersonRow } from "@/components/department/person-row";
import {
  RosterFacet,
  type FacetOption,
} from "@/components/center/center-roster-facets";
import { RosterToolbar } from "@/components/shared/roster-toolbar";
import { normalizeRosterQuery, type RosterSort } from "@/lib/roster-sort";
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
  divisionFacet,
  unitKind,
  unitCode,
  initialSort = "last",
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
  /** Unit Page v2 — the department's divisions (value = division code, count =
   *  the division's static scholarCount). Only offered when the filter route is
   *  live (`methodFacet` defined ⇒ the org-unit facet flag is on); a division
   *  roster never passes it. */
  divisionFacet?: FacetOption[];
  /** #974 Phase 2 — unit identity for the client-fetch filter route. */
  unitKind?: "department" | "division";
  unitCode?: string;
  /** Unit Page v2 — the roster sort the SSR `faculty` page was ranked by
   *  (`?sort=`, parsed server-side). */
  initialSort?: RosterSort;
}) {
  const [activeCategory, setActiveCategory] = useState<RoleCategory>("All");
  // Unit Page v2 roster toolbar. `nameQ` is the live input; `q` is its
  // normalised value, debounced 250ms, which drives the fetch + URL.
  const [sort, setSort] = useState<RosterSort>(initialSort);
  const [nameQ, setNameQ] = useState("");
  const [q, setQ] = useState("");

  // #974 Phase 2 — Methods facet selection (CLIENT state; values are sc::label
  // overlay keys). When non-empty, the rendered roster is the API's filtered page;
  // when empty, the SSR page-0 roster (`faculty`/`total`/`page`) renders unchanged.
  const [selMethods, setSelMethods] = useState<ReadonlySet<string>>(new Set());
  // Unit Page v2 — Division facet selection (division codes; department only).
  const [selDivs, setSelDivs] = useState<ReadonlySet<string>>(new Set());
  const [fetchPage, setFetchPage] = useState(1); // 1-based, like the SSR `page`
  const [filtered, setFiltered] = useState<{
    hits: DepartmentFacultyHit[];
    total: number;
    roleCategoryCounts?: Record<string, number>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  // Distinct from an empty result: a failed method-filter fetch (network / 5xx)
  // must not read as "no scholars match" — the API returning [] and the request
  // dying are different facts. Drives a retryable error state in the body.
  const [error, setError] = useState(false);
  // Bumped by the Retry affordance to re-run the fetch effect after a failure
  // (same selection + page, so nothing else in the dep list changes).
  const [retryNonce, setRetryNonce] = useState(0);

  const hasMethodFacet = Boolean(methodFacet && methodFacet.length > 0);
  // The Division facet rides the same flag-gated filter route, so it is only
  // offered when that route is live (`methodFacet` is undefined when the flag is
  // off) and only on a department roster.
  const hasDivisionFacet = Boolean(
    methodFacet !== undefined &&
      unitKind === "department" &&
      divisionFacet &&
      divisionFacet.length > 0,
  );
  const hasFacet = Boolean((hasMethodFacet || hasDivisionFacet) && unitKind && unitCode);
  // #2537 — the chip joins the server-filtered fetch path: "filtered" now means
  // any facet is active, not just methods. When `hasFacet` is false (facet
  // flag off, or no facet options), the chip stays a client-side page-only
  // filter and this is always false — today's behavior, untouched.
  const isFiltered =
    hasFacet && (selMethods.size > 0 || selDivs.size > 0 || activeCategory !== "All");
  // Unit Page v2 — the roster toolbar's sort + name filter are served by the
  // same route (not flag-gated), so any unit with an identity can use it. The
  // SSR page already carries `initialSort`, so only a DIFFERENT sort, a query,
  // or an active facet needs the server view.
  const canFetch = Boolean(unitKind && unitCode);
  const serverView = canFetch && (isFiltered || q !== "" || sort !== initialSort);

  // Deep-link on mount: seed `?method=` (#974) and/or `?type=` (#2528) from the
  // URL — the page HTML is the cached unfiltered shell, so the client reapplies
  // both facets here. Unified into one effect (rather than #2537 methods) so a
  // combined `?type=X&page=N` or `?method=X&type=Y&page=N` link seeds `fetchPage`
  // exactly once, off whichever facet(s) the link actually carries — a chip-only
  // deep link now implies the filtered view just as a method-only one always has.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let seededFilteredView = false;

    if (hasFacet) {
      const valid = new Set((methodFacet ?? []).map((o) => o.value));
      const seededMethods = params.getAll("method").filter((m) => valid.has(m));
      if (seededMethods.length > 0) {
        setSelMethods(new Set(seededMethods));
        seededFilteredView = true;
      }
      if (hasDivisionFacet) {
        const validDivs = new Set(divisionFacet!.map((o) => o.value));
        const seededDivs = params.getAll("div").filter((d) => validDivs.has(d));
        if (seededDivs.length > 0) {
          setSelDivs(new Set(seededDivs));
          seededFilteredView = true;
        }
      }
    }

    // The chip itself seeds regardless of `hasFacet` — the unfiltered pagination
    // path (buildHref) navigates via real hrefs and carries `type=` forward, so
    // this reads it back on the fresh mount even when the facet flag is off.
    const type = params.get("type");
    if (type && (ROLE_CATEGORIES as string[]).includes(type)) {
      setActiveCategory(type as RoleCategory);
      if (hasFacet) seededFilteredView = true;
    }

    // Unit Page v2 — a shared `?q=` link reopens with the name filter applied
    // (`?sort=` arrives already applied via `initialSort`).
    const seededQ = normalizeRosterQuery(params.get("q"));
    if (seededQ && canFetch) {
      setNameQ(seededQ);
      setQ(seededQ);
      seededFilteredView = true;
    }

    // #991 — restore the shared `?page=` too, so a filtered+paged deep-link opens
    // on the intended page rather than silently loading page 1 (which the
    // replaceState effect below would then rewrite back).
    if (seededFilteredView) {
      const pageParam = Number.parseInt(params.get("page") ?? "1", 10);
      if (Number.isFinite(pageParam) && pageParam > 1) setFetchPage(pageParam);
    }
    // mount-only; methodFacet/hasFacet are stable for a given render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the name input into `q` (250ms); a new query starts at page 1.
  useEffect(() => {
    const next = normalizeRosterQuery(nameQ);
    if (next === q) return;
    const t = setTimeout(() => {
      setQ(next);
      setFetchPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [nameQ, q]);

  // Reflect the selection (+ chip + sort + query + page) in
  // `?method=&div=&type=&sort=&q=&page=` via replaceState — keeps the URL
  // shareable without a navigation (the page stays the cached shell).
  useEffect(() => {
    if (!hasFacet && !canFetch) return;
    const params = new URLSearchParams(window.location.search);
    if (hasFacet) {
      params.delete("method");
      params.delete("div");
      params.delete("type");
      for (const v of selMethods) params.append("method", v);
      for (const d of selDivs) params.append("div", d);
      if (activeCategory !== "All") params.set("type", activeCategory);
    }
    params.delete("page");
    params.delete("sort");
    params.delete("q");
    if (sort !== "last") params.set("sort", sort);
    if (q) params.set("q", q);
    if (serverView) {
      // Filtered view paginates client-side via `fetchPage`.
      if (fetchPage > 1) params.set("page", String(fetchPage));
    } else if (page > 1) {
      // No facet active: reflect the SSR `page` prop, NOT whatever `?page=` is
      // already in the URL. This preserves a genuine unfiltered arrival at
      // `?page=3` while dropping a stale filtered `?page=N` when the user
      // clears the last facet (the unfiltered roster then renders SSR `page`,
      // so the address bar must agree with it).
      params.set("page", String(page));
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [
    selMethods,
    selDivs,
    activeCategory,
    fetchPage,
    hasFacet,
    canFetch,
    page,
    serverView,
    sort,
    q,
  ]);

  // Fetch the filtered roster whenever the selection, chip, sort, query or page
  // changes. Nothing active → clear the filtered state so the SSR roster renders.
  useEffect(() => {
    if (!canFetch) return;
    if (!serverView) {
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
    for (const d of selDivs) params.append("div", d);
    if (activeCategory !== "All") params.set("type", activeCategory);
    if (sort !== "last") params.set("sort", sort);
    if (q) params.set("q", q);
    params.set("page", String(Math.max(0, fetchPage - 1)));
    fetch(`/api/units/${unitKind}/${unitCode}/members?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(
        (data: {
          hits: DepartmentFacultyHit[];
          total: number;
          roleCategoryCounts?: Record<string, number>;
        }) => {
        setFiltered({
          hits: data.hits,
          total: data.total,
          roleCategoryCounts: data.roleCategoryCounts,
        });
        setLoading(false);
        },
      )
      .catch((err) => {
        if (err?.name === "AbortError") return;
        // Keep the previous `filtered` (don't overwrite with an empty result —
        // that would render as "No scholars match these filters."). Surface a
        // retryable error instead.
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [
    serverView,
    canFetch,
    selMethods,
    selDivs,
    activeCategory,
    sort,
    q,
    fetchPage,
    unitKind,
    unitCode,
    retryNonce,
  ]);

  const baseHits = useMemo(
    () => (serverView ? (filtered?.hits ?? []) : faculty),
    [serverView, filtered, faculty],
  );
  const renderedTotal = serverView ? (filtered?.total ?? 0) : total;
  const currentPage = serverView ? fetchPage : page;

  // The role chip applies over the CURRENTLY rendered set: a no-op on a server
  // view (the route already filtered by `type`), page-only otherwise (facet
  // flag off — today's behavior). Order is the server's ranking.
  const visible = useMemo(
    () => filterByRoleCategory(baseHits, activeCategory),
    [baseHits, activeCategory],
  );

  // Changing the chip resets to the first filtered page — mirrors `makeToggle`
  // below (methods facet) so the two facets behave identically on change.
  const handleCategoryChange = useCallback((cat: RoleCategory) => {
    setActiveCategory(cat);
    setFetchPage(1);
  }, []);

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
  const toggleDivision = useCallback((value: string) => {
    setSelDivs((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
    setFetchPage(1);
  }, []);
  const handleSortChange = useCallback((next: RosterSort) => {
    setSort(next);
    setFetchPage(1);
  }, []);
  const anySidebarSelected = selMethods.size > 0 || selDivs.size > 0;
  // Empty-state "Clear filters": sidebar facets, the Appointment chip AND the
  // name filter (mock `clearAll`). The sort is a view choice, not a filter.
  const clearAllFilters = () => {
    setSelMethods(new Set());
    setSelDivs(new Set());
    setActiveCategory("All");
    setNameQ("");
    setQ("");
    setFetchPage(1);
  };

  // Pagination URL builder — the unfiltered case navigates (cacheable links);
  // preserves the division path, the page (when >1), and the active role
  // chip (when not "All") so paging doesn't silently drop the filter (#2528).
  const buildHref = (p: number) => {
    const base = divisionSlug
      ? `/departments/${deptSlug}/divisions/${divisionSlug}`
      : `/departments/${deptSlug}`;
    const params = new URLSearchParams();
    if (p > 1) params.set("page", String(p));
    if (activeCategory !== "All") params.set("type", activeCategory);
    // Unit Page v2 — the SSR page ranks by `?sort=`, so paging keeps the order.
    if (sort !== "last") params.set("sort", sort);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
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
    <div className="flex justify-center pt-6">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              {...(serverView
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
                    {...(serverView
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
              {...(serverView
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

  // Appointment pill counts. Whole-scope (SSR) while only the chip or the sort
  // changes; while a name query or sidebar facet narrows the set, the route's
  // counts over that narrowed set (before the chip). Without them (no fetch yet,
  // or no route), a sidebar facet falls back to per-page counts (#2537).
  const narrowed = q !== "" || anySidebarSelected;
  const narrowedCounts = narrowed && serverView ? filtered?.roleCategoryCounts : undefined;
  const chipCounts = narrowedCounts ?? (anySidebarSelected ? undefined : roleCategoryCounts);
  const chipTotal = narrowedCounts
    ? Object.values(narrowedCounts).reduce((a, b) => a + b, 0)
    : anySidebarSelected
      ? undefined
      : total;

  // Shared body (Unit Page v2): roster toolbar, Appointment pills, the count
  // line, person rows, and pagination.
  const body = (
    <>
      <RosterToolbar
        query={nameQ}
        onQueryChange={setNameQ}
        sort={sort}
        onSortChange={handleSortChange}
      />
      <div className="mt-[14px]">
        <RoleChipRow
          faculty={baseHits}
          roleCategoryCounts={chipCounts}
          totalCount={chipTotal}
          active={activeCategory}
          onChange={handleCategoryChange}
        />
      </div>
      <div className="mt-4 text-[13px] text-muted-foreground">
        {serverView && loading
          ? "Loading…"
          : `Showing ${start}–${end} of ${renderedTotal.toLocaleString()} ${scholarsLabel}`}
      </div>
      {serverView && error ? (
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
      ) : serverView && loading && filtered === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="mt-5 border-t border-apollo-border py-6 text-[14px] text-muted-foreground">
          No scholars match these filters.{" "}
          <button
            type="button"
            onClick={clearAllFilters}
            className="cursor-pointer text-apollo-slate hover:underline"
          >
            Clear filters
          </button>
        </p>
      ) : (
        <div className="mt-2 flex flex-col">
          {visible.map((hit) => (
            <PersonRow
              key={hit.cwid}
              hit={hit}
              methodChips={hit.topMethods}
              meshChips={hit.topMesh}
              activeAppointment={activeCategory}
              departmentContext={divisionSlug === null}
            />
          ))}
        </div>
      )}
      {totalPages > 1 && pagination}
    </>
  );

  // No facet (flag off or no options) → single-column layout.
  if (!hasFacet) {
    return <div className="mt-5 pt-2">{body}</div>;
  }

  // Facet present → aside + main (Unit Page v2: wrap, 32px / 56px gaps).
  return (
    <div className="mt-5 flex flex-col gap-8 pt-2 md:flex-row md:flex-wrap md:items-start md:gap-x-14">
      <aside className="md:w-[200px] md:shrink-0 md:grow-0">
        <div className="flex flex-col gap-[22px] md:sticky md:top-[76px] md:max-h-[calc(100vh-76px)] md:overflow-y-auto">
          {anySidebarSelected && (
            <button
              type="button"
              onClick={() => {
                // Mock "Clear all": the sidebar facets and the name filter.
                setSelMethods(new Set());
                setSelDivs(new Set());
                setNameQ("");
                setQ("");
                setFetchPage(1);
              }}
              className="cursor-pointer self-start text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
            >
              Clear
            </button>
          )}
          {hasDivisionFacet && (
            <RosterFacet
              variant="unit"
              title="Division"
              options={divisionFacet!}
              selected={selDivs}
              onToggle={toggleDivision}
              collapseAfter={8}
            />
          )}
          {hasMethodFacet && (
            <RosterFacet
              variant="unit"
              title="Methods & tools"
              options={methodFacet!}
              selected={selMethods}
              onToggle={makeToggle}
              collapseAfter={8}
              searchable
              searchPlaceholder="Search methods…"
              noMatchLabel="No methods match"
            />
          )}
        </div>
      </aside>
      <div className="min-w-0 md:flex-[1_1_520px]">{body}</div>
    </div>
  );
}
