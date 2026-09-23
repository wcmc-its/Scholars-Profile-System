"use client";

/**
 * Report 8's person-type and unit facets — the Profiles roster's own
 * (`components/edit/profiles-filters.tsx`): `RosterFacet` typeaheads for
 * "Person type", "Department / division", "Centers" and "Institution", over
 * the same `loadDataQualityFacets` options and the same `type` / `unit`
 * params. Rendered INSIDE the report's `AutoSubmitForm`, so the selection
 * rides along as hidden inputs and a toggle submits the form.
 *
 * Two things keep the surrounding form honest: every `change` from inside
 * this island (the facet search boxes) stops here, so typing a search never
 * submits, and a toggle submits only in the effect AFTER React has written
 * the new hidden inputs — submitting from the click itself would send the
 * old selection. Enter in a facet search box is swallowed for the same
 * reason. Type-only import from `lib/api/data-quality`; nothing here reaches
 * `@/lib/db`.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import type { DataQualityFacets } from "@/lib/api/data-quality";

export function ArticleCountFacets({
  facets,
  types,
  units,
}: {
  facets: DataQualityFacets;
  /** Applied person types (raw roleCategory). */
  types: string[];
  /** Applied unit values (`dept:CODE` / `div:CODE` / `center:CODE` / `inst:CODE`). */
  units: string[];
}) {
  const [selTypes, setSelTypes] = useState<ReadonlySet<string>>(() => new Set(types));
  const [selUnits, setSelUnits] = useState<ReadonlySet<string>>(() => new Set(units));
  const dirty = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dirty.current) return;
    dirty.current = false;
    root.current?.closest("form")?.requestSubmit();
  }, [selTypes, selUnits]);

  const toggle = (set: ReadonlySet<string>, setter: (s: ReadonlySet<string>) => void) => (value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    dirty.current = true;
    setter(next);
  };
  const toggleType = toggle(selTypes, setSelTypes);
  const toggleUnit = toggle(selUnits, setSelUnits);

  // Same flat list as Profiles: departments largest-first, THEN divisions
  // largest-first (a division's label already names its parent).
  const unitOptions = useMemo<FacetOption[]>(() => {
    const depts = facets.departments.map(({ value, label, count }) => ({ value, label, count }));
    const divs = facets.departments
      .flatMap((d) => d.divisions)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return [...depts, ...divs];
  }, [facets.departments]);
  // A memberless center can only return zero — hidden unless already selected.
  const centerOptions = facets.centers.filter((c) => c.count > 0 || selUnits.has(c.value));

  return (
    <div
      ref={root}
      data-testid="article-count-facets"
      onChange={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      {[...selTypes].map((t) => (
        <input key={`type-${t}`} type="hidden" name="type" value={t} />
      ))}
      {[...selUnits].map((u) => (
        <input key={`unit-${u}`} type="hidden" name="unit" value={u} />
      ))}
      <RosterFacet
        title="Person type"
        options={facets.roleCategories}
        selected={selTypes}
        onToggle={toggleType}
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
        options={facets.institutions}
        selected={selUnits}
        onToggle={toggleUnit}
        collapseAfter={10}
        searchable
        searchPlaceholder="Search institutions…"
        noMatchLabel="No institutions match"
      />
    </div>
  );
}
