"use client";

/**
 * The COI dashboard's filter sidebar (`/edit/coi`, superuser-only). A trimmed
 * sibling of `components/edit/profiles-filters.tsx` — same auto-apply client
 * island, same facet/search/hidden-roles controls, but the only "Gap" option
 * is COI itself (no headshot/overview — those are Profiles-only), and there's
 * no overview-freshness filter at all.
 *
 * A client island that AUTO-APPLIES: every change (facet toggle, select, the
 * hidden-roles checkbox, or the debounced search box) navigates the page to a
 * new query string via `router.replace` — no "Apply" button. The URL stays
 * the source of truth (shareable / reload-safe) and the server re-runs the
 * query, so the query, never the UI, remains the scope boundary.
 */
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import type { DataQualityFacets, DataQualityGapFilter } from "@/lib/api/data-quality";

const BASE = "/edit/coi";
/** Debounce the free-text search so typing doesn't fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

export type CoiFiltersProps = {
  facets: DataQualityFacets;
  /** Currently-applied person types (raw roleCategory values). */
  roleCategories: string[];
  /** Currently-applied unit values (`dept:CODE` / `div:CODE` / `center:CODE`). */
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
};

type FilterState = {
  roles: ReadonlySet<string>;
  unitSet: ReadonlySet<string>;
  query: string;
  gap: DataQualityGapFilter;
  hide: boolean;
};

function hrefFor(s: FilterState): string {
  const p = new URLSearchParams();
  if (s.query) p.set("q", s.query);
  for (const r of s.roles) p.append("type", r);
  for (const u of s.unitSet) p.append("unit", u);
  if (s.gap !== "all") p.set("gap", s.gap);
  if (s.hide) p.set("hidden", "0");
  // No `page` → any filter change resets to the first page.
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function CoiFilters({ facets, roleCategories, units, q, gap, includeHidden }: CoiFiltersProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Local state is the source of truth for the controls; every change navigates.
  const [selRoles, setSelRoles] = useState<ReadonlySet<string>>(new Set(roleCategories));
  const [selUnits, setSelUnits] = useState<ReadonlySet<string>>(new Set(units));
  const [qDraft, setQDraft] = useState(q);
  const [gapVal, setGapVal] = useState<DataQualityGapFilter>(gap);
  const [hide, setHide] = useState(!includeHidden); // checkbox checked = hide
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = (): FilterState => ({
    roles: selRoles,
    unitSet: selUnits,
    query: qDraft,
    gap: gapVal,
    hide,
  });

  const apply = (over: Partial<FilterState>) => {
    const href = hrefFor({ ...current(), ...over });
    startTransition(() => router.replace(href, { scroll: false }));
  };

  const toggleRole = (value: string) => {
    const next = new Set(selRoles);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSelRoles(next);
    apply({ roles: next });
  };
  const toggleUnit = (value: string) => {
    const next = new Set(selUnits);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSelUnits(next);
    apply({ unitSet: next });
  };

  const onSearchChange = (value: string) => {
    setQDraft(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => apply({ query: value }), SEARCH_DEBOUNCE_MS);
  };
  const flushSearch = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    apply({ query: qDraft });
  };

  const clearAll = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSelRoles(new Set());
    setSelUnits(new Set());
    setQDraft("");
    setGapVal("all");
    setHide(false);
    startTransition(() => router.replace(BASE, { scroll: false }));
  };

  // Person-type options (counts come from the loader).
  const roleOptions: FacetOption[] = facets.roleCategories;

  // Department + division options as a FLAT list (each department followed by its
  // divisions, order preserved) — same layout rationale as `ProfilesFilters`.
  const unitOptions = useMemo<FacetOption[]>(() => {
    const out: FacetOption[] = [];
    for (const dep of facets.departments) {
      out.push({ value: dep.value, label: dep.label, count: dep.count });
      for (const div of dep.divisions) {
        out.push({ value: div.value, label: div.label, count: div.count });
      }
    }
    return out;
  }, [facets.departments]);

  const centerOptions: FacetOption[] = facets.centers;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); // Enter in the search box applies immediately.
        flushSearch();
      }}
      className="bg-apollo-rail border-apollo-rail-border w-full rounded-xl border p-4"
      data-testid="coi-filter-form"
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {isPending ? "Updating…" : "Filters apply automatically"}
        </span>
        <button
          type="button"
          onClick={clearAll}
          className="text-muted-foreground ml-auto text-xs hover:underline"
        >
          Clear
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor="coi-q" className="text-muted-foreground text-xs">
          Search name or CWID
        </label>
        <input
          id="coi-q"
          type="search"
          value={qDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="e.g. Smith or jsmith"
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        />
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor="coi-gap" className="text-muted-foreground text-xs">
          Gap
        </label>
        <select
          id="coi-gap"
          value={gapVal}
          onChange={(e) => {
            const v = e.target.value as DataQualityGapFilter;
            setGapVal(v);
            apply({ gap: v });
          }}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="all">Any</option>
          <option value="has-coi">Has COI to review</option>
        </select>
      </div>

      <label className="mb-5 flex items-center gap-2 text-sm" htmlFor="coi-hidden">
        <input
          id="coi-hidden"
          type="checkbox"
          checked={hide}
          onChange={(e) => {
            setHide(e.target.checked);
            apply({ hide: e.target.checked });
          }}
          className="size-4"
        />
        Hide students &amp; alumni
      </label>

      <RosterFacet
        title="Person type"
        options={roleOptions}
        selected={selRoles}
        onToggle={toggleRole}
        collapseAfter={10}
        searchable
        searchPlaceholder="Search person types…"
        noMatchLabel="No person types match"
      />
      <RosterFacet
        title="Department / division"
        options={unitOptions}
        selected={selUnits}
        onToggle={toggleUnit}
        collapseAfter={10}
        searchable
        searchPlaceholder="Search departments…"
        noMatchLabel="No units match"
      />
      <RosterFacet
        title="Centers"
        options={centerOptions}
        selected={selUnits}
        onToggle={toggleUnit}
        collapseAfter={10}
        searchable
        searchPlaceholder="Search centers…"
        noMatchLabel="No centers match"
      />
    </form>
  );
}
