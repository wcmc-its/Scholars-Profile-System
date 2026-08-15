"use client";

/**
 * The Profiles roster filter sidebar (#3/#4/#5 — v2; formerly the Data Quality
 * dashboard's filter sidebar, folded in when that surface merged into
 * `/edit/scholars`). The "Has COI to review" gap option and its summary chip
 * are superuser-only (`canSeeCoi`) — the headshot/overview gap filters that
 * used to live here were dropped along with those columns.
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
 * separate "Centers" facet (centers have no parent-dept FK, so they can't nest).
 */
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import type { DataQualityFacets, DataQualityGapFilter } from "@/lib/api/data-quality";

const BASE = "/edit/scholars";
/** Debounce the free-text search so typing doesn't fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

export type ProfilesFiltersProps = {
  facets: DataQualityFacets;
  /** Currently-applied person types (raw roleCategory values). */
  roleCategories: string[];
  /** Currently-applied unit values (`dept:CODE` / `div:CODE` / `center:CODE`). */
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
  /** Whether to show the "Gap" (COI) filter at all — superuser-only. */
  canSeeCoi: boolean;
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

export function ProfilesFilters({
  facets,
  roleCategories,
  units,
  q,
  gap,
  includeHidden,
  canSeeCoi,
}: ProfilesFiltersProps) {
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
  // divisions, order preserved). Divisions are NOT indented: their label already
  // carries the parent department ("Cardiology (Medicine)"), and indentation would
  // wrongly imply nesting under whatever row sits above them under search.
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
        <label htmlFor="pf-q" className="text-muted-foreground text-xs">
          Search name or CWID
        </label>
        <input
          id="pf-q"
          type="search"
          value={qDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="e.g. Smith or jsmith"
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        />
      </div>

      {canSeeCoi && (
        <div className="mb-4 flex flex-col gap-1">
          <label htmlFor="pf-gap" className="text-muted-foreground text-xs">
            Gap
          </label>
          <select
            id="pf-gap"
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
      )}

      <label className="mb-5 flex items-center gap-2 text-sm" htmlFor="pf-hidden">
        <input
          id="pf-hidden"
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
