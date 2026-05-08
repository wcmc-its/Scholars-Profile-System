"use client";

/**
 * Departments list — flat, type-filterable, sortable.
 *
 * Single list of all departments with a per-row type badge. Toggleable
 * type filter and a sort toggle (faculty count desc by default, or name).
 * Filter and sort state live in the URL (`?type=clinical,basic&sort=name`)
 * via `router.replace`, so deep-links and back-button restore state.
 *
 * Client Component so filter/sort can run instantly without a server
 * round-trip and without invalidating the parent /browse page's ISR.
 * The full department list (~24 rows) is passed in once at render time.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
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
  basic: "Basic science",
  mixed: "Basic & Clinical",
  administrative: "Administrative",
};

const TYPE_BADGE_CLASSES: Record<DepartmentCategory, string> = {
  clinical: "bg-[#eaf0f5] text-[#2c4f6e] border-[#c5d3df]",
  basic: "bg-[#e8f1ea] text-[#2e5b3a] border-[#c8d8cc]",
  mixed: "bg-[#f6eee0] text-[#7a5916] border-[#e3d4ad]",
  administrative: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

const VALID_TYPE_TOKENS = new Set<string>(TYPE_FILTER_ORDER);

type SortMode = "count" | "name";

function parseTypes(raw: string | null): Set<DepartmentCategory> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .filter((t) => VALID_TYPE_TOKENS.has(t)) as DepartmentCategory[],
  );
}

function parseSort(raw: string | null): SortMode {
  return raw === "name" ? "name" : "count";
}

export function DepartmentsGrid({
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
    const filtered =
      activeTypes.size === 0
        ? departments
        : departments.filter((d) => activeTypes.has(d.category));
    const sorted = [...filtered];
    if (sortMode === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      sorted.sort(
        (a, b) =>
          b.scholarCount - a.scholarCount || a.name.localeCompare(b.name),
      );
    }
    return sorted;
  }, [departments, activeTypes, sortMode]);

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
    pushState({ sort: s === "count" ? null : s });
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

      <div className="mt-5 flex flex-col gap-2.5 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
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
                className={`rounded-full border px-2.5 py-[3px] text-xs font-medium transition-colors ${
                  isActive
                    ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
                    : "border-zinc-300 bg-white text-foreground hover:border-zinc-400"
                }`}
              >
                {TYPE_BADGE_LABELS[t]}{" "}
                <span
                  className={
                    isActive ? "text-white/80" : "text-muted-foreground"
                  }
                >
                  {categoryCounts[t]}
                </span>
              </button>
            );
          })}
          {activeTypes.size > 0 ? (
            <button
              type="button"
              onClick={() => pushState({ type: null })}
              className="ml-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Sort
          </span>
          <SortButton
            label="Faculty count"
            isActive={sortMode === "count"}
            onClick={() => setSort("count")}
          />
          <SortButton
            label="Name (A–Z)"
            isActive={sortMode === "name"}
            onClick={() => setSort("name")}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No departments match this filter.{" "}
          <button
            type="button"
            className="text-[var(--color-accent-slate)] hover:underline"
            onClick={() => pushState({ type: null })}
          >
            Clear filter
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((d) => (
            <li key={d.code}>
              {d.category === "administrative" ? (
                <DeptRowFlat dept={d} />
              ) : (
                <DeptRowExpandable dept={d} />
              )}
            </li>
          ))}
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
      className={`rounded-full border px-2.5 py-[3px] text-xs font-medium transition-colors ${
        isActive
          ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white"
          : "border-zinc-300 bg-white text-foreground hover:border-zinc-400"
      }`}
    >
      {label}
    </button>
  );
}

function TypeBadge({ category }: { category: DepartmentCategory }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-[1px] text-[10px] font-medium uppercase tracking-[0.04em] ${TYPE_BADGE_CLASSES[category]}`}
    >
      {TYPE_BADGE_LABELS[category]}
    </span>
  );
}

function DeptRowFlat({ dept }: { dept: BrowseDepartment }) {
  return (
    <Link
      href={`/departments/${dept.slug}`}
      className="flex items-center gap-3 py-3 hover:no-underline"
    >
      <span className="inline-block w-3" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-foreground hover:text-[var(--color-accent-slate)]">
          {dept.name}
        </div>
        {dept.chairName ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Chair:</span>{" "}
            {dept.chairName}
          </div>
        ) : null}
      </div>
      <TypeBadge category={dept.category} />
    </Link>
  );
}

function DeptRowExpandable({ dept }: { dept: BrowseDepartment }) {
  const summaryParts: string[] = [];
  if (dept.divisions.length > 0) {
    summaryParts.push(
      `${dept.divisions.length} ${
        dept.divisions.length === 1 ? "division" : "divisions"
      }`,
    );
  }
  if (dept.topResearchAreas.length > 0) {
    summaryParts.push(
      `${dept.topResearchAreas.length} ${
        dept.topResearchAreas.length === 1 ? "research area" : "research areas"
      }`,
    );
  }

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
          {dept.chairName ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/70">Chair:</span>{" "}
              {dept.chairName}
            </div>
          ) : null}
        </div>
        {summaryParts.length > 0 ? (
          <div className="hidden whitespace-nowrap text-sm tabular-nums text-muted-foreground sm:block">
            {summaryParts.join(" · ")}
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
