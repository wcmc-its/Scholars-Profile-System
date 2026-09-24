"use client";

/**
 * Departments list — flat, name-filterable, type-filterable, sortable.
 *
 * Single list of all departments (Library inline as a peer, not its own
 * group) with a per-row type badge and a controls bar:
 *   - free-text name filter (left, transient — no URL sync); matches the
 *     department name or its leader's name
 *   - type-toggle chips (right) with per-category counts over the
 *     name-filtered list (the type filter itself doesn't change them)
 *   - sort toggle (far right): Name (A–Z) default, or Faculty count
 *
 * Type and sort live in the URL (`?type=clinical,basic&sort=count`) via
 * `history.replaceState`, so deep-links and back-button restore those (the
 * filtered/sorted view is fully client-derived, so no RSC refetch is needed on
 * a toggle). The name filter is intentionally not URL-synced — it's a
 * narrow-the-view affordance, not a shareable selection.
 *
 * Client Component so filter/sort run instantly without a server round-
 * trip and without invalidating the parent /browse page's ISR. The full
 * department list (~24 rows) ships once at render time and filters in
 * the browser.
 *
 * Every row is an expandable disclosure (Departments & Centers v2 mock): a
 * 5-column grid of caret · name + leader · scholar count · division count ·
 * type badge. The panel lists divisions and top research areas (when any)
 * and always ends in a "View <name> →" link. The name stays a direct <Link>
 * to the department page, so the row is NOT one big <button> — see
 * DeptRow for how the toggle and the link stay non-nested (#575).
 */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Suspense, useId, useMemo, useState, type MouseEvent } from "react";
import type { BrowseDepartment } from "@/lib/api/browse";
import type { DepartmentCategory } from "@/lib/department-categories";
import { compactUnitName } from "@/lib/org-unit-names";
import { Input } from "@/components/ui/input";
import {
  BROWSE_COUNT_CLASS,
  BROWSE_DESC_CLASS,
  BROWSE_H2_CLASS,
  BROWSE_SECTION_CLASS,
} from "@/components/browse/browse-styles";

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

