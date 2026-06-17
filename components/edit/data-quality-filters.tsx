"use client";

/**
 * The Data Quality dashboard filter sidebar (#3/#4/#5/#6 — v2).
 *
 * A small client island: the only client-side state is the multi-select facet
 * choices (person type + org units), held as `Set`s and mirrored into hidden
 * `<input>`s so the surrounding plain `<form method="get">` submits them as
 * repeated query params on "Apply". The server (page + export route) re-runs the
 * query with the new params — the query, never the UI, stays the scope boundary.
 *
 * Free-text search, the gap/overview-age selects, and the hidden-roles toggle are
 * native named inputs that submit directly. Reuses the #972 `RosterFacet`
 * typeahead; the org-unit hierarchy is shown as a "Department / division" facet
 * with divisions indented under their parent, plus a separate "Centers" facet
 * (centers have no parent-dept FK, so they can't nest).
 */
import { useMemo, useState } from "react";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import { Button } from "@/components/ui/button";
import type {
  DataQualityFacets,
  DataQualityGapFilter,
  OverviewAgeFilter,
} from "@/lib/api/data-quality";

const BASE = "/edit/data-quality";

export type DataQualityFiltersProps = {
  facets: DataQualityFacets;
  /** Currently-applied person types (raw roleCategory values). */
  roleCategories: string[];
  /** Currently-applied unit values (`dept:CODE` / `div:CODE` / `center:CODE`). */
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeHidden: boolean;
};

function makeToggle(
  set: ReadonlySet<string>,
  setSet: (s: ReadonlySet<string>) => void,
): (value: string) => void {
  return (value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSet(next);
  };
}

export function DataQualityFilters({
  facets,
  roleCategories,
  units,
  q,
  gap,
  overviewAge,
  includeHidden,
}: DataQualityFiltersProps) {
  const [selRoles, setSelRoles] = useState<ReadonlySet<string>>(new Set(roleCategories));
  const [selUnits, setSelUnits] = useState<ReadonlySet<string>>(new Set(units));

  // Person-type options (counts come from the loader).
  const roleOptions: FacetOption[] = facets.roleCategories;

  // Department/division options: each department followed by its indented child
  // divisions, so the flat list reads as a hierarchy (order is preserved).
  const unitOptions = useMemo<FacetOption[]>(() => {
    const out: FacetOption[] = [];
    for (const dep of facets.departments) {
      out.push({ value: dep.value, label: dep.label, count: dep.count });
      for (const div of dep.divisions) {
        out.push({ value: div.value, label: div.label, count: div.count, indent: 1 });
      }
    }
    return out;
  }, [facets.departments]);

  const centerOptions: FacetOption[] = facets.centers;

  const toggleRole = makeToggle(selRoles, setSelRoles);
  const toggleUnit = makeToggle(selUnits, setSelUnits);

  return (
    <form method="get" action={BASE} className="w-full" data-testid="dq-filter-form">
      <div className="mb-4 flex items-center gap-2">
        <Button type="submit" variant="outline" size="sm">
          Apply filters
        </Button>
        <a href={BASE} className="text-muted-foreground text-xs hover:underline">
          Clear
        </a>
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor="dq-q" className="text-muted-foreground text-xs">
          Search name or CWID
        </label>
        <input
          id="dq-q"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="e.g. Harrington or rharrington"
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        />
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor="dq-gap" className="text-muted-foreground text-xs">
          Gap
        </label>
        <select
          id="dq-gap"
          name="gap"
          defaultValue={gap}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="all">Any</option>
          <option value="no-headshot">Missing headshot</option>
          <option value="no-overview">Missing overview</option>
          <option value="has-coi">Has COI to review</option>
        </select>
      </div>

      <div className="mb-4 flex flex-col gap-1">
        <label htmlFor="dq-overview-age" className="text-muted-foreground text-xs">
          Overview last updated
        </label>
        <select
          id="dq-overview-age"
          name="overviewAge"
          defaultValue={overviewAge}
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

      <label className="mb-5 flex items-center gap-2 text-sm" htmlFor="dq-hidden">
        <input
          id="dq-hidden"
          type="checkbox"
          name="hidden"
          value="0"
          defaultChecked={!includeHidden}
          className="size-4"
        />
        Hide students &amp; alumni
      </label>

      {/* Facet selections submit as repeated params via these hidden inputs. */}
      {[...selRoles].map((v) => (
        <input key={`r-${v}`} type="hidden" name="type" value={v} />
      ))}
      {[...selUnits].map((v) => (
        <input key={`u-${v}`} type="hidden" name="unit" value={v} />
      ))}

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
