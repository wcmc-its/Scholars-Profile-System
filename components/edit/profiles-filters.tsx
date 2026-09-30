"use client";

/**
 * The Profiles roster filter sidebar (#3/#4/#5/#6 — v2; formerly the Data
 * Quality dashboard's filter sidebar, folded in when that surface merged into
 * `/edit/profiles`). COI review moved to its own page (`/edit/coi`,
 * `components/edit/coi-filters.tsx`) — this sidebar only ever filters by the
 * Profiles-visible gaps (missing headshot / missing overview) and overview
 * freshness; it has no COI option at all, not even hidden.
 *
 * A client island that AUTO-APPLIES: every change (facet toggle, select, or
 * toggle) navigates the page to a new
 * query string via `router.replace` — no "Apply" button. The URL stays the source
 * of truth (shareable / reload-safe) and the server re-runs the query, so the
 * query, never the UI, remains the scope boundary. A soft nav keeps scroll
 * position and only re-renders the table. The name/CWID search is the page's
 * primary action, so it sits above the table (`ProfilesSearch`), not in the rail.
 *
 * Reuses the #972 `RosterFacet` typeahead; the org-unit hierarchy is a
 * "Department / division" facet with divisions indented under their parent, plus a
 * separate "Centers" facet (centers have no parent-dept FK, so they can't nest) and
 * an "Institution" facet (ED primary organization, `Scholar.primaryOrgCode`).
 */
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Info, Search } from "lucide-react";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  DataQualityFacets,
  DataQualityGapFilter,
  OverviewAgeFilter,
  RankFilter,
} from "@/lib/api/data-quality";

const BASE = "/edit/profiles";
const STUDENTS_NOTE =
  "Students and alumni don’t have their own profiles, but their collaborations with faculty still appear on faculty profiles.";
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
  /** Doctoral students / alumni are hidden unless this is set (`?students=1`). */
  includeStudents: boolean;
  /** Only suppressed (not publicly visible) profiles (`?visibility=hidden`). */
  hiddenOnly: boolean;
  /** Currently-applied ranks (`?rank=`). */
  ranks: RankFilter[];
};

type FilterState = {
  roles: ReadonlySet<string>;
  rankSet: ReadonlySet<string>;
  unitSet: ReadonlySet<string>;
  query: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  students: boolean;
  hiddenOnly: boolean;
};

