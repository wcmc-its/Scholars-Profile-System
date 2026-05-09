"use client";

/**
 * Departments list — flat, name-filterable, type-filterable, sortable.
 *
 * Single list of all departments (Library inline as a peer, not its own
 * group) with a per-row type badge and a controls bar:
 *   - free-text name filter (left, transient — no URL sync)
 *   - type-toggle chips (right) with unfiltered per-category counts
 *   - sort toggle (far right): Name (A–Z) default, or Faculty count
 *
 * Type and sort live in the URL (`?type=clinical,basic&sort=count`) via
 * `router.replace`, so deep-links and back-button restore those. The
 * name filter is intentionally not URL-synced — it's a narrow-the-view
 * affordance, not a shareable selection.
 *
 * Client Component so filter/sort run instantly without a server round-
 * trip and without invalidating the parent /browse page's ISR. The full
 * department list (~24 rows) ships once at render time and filters in
 * the browser.
 *
 * Row variant is driven by *expandable content*, not category: a row
 * with at least one division or top research area renders as <details>
 * with a real caret; otherwise it's a flat row with a hidden-caret
 * placeholder so the dept-name column stays aligned across the list.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import type { BrowseDepartment } from "@/lib/api/browse";
import type { DepartmentCategory } from "@/lib/department-categories";

const TYPE_FILTER_ORDER: ReadonlyArray<DepartmentCategory> = [
  "clinical",
  "basic",
  "mixed",
  "administrative",
];

const TYPE_BADGE_LABELS: Record<DepartmentCategory, string> = {
  clinical: "Clinical",
  basic: "Basic Science",
  mixed: "Basic & Clinical",
  administrative: "Administrative",
};

const TYPE_BADGE_CLASSES: Record<DepartmentCategory, string> = {
  clinical: "bg-[#eef4f9] text-[#2c4f6e]",
  basic: "bg-[#eaf4ec] text-[#2c5f3a]",
  mixed: "bg-[#f5edd8] text-[#6b5024]",
  administrative: "bg-[#f0eded] text-[#5a5854]",
};

const VALID_TYPE_TOKENS = new Set<string>(TYPE_FILTER_ORDER);

type SortMode = "name" | "count";

function parseTypes(raw: string | null): Set<DepartmentCategory> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .filter((t) => VALID_TYPE_TOKENS.has(t)) as DepartmentCategory[],
  );
}

function parseSort(raw: string | null): SortMode {
  return raw === "count" ? "count" : "name";
}

function isExpandable(d: BrowseDepartment): boolean {
  return d.divisions.length > 0 || d.topResearchAreas.length > 0;
}

export function DepartmentsGrid(props: { departments: BrowseDepartment[] }) {
  // useSearchParams() forces client-side rendering bailout during prerender
  // (Next.js 15 strict mode). Wrap in Suspense so the static prerender emits
  // the empty fallback and the full UI hydrates at request time.
  return (
    <Suspense fallback={null}>
      <DepartmentsGridInner {...props} />
    </Suspense>
  );
}

function DepartmentsGridInner({
  departments,
}: {
  departments: BrowseDepartment[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeTypes = useMemo(
    () => parseTypes(searchParams.get("type")),
    [searchParams],
  );
  const sortMode = parseSort(searchParams.get("sort"));
  const [nameFilter, setNameFilter] = useState("");

  const categoryCounts = useMemo(() => {
    const counts: Record<DepartmentCategory, number> = {
      clinical: 0,
      basic: 0,
      mixed: 0,
      administrative: 0,
    };
    for (const d of departments) counts[d.category]++;
    return counts;
  }, [departments]);

  const visible = useMemo(() => {
    let filtered = departments;
    if (activeTypes.size > 0) {
      filtered = filtered.filter((d) => activeTypes.has(d.category));
    }
    const needle = nameFilter.trim().toLowerCase();
    if (needle) {
      filtered = filtered.filter((d) =>
        d.name.toLowerCase().includes(needle),
      );
    }
    const sorted = [...filtered];
    if (sortMode === "count") {
      sorted.sort(
        (a, b) =>
          b.scholarCount - a.scholarCount || a.name.localeCompare(b.name),
      );
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [departments, activeTypes, sortMode, nameFilter]);

  function pushState(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    const url = qs ? `${pathname}?${qs}#departments` : `${pathname}#departments`;
    router.replace(url, { scroll: false });
  }

  function toggleType(t: DepartmentCategory) {
    const next = new Set(activeTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    const ordered = TYPE_FILTER_ORDER.filter((c) => next.has(c));
    pushState({ type: ordered.length === 0 ? null : ordered.join(",") });
  }

  function setSort(s: SortMode) {
    pushState({ sort: s === "name" ? null : s });
  }

  function clearAll() {
    pushState({ type: null });
    setNameFilter("");
  }

  if (departments.length === 0) {
    return (
      <section id="departments" className="mt-0">
        <h2 className="text-lg font-semibold">Departments</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Department data temporarily unavailable.
        </p>
      </section>
    );
  }

  const totalLabel =
    visible.length === departments.length
      ? `${departments.length} departments`
      : `${visible.length} of ${departments.length} departments`;
  const isFiltered = activeTypes.size > 0 || nameFilter.trim().length > 0;

  return (
    <section id="departments" className="mt-0">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">Departments</h2>
        <span className="text-xs text-muted-foreground">{totalLabel}</span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Clinical and research departments at Weill Cornell Medicine. Click
        through to a department&rsquo;s scholars, publications, divisions, and
        grants.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-y border-border py-3">
        <label className="relative shrink-0 grow basis-[260px] sm:grow-0">
          <span className="sr-only">Filter departments by name</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L13 13" />
          </svg>
          <input
            type="search"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter departments..."
            className="w-full rounded-md border border-border bg-white py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-zinc-400 focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Type
          </span>
          {TYPE_FILTER_ORDER.map((t) => {
            const isActive = activeTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                aria-pressed={isActive}
                className={`rounded-full border px-2.5 py-[3px] text-[12.5px] font-normal transition-colors ${
                  isActive
                    ? "border-foreground bg-foreground text-white"
                    : "border-border bg-white text-foreground/80 hover:border-zinc-400"
                }`}
              >
                {TYPE_BADGE_LABELS[t]}
                <span
                  className={`ml-1 text-[11.5px] ${
                    isActive ? "text-white/60" : "text-muted-foreground"
                  }`}
                >
                  {categoryCounts[t]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Sort
          </span>
          <SortButton
            label="Name (A–Z)"
            isActive={sortMode === "name"}
            onClick={() => setSort("name")}
          />
          <SortButton
            label="Faculty count"
            isActive={sortMode === "count"}
            onClick={() => setSort("count")}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No departments match this filter.{" "}
          <button
            type="button"
            className="text-[var(--color-accent-slate)] hover:underline"
            onClick={clearAll}
          >
            {isFiltered ? "Clear filters" : "Reset"}
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((d) =>
            isExpandable(d) ? (
              <li key={d.code}>
                <DeptRowExpandable dept={d} />
              </li>
            ) : (
              <li key={d.code}>
                <DeptRowFlat dept={d} />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function SortButton({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={`rounded-full border px-2.5 py-[3px] text-[12.5px] font-normal transition-colors ${
        isActive
          ? "border-foreground bg-foreground text-white"
          : "border-border bg-white text-foreground/80 hover:border-zinc-400"
      }`}
    >
      {label}
    </button>
  );
}

function TypeBadge({ category }: { category: DepartmentCategory }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.06em] ${TYPE_BADGE_CLASSES[category]}`}
    >
      {TYPE_BADGE_LABELS[category]}
    </span>
  );
}

function HeadLine({ dept }: { dept: BrowseDepartment }) {
  if (!dept.chairName) return null;
  const label = dept.category === "administrative" ? "Director" : "Chair";
  return (
    <div className="mt-0.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/70">{label}:</span>{" "}
      {dept.chairName}
    </div>
  );
}

function DeptRowFlat({ dept }: { dept: BrowseDepartment }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span
        className="inline-block w-3 text-[10px] text-transparent"
        aria-hidden="true"
      >
        ▶
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={`/departments/${dept.slug}`}
          className="text-base font-semibold text-foreground hover:text-[var(--color-accent-slate)]"
        >
          {dept.name}
        </Link>
        <HeadLine dept={dept} />
      </div>
      <TypeBadge category={dept.category} />
    </div>
  );
}

function DeptRowExpandable({ dept }: { dept: BrowseDepartment }) {
  const divisionCount =
    dept.divisions.length > 0
      ? `${dept.divisions.length} ${
          dept.divisions.length === 1 ? "division" : "divisions"
        }`
      : null;

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-3 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <span className="inline-block w-3 text-[10px] text-muted-foreground transition-transform group-open:rotate-90">
          ▶
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/departments/${dept.slug}`}
            className="text-base font-semibold text-foreground hover:text-[var(--color-accent-slate)]"
          >
            {dept.name}
          </Link>
          <HeadLine dept={dept} />
        </div>
        {divisionCount ? (
          <div className="hidden whitespace-nowrap text-sm tabular-nums text-muted-foreground sm:block">
            {divisionCount}
          </div>
        ) : null}
        <TypeBadge category={dept.category} />
      </summary>
      <div className="pb-4 pl-6">
        {dept.divisions.length > 0 ? (
          <div className="mt-1">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Divisions
            </div>
            <div className="flex flex-wrap gap-1">
              {dept.divisions.map((div) => (
                <Link
                  key={div.code}
                  href={`/departments/${dept.slug}/divisions/${div.slug}`}
                  className="rounded-full border border-[var(--color-accent-slate)] bg-white px-2 py-[2px] text-[11px] text-[var(--color-accent-slate)] hover:bg-[var(--color-accent-slate)] hover:text-white hover:no-underline"
                >
                  {div.name}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {dept.topResearchAreas.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Top research
            </div>
            <div className="flex flex-wrap gap-1">
              {dept.topResearchAreas.map((t) => (
                <Link
                  key={t.topicSlug}
                  href={`/topics/${t.topicSlug}`}
                  className="rounded-full bg-[#f6f3ee] px-2 py-[2px] text-[11px] text-foreground hover:bg-[#ede5d6] hover:no-underline"
                >
                  {t.topicLabel}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        <Link
          href={`/departments/${dept.slug}`}
          className="mt-3 inline-block text-sm text-[var(--color-accent-slate)] hover:underline"
        >
          View {dept.name} &rarr;
        </Link>
      </div>
    </details>
  );
}
