"use client";

/**
 * The Profiles roster filter sidebar (#3/#4/#5/#6 — v2; formerly the Data
 * Quality dashboard's filter sidebar, folded in when that surface merged into
 * `/edit/scholars`). COI review moved to its own page (`/edit/coi`,
 * `components/edit/coi-filters.tsx`) — this sidebar only ever filters by the
 * Profiles-visible gaps (missing headshot / missing overview) and overview
 * freshness; it has no COI option at all, not even hidden.
 *
 * A client island that AUTO-APPLIES: every change (facet toggle, select, the
 * hidden-roles checkbox, or the debounced search box) navigates the page to a new
 * query string via `router.replace` — no "Apply" button. The URL stays the source
 * of truth (shareable / reload-safe) and the server re-runs the query, so the
 * query, never the UI, remains the scope boundary. A soft nav keeps scroll
 * position and only re-renders the table.
 *
 * Reuses the #972 `RosterFacet` typeahead; the org-unit hierarchy is a
 * "Department / division" facet with divisions indented under their parent, plus a
 * separate "Centers" facet (centers have no parent-dept FK, so they can't nest) and
 * an "Institution" facet (ED primary organization, `Scholar.primaryOrgCode`).
 */
import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import type {
  DataQualityFacets,
  DataQualityGapFilter,
  OverviewAgeFilter,
} from "@/lib/api/data-quality";

const BASE = "/edit/scholars";
/** Debounce the free-text search so typing doesn't fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

export type ProfilesFiltersProps = {
  facets: DataQualityFacets;
  /** Currently-applied person types (raw roleCategory values). */
  roleCategories: string[];
  /** Currently-applied unit values (`dept:CODE` / `div:CODE` / `center:CODE` /
   *  `inst:CODE`). */
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeHidden: boolean;
};

type FilterState = {
  roles: ReadonlySet<string>;
  unitSet: ReadonlySet<string>;
  query: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  hide: boolean;
};

function hrefFor(s: FilterState): string {
  const p = new URLSearchParams();
  if (s.query) p.set("q", s.query);
  for (const r of s.roles) p.append("type", r);
  for (const u of s.unitSet) p.append("unit", u);
  if (s.gap !== "all") p.set("gap", s.gap);
  if (s.overviewAge !== "all") p.set("overviewAge", s.overviewAge);
  if (s.hide) p.set("hidden", "0");
  // No `page` → any filter change resets to the first page.
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function ProfilesFilters({
  facets,
  roleCategories,
  units,
  q,
  gap,
  overviewAge,
  includeHidden,
}: ProfilesFiltersProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The phone sheet and the desktop rail can both be mounted — ids must differ.
  const id = useId();

  // Local state is the source of truth for the controls; every change navigates.
  const [selRoles, setSelRoles] = useState<ReadonlySet<string>>(new Set(roleCategories));
  const [selUnits, setSelUnits] = useState<ReadonlySet<string>>(new Set(units));
  const [qDraft, setQDraft] = useState(q);
  const [gapVal, setGapVal] = useState<DataQualityGapFilter>(gap);
  const [ageVal, setAgeVal] = useState<OverviewAgeFilter>(overviewAge);
  const [hide, setHide] = useState(!includeHidden); // checkbox checked = hide
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = (): FilterState => ({
    roles: selRoles,
    unitSet: selUnits,
    query: qDraft,
    gap: gapVal,
    overviewAge: ageVal,
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
    setAgeVal("all");
    setHide(false);
    startTransition(() => router.replace(BASE, { scroll: false }));
  };

  // Person-type options (counts come from the loader).
  const roleOptions: FacetOption[] = facets.roleCategories;

  // Department + division options as a FLAT list: every department (largest
  // first) THEN every division (largest first), so the collapsed top-N is all
  // departments rather than Medicine plus nine of its divisions. Divisions are NOT
  // indented: their label already carries the parent ("Cardiology (Medicine)").
  const unitOptions = useMemo<FacetOption[]>(() => {
    const depts = facets.departments.map(({ value, label, count }) => ({ value, label, count }));
    const divs = facets.departments
      .flatMap((d) => d.divisions)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return [...depts, ...divs];
  }, [facets.departments]);

  // A center with no members can only ever return zero rows — hide it, unless
  // it's already selected (it must stay visible to be un-ticked).
  const centerOptions: FacetOption[] = facets.centers.filter(
    (c) => c.count > 0 || selUnits.has(c.value),
  );
  const institutionOptions: FacetOption[] = facets.institutions;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); // Enter in the search box applies immediately.
        flushSearch();
      }}
      /* R4 (surface language): a filter sidebar is a rail — one greige unit with
         its own edge, not controls loose on the page. --apollo-rail-border is the
         strong value because the hairline reads 1.035:1 on the rail and dies. */
      className="bg-apollo-rail border-apollo-rail-border w-full rounded-xl border p-4"
      data-testid="profiles-filter-form"
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
        <label htmlFor={`${id}-q`} className="text-muted-foreground text-xs">
          Search name or CWID
        </label>
        <input
          id={`${id}-q`}
          type="search"
          value={qDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="e.g. Smith or jsmith"
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        />
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor={`${id}-gap`} className="text-muted-foreground text-xs">
          Gap
        </label>
        <select
          id={`${id}-gap`}
          value={gapVal}
          onChange={(e) => {
            const v = e.target.value as DataQualityGapFilter;
            setGapVal(v);
            apply({ gap: v });
          }}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="all">Any</option>
          <option value="no-headshot">Missing headshot</option>
          <option value="no-overview">Missing overview</option>
        </select>
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor={`${id}-overview-age`} className="text-muted-foreground text-xs">
          Overview last updated
        </label>
        <select
          id={`${id}-overview-age`}
          value={ageVal}
          onChange={(e) => {
            const v = e.target.value as OverviewAgeFilter;
            setAgeVal(v);
            apply({ overviewAge: v });
          }}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="all">Any</option>
          <option value="imported">Imported / seed only</option>
          <option value="never">No overview</option>
          <option value="lt1yr">Edited &lt; 1 year ago</option>
          <option value="1to2yr">Edited 1–2 years ago</option>
          <option value="gt2yr">Edited &gt; 2 years ago</option>
        </select>
      </div>

      <label className="mb-5 flex items-center gap-2 text-sm" htmlFor={`${id}-hidden`}>
        <input
          id={`${id}-hidden`}
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
      <RosterFacet
        title="Institution"
        options={institutionOptions}
        selected={selUnits}
        onToggle={toggleUnit}
        collapseAfter={10}
        searchable
        searchPlaceholder="Search institutions…"
        noMatchLabel="No institutions match"
      />
    </form>
  );
}

/**
 * Phones: the rail stacked ABOVE the table pushed every result below several
 * screens of checkboxes. Below `lg` the same `ProfilesFilters` slides in from the
 * left instead; the desktop rail (`hidden lg:block` in the roster) is untouched.
 * Filters still auto-apply, so the sheet stays open for several picks.
 */
export function ProfilesFiltersSheet({
  activeCount,
  ...props
}: ProfilesFiltersProps & { activeCount: number }) {
  // ponytail: this instance re-inits from the URL on each open; the hidden
  // desktop rail keeps its own state, which only matters on a resize across lg.
  return (
    <FiltersSheet activeCount={activeCount} testId="profiles-filters-sheet-trigger">
      <ProfilesFilters {...props} />
    </FiltersSheet>
  );
}