function hrefFor(s: FilterState): string {
  const p = new URLSearchParams();
  if (s.query) p.set("q", s.query);
  for (const r of s.roles) p.append("type", r);
  for (const r of s.rankSet) p.append("rank", r);
  for (const u of s.unitSet) p.append("unit", u);
  if (s.gap !== "all") p.set("gap", s.gap);
  if (s.overviewAge !== "all") p.set("overviewAge", s.overviewAge);
  if (s.students) p.set("students", "1");
  if (s.hiddenOnly) p.set("visibility", "hidden");
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
  includeStudents,
  hiddenOnly,
  ranks,
}: ProfilesFiltersProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The phone sheet and the desktop rail can both be mounted — ids must differ.
  const id = useId();

  // Local state is the source of truth for the controls; every change navigates.
  const [selRoles, setSelRoles] = useState<ReadonlySet<string>>(new Set(roleCategories));
  const [selRanks, setSelRanks] = useState<ReadonlySet<string>>(new Set(ranks));
  const [selUnits, setSelUnits] = useState<ReadonlySet<string>>(new Set(units));
  const [gapVal, setGapVal] = useState<DataQualityGapFilter>(gap);
  const [ageVal, setAgeVal] = useState<OverviewAgeFilter>(overviewAge);
  const [students, setStudents] = useState(includeStudents);
  const [hiddenVal, setHiddenVal] = useState(hiddenOnly);

  // The search box lives above the table; `q` arrives fresh on every soft nav.
  const current = (): FilterState => ({
    roles: selRoles,
    rankSet: selRanks,
    unitSet: selUnits,
    query: q,
    gap: gapVal,
    overviewAge: ageVal,
    students,
    hiddenOnly: hiddenVal,
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
  const toggleRank = (value: string) => {
    const next = new Set(selRanks);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSelRanks(next);
    apply({ rankSet: next });
  };
  const toggleUnit = (value: string) => {
    const next = new Set(selUnits);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSelUnits(next);
    apply({ unitSet: next });
  };

  const clearAll = () => {
    setSelRoles(new Set());
    setSelRanks(new Set());
    setSelUnits(new Set());
    setGapVal("all");
    setAgeVal("all");
    setStudents(false);
    setHiddenVal(false);
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
      onSubmit={(e) => e.preventDefault()}
      /* R4 (surface language): a filter sidebar is a rail — one greige unit with
         its own edge, not controls loose on the page. --apollo-rail-border is the
         strong value because the hairline reads 1.035:1 on the rail and dies. */
      /* Console text tiers: options/body ink, labels + counts ink-2 (RosterFacet is
         shared with public pages, so its greys are overridden here, not there). */
      className="bg-apollo-rail border-apollo-rail-border text-apollo-ink [&_h3]:text-apollo-ink-2 [&_li_button]:text-apollo-ink [&_li_button>span:last-child]:text-apollo-ink-2 [&_label_svg]:text-apollo-icon w-full rounded-xl border p-4"
      data-testid="profiles-filter-form"
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {isPending ? "Updating…" : ""}
        </span>
        <button
          type="button"
          onClick={clearAll}
          className="text-apollo-ink-2 ml-auto text-xs hover:underline"
        >
          Clear
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor={`${id}-gap`} className="text-apollo-ink-2 text-xs">
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
        <label htmlFor={`${id}-overview-age`} className="text-apollo-ink-2 text-xs">
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

      {(facets.ranks?.length ?? 0) > 0 && (
        <RosterFacet
          title="Rank"
          options={facets.ranks ?? []}
          selected={selRanks}
          onToggle={toggleRank}
          collapseAfter={10}
        />
      )}

      <div className="mb-5 flex items-center gap-2 text-sm">
        <Switch
          id={`${id}-students`}
          checked={!students}
          onCheckedChange={(hide) => {
            setStudents(!hide);
            apply({ students: !hide });
          }}
          data-testid="profiles-hide-students"
        />
        <label htmlFor={`${id}-students`}>Hide students &amp; alumni</label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={STUDENTS_NOTE} className="ml-auto">
                <Info className="text-apollo-icon size-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{STUDENTS_NOTE}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
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

      <label className="text-apollo-ink-2 flex items-center gap-2 text-xs" htmlFor={`${id}-hidden-only`}>
        <input
          id={`${id}-hidden-only`}
          type="checkbox"
          checked={hiddenVal}
          onChange={(e) => {
            setHiddenVal(e.target.checked);
            apply({ hiddenOnly: e.target.checked });
          }}
          className="size-3.5 accent-[var(--color-primary-cornell-red)]"
          data-testid="profiles-hidden-only"
        />
        Only profiles hidden from the public
      </label>
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

/**
 * The name / CWID search above the roster table — the page's primary action.
 * Debounced; keeps every other filter in the URL and resets to page 1.
 */
export function ProfilesSearch({ q }: { q: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow external changes (the rail's Clear), but never while the user is typing.
  useEffect(() => {
    if (!timer.current) setDraft(q);
  }, [q]);

  const go = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = new URLSearchParams(params.toString());
    if (value.trim()) p.set("q", value.trim());
    else p.delete("q");
    p.delete("page");
    const qs = p.toString();
    router.replace(qs ? `${BASE}?${qs}` : BASE, { scroll: false });
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go(draft);
      }}
      className="relative"
    >
      <Search
        className="text-apollo-icon pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        aria-hidden
      />
      <input
        type="search"
        aria-label="Search name or CWID"
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => go(v), SEARCH_DEBOUNCE_MS);
        }}
        placeholder="Search by name or CWID"
        className="border-input bg-background text-apollo-ink h-10 w-full rounded-md border pr-3 pl-9 text-sm"
        data-testid="profiles-search"
      />
    </form>
  );
}