export const TYPE_BADGE_CLASSES: Record<DepartmentCategory, string> = {
  clinical: "bg-apollo-slate-tint text-apollo-slate",
  basic:
    "bg-apollo-surface-2 text-apollo-bar shadow-[inset_0_0_0_1px_var(--apollo-border-strong)]",
  mixed: "bg-apollo-amber-tint text-apollo-amber",
  administrative:
    "bg-white text-muted-foreground shadow-[inset_0_0_0_1px_var(--apollo-border-strong)]",
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

/** The name filter matches the displayed (compact) name, the raw ED name +
 *  official form (so "Samuel J. Wood", "Library", or "Samuel J. Wood Library"
 *  all find the row after a curated rename), and the leader's name. */
function matchesName(d: BrowseDepartment, needle: string): boolean {
  if (!needle) return true;
  return [compactUnitName(d), d.name, d.officialName ?? "", d.chairName ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

const PILL_BASE =
  "inline-flex h-7 items-center gap-[5px] whitespace-nowrap rounded-full border px-[11px] text-[13px] leading-none transition-colors duration-[120ms] ease-out";
const PILL_ON = "border-apollo-slate bg-apollo-slate text-white";
const PILL_OFF =
  "border-apollo-border-strong bg-white text-foreground hover:bg-apollo-surface-2";
const CONTROL_LABEL =
  "text-[11px] uppercase tracking-[0.12em] text-muted-foreground";

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
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeTypes = useMemo(
    () => parseTypes(searchParams.get("type")),
    [searchParams],
  );
  const sortMode = parseSort(searchParams.get("sort"));
  const [nameFilter, setNameFilter] = useState("");

  const needle = nameFilter.trim().toLowerCase();

  // Per-category counts over the NAME-filtered list (not the type filter), so
  // each pill says how many rows it would add under the current name filter.
  const categoryCounts = useMemo(() => {
    const counts: Record<DepartmentCategory, number> = {
      clinical: 0,
      basic: 0,
      mixed: 0,
      administrative: 0,
    };
    for (const d of departments) {
      if (matchesName(d, needle)) counts[d.category]++;
    }
    return counts;
  }, [departments, needle]);

  const visible = useMemo(() => {
    let filtered = departments.filter((d) => matchesName(d, needle));
    if (activeTypes.size > 0) {
      filtered = filtered.filter((d) => activeTypes.has(d.category));
    }
    const sorted = [...filtered];
    // Sort by the displayed (compact) name so the alphabetical order matches
    // the visible labels.
    const byName = (a: BrowseDepartment, b: BrowseDepartment) =>
      compactUnitName(a).localeCompare(compactUnitName(b));
    if (sortMode === "count") {
      sorted.sort((a, b) => b.scholarCount - a.scholarCount || byName(a, b));
    } else {
      sorted.sort(byName);
    }
    return sorted;
  }, [departments, activeTypes, sortMode, needle]);

  function pushState(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    const url = qs ? `${pathname}?${qs}#departments` : `${pathname}#departments`;
    // Update the URL in place with the native History API rather than
    // router.replace(). The filtered/sorted result is fully client-derivable
    // from the already-shipped `departments` prop (the `visible` useMemo), and
    // type/sort are read via useSearchParams() — which Next keeps in sync with
    // history.replaceState — so a router navigation would only trigger a
    // needless RSC refetch of /browse per toggle. replaceState does not scroll,
    // matching the prior { scroll: false }. (Mirrors profile-pubs-cluster.tsx.)
    window.history.replaceState(null, "", url);
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
      <section
        id="departments"
        data-spy="departments"
        className={`mt-11 ${BROWSE_SECTION_CLASS}`}
      >
        <h2 className={BROWSE_H2_CLASS}>Departments</h2>
        <p className="mt-2 text-[14px] text-muted-foreground">
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
    <section
      id="departments"
      data-spy="departments"
      className={`mt-11 ${BROWSE_SECTION_CLASS}`}
    >
      <div className="flex items-baseline gap-3">
        <h2 className={BROWSE_H2_CLASS}>Departments</h2>
        <span className={BROWSE_COUNT_CLASS}>{totalLabel}</span>
      </div>
      <p className={BROWSE_DESC_CLASS}>
        Clinical and research departments at Weill Cornell Medicine. Click
        through to a department&rsquo;s scholars, publications, divisions, and
        grants.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-apollo-border py-3">
        <label className="relative min-w-[200px] shrink grow-0 basis-[260px] max-sm:grow">
          <span className="sr-only">Filter departments</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <Input
            type="search"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter departments..."
            className="h-8 pl-8"
          />
        </label>

        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <span className={`mr-1 ${CONTROL_LABEL}`}>Type</span>
          {TYPE_FILTER_ORDER.map((t) => {
            const isActive = activeTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                aria-pressed={isActive}
                className={`${PILL_BASE} ${isActive ? PILL_ON : PILL_OFF}`}
              >
                {TYPE_BADGE_LABELS[t]}
                <span
                  className={isActive ? "opacity-80" : "text-muted-foreground"}
                >
                  {categoryCounts[t]}
                </span>
              </button>
            );
          })}
          <span className={`ml-2 mr-1 ${CONTROL_LABEL}`}>Sort</span>
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
        <p className="py-6 text-[14px] text-muted-foreground">
          No departments match.{" "}
          <button
            type="button"
            className="text-apollo-slate hover:underline"
            onClick={clearAll}
          >
            Clear filters
          </button>
        </p>
      ) : (
        <ul>
          {visible.map((d) => (
            <li key={d.code} className="border-b border-apollo-border">
              <DeptRow dept={d} />
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
      className={`${PILL_BASE} ${isActive ? PILL_ON : PILL_OFF}`}
    >
      {label}
    </button>
  );
}

function TypeBadge({ category }: { category: DepartmentCategory }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] leading-4 font-semibold uppercase tracking-[0.08em] ${TYPE_BADGE_CLASSES[category]}`}
    >
      {TYPE_BADGE_LABELS[category]}
    </span>
  );
}

function HeadLine({ dept }: { dept: BrowseDepartment }) {
  return (
    <span className="flex flex-wrap gap-x-1.5 text-[13px] leading-[18px] text-muted-foreground">
      {dept.chairName ? (
        <>
          <span>{dept.chairLabel ?? "Chair"}</span>
          <span className="text-foreground">{dept.chairName}</span>
        </>
      ) : (
        <span className="text-foreground">Leadership not listed</span>
      )}
    </span>
  );
}

const CHIP_LABEL =
  "text-[11px] uppercase tracking-[0.12em] text-muted-foreground";

function DeptRow({ dept }: { dept: BrowseDepartment }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const name = compactUnitName(dept);

  const divisionCount =
    dept.divisions.length > 0
      ? `${dept.divisions.length} ${
          dept.divisions.length === 1 ? "division" : "divisions"
        }`
      : null;
  // 0 renders blank (units with no scholars, e.g. Library / programs), as
  // the mock leaves the cell empty rather than printing "0 scholars".
  const scholarCount =
    dept.scholarCount > 0
      ? `${dept.scholarCount.toLocaleString("en-US")} ${
          dept.scholarCount === 1 ? "scholar" : "scholars"
        }`
      : null;

  // The mock draws the whole row as one toggle <button>, but the shipped name
  // <Link> must stay, and a link inside a button is a nested interactive
  // (WCAG 4.1.2, issue #575). So the caret <button> is the one keyboard /
  // assistive-tech toggle (aria-expanded + aria-controls), the name <Link> a
  // sibling, and a pointer click anywhere else on the row forwards to the
  // toggle. Clicks that land on a link are left alone.
  function onRowClick(e: MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("a, button")) return;
    setOpen((o) => !o);
  }

  return (
    <div>
      <div
        data-testid="dept-row"
        onClick={onRowClick}
        className="grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3.5 transition-colors duration-[120ms] ease-out hover:bg-apollo-page sm:grid-cols-[16px_minmax(0,1fr)_116px_92px_132px]"
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? "Collapse" : "Expand"} ${name}${
            divisionCount ? `, ${divisionCount}` : ""
          }`}
          className="-mx-1 flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground"
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <Link
            href={`/departments/${dept.slug}`}
            className="self-start text-[16px] leading-[22px] text-foreground hover:text-apollo-slate hover:no-underline"
          >
            {name}
          </Link>
          <HeadLine dept={dept} />
        </span>
        {/* Below sm the three trailing cells wrap onto one line under the
            name; at sm+ `contents` hands them back to the 5-column grid. */}
        <span className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] tabular-nums text-muted-foreground sm:contents">
          <span
            data-testid="dept-scholar-count"
            className="whitespace-nowrap max-sm:empty:hidden sm:text-right"
          >
            {scholarCount}
          </span>
          <span
            data-testid="dept-division-count"
            className="whitespace-nowrap max-sm:empty:hidden sm:text-right"
          >
            {divisionCount}
          </span>
          <span className="flex sm:justify-end">
            <TypeBadge category={dept.category} />
          </span>
        </span>
      </div>
      <div
        id={panelId}
        hidden={!open}
        className={open ? "flex flex-col gap-3.5 pb-5 pl-7" : undefined}
      >
        {dept.divisions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className={CHIP_LABEL}>Divisions</span>
            <div className="flex flex-wrap gap-1.5">
              {dept.divisions.map((div) => (
                <Link
                  key={div.code}
                  href={`/departments/${dept.slug}/divisions/${div.slug}`}
                  className="whitespace-nowrap rounded-full border border-apollo-slate px-2 py-0.5 text-xs leading-[18px] text-apollo-slate transition-colors duration-[120ms] ease-out hover:bg-apollo-slate-tint hover:no-underline"
                >
                  {div.name}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {dept.topResearchAreas.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className={CHIP_LABEL}>Top research</span>
            <div className="flex flex-wrap gap-1.5">
              {dept.topResearchAreas.map((t) => (
                <Link
                  key={t.topicSlug}
                  href={`/topics/${t.topicSlug}`}
                  className="rounded-full bg-apollo-surface-2 px-2 py-[3px] text-xs leading-[18px] text-foreground transition-colors duration-[120ms] ease-out hover:bg-apollo-rail hover:no-underline"
                >
                  {t.topicLabel}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        <Link
          href={`/departments/${dept.slug}`}
          className="self-start text-[14px] text-apollo-slate hover:underline"
        >
          View {name} &rarr;
        </Link>
      </div>
    </div>
  );
}
