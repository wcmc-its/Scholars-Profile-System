/**
 * The ORCID coverage filter bar: one sticky row of dropdown filters (NIH
 * funding, person type, department, center, institution), the active
 * selections as removable chips beneath it, and "Clear all".
 *
 * A client island for the popovers only. Every change navigates to the new
 * `?type=…&unit=…&nih=…` and the server recomputes; `nih` is always sent, so
 * an empty type selection means "every type", not the bare-visit default
 * (`orcidCoverageQuery` in lib/edit/orcid-coverage — mirrored here because
 * that module pulls Prisma into the client bundle).
 *
 * Campus is a three-way choice: Weill Cornell Medicine (the default, no
 * `campus` param), Cornell Ithaca, or Both (`campus=all`; the option's own value
 * is "both" because `FacetPopover` reads a single-select "all" as "nothing
 * selected"). NIH funding and the unit facets are WCM concepts: hidden on
 * Cornell Ithaca, and on Both they narrow the WCM half only. Person type offers
 * the six Cornell Ithaca roles whenever Ithaca people are in view.
 */
"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { FacetPopover, type FacetDef } from "@/components/edit/facet-popover";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import type { CampusView, NihFilter } from "@/lib/edit/orcid-coverage";
import { ITHACA_ROLES } from "@/lib/eligibility";
import { formatRoleCategory } from "@/lib/role-display";

type Sel = { nih: NihFilter; types: string[]; units: string[]; campus?: CampusView };

const BOTH = "Narrows both tables.";
const WCM_HALF = "Narrows Weill Cornell Medicine only, in both tables.";

const isIthacaRole = (t: string) => (ITHACA_ROLES as readonly string[]).includes(t);
/** The Cornell Ithaca person types, in roster order. No counts: the facet load is WCM's. */
const ITHACA_TYPE_OPTIONS = ITHACA_ROLES.map((value) => ({
  value,
  label: formatRoleCategory(value) ?? value,
  count: -1,
}));

function query(s: Sel) {
  const q = new URLSearchParams();
  for (const t of s.types) q.append("type", t);
  for (const u of s.units) q.append("unit", u);
  q.set("nih", s.nih);
  if (s.campus === "ithaca" || s.campus === "all") q.set("campus", s.campus);
  return `?${q.toString()}`;
}

export function CoverageFilterBar({
  facets,
  initial,
  nihOptions,
}: {
  facets: DataQualityFacets;
  initial: Sel;
  /** NIH filter values and labels, "all" first. */
  nihOptions: Array<{ value: NihFilter; label: string }>;
}) {
  const router = useRouter();
  const [sel, setSel] = React.useState<Sel>(initial);
  const [, startTransition] = React.useTransition();

  const apply = (next: Sel) => {
    setSel(next);
    startTransition(() => router.replace(`/edit/orcid-coverage${query(next)}`, { scroll: false }));
  };

  const units = new Set(sel.units);
  // Departments largest-first, THEN divisions (a division's label names its parent).
  const deptOptions = [
    ...facets.departments,
    ...facets.departments
      .flatMap((d) => d.divisions)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ];
  const ithaca = sel.campus === "ithaca";
  const wcmScope = sel.campus === "all" ? WCM_HALF : BOTH;
  const allDefs: FacetDef[] = [
    {
      key: "campus",
      label: "Campus",
      single: true,
      options: [
        { value: "wcm", label: "Weill Cornell Medicine", count: -1 },
        { value: "ithaca", label: "Cornell Ithaca", count: -1 },
        { value: "both", label: "Both", count: -1 },
      ],
      scope: BOTH,
    },
    {
      key: "nih",
      label: "NIH funding",
      single: true,
      options: nihOptions.map(({ value, label }) => ({ value, label, count: -1 })),
      scope: wcmScope,
    },
    {
      key: "type",
      label: "Person type",
      options: ithaca
        ? ITHACA_TYPE_OPTIONS
        : sel.campus === "all"
          ? [...facets.roleCategories, ...ITHACA_TYPE_OPTIONS]
          : facets.roleCategories,
      scope: "Narrows the department table only.",
    },
    {
      key: "dept",
      label: "Department",
      options: deptOptions,
      search: `Search ${deptOptions.length} departments and divisions`,
      scope: wcmScope,
    },
    {
      key: "center",
      label: "Center",
      // A memberless center can only return zero — hidden unless already selected.
      options: facets.centers.filter((c) => c.count > 0 || units.has(c.value)),
      search: `Search ${facets.centers.length} centers`,
      scope: wcmScope,
    },
    {
      key: "inst",
      label: "Institution",
      options: facets.institutions,
      search: `Search ${facets.institutions.length} institutions`,
      scope: wcmScope,
    },
  ];
  // NIH awards and WCM org units do not exist for Cornell Ithaca people.
  const defs = ithaca
    ? allDefs.filter((d) => d.key === "campus" || d.key === "type")
    : allDefs;

  const selected = (d: FacetDef): string[] =>
    d.key === "campus"
      ? sel.campus === "ithaca"
        ? ["ithaca"]
        : sel.campus === "all"
          ? ["both"]
          : []
      : d.key === "nih"
        ? sel.nih === "all"
          ? []
          : [sel.nih]
        : d.key === "type"
          ? sel.types
          : sel.units.filter((u) => d.options.some((o) => o.value === u));
  /** A campus switch keeps only the selections that still mean something there. */
  const toCampus = (campus: CampusView): Sel =>
    campus === "ithaca"
      ? { nih: "all", units: [], types: sel.types.filter(isIthacaRole), campus }
      : campus === "wcm"
        ? { ...sel, types: sel.types.filter((t) => !isIthacaRole(t)), campus }
        : { ...sel, campus };
  const toggle = (d: FacetDef, value: string) => {
    if (d.key === "campus")
      return apply(toCampus(value === "ithaca" ? "ithaca" : value === "both" ? "all" : "wcm"));
    if (d.key === "nih") return apply({ ...sel, nih: value as NihFilter });
    const list = d.key === "type" ? sel.types : sel.units;
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    apply(d.key === "type" ? { ...sel, types: next } : { ...sel, units: next });
  };
  const clear = (d: FacetDef) => {
    if (d.key === "campus") return apply(toCampus("wcm"));
    if (d.key === "nih") return apply({ ...sel, nih: "all" });
    if (d.key === "type") return apply({ ...sel, types: [] });
    const mine = new Set(d.options.map((o) => o.value));
    apply({ ...sel, units: sel.units.filter((u) => !mine.has(u)) });
  };

  const labelOf = (d: FacetDef, v: string) => d.options.find((o) => o.value === v)?.label ?? v;
  const chips = defs.flatMap((d) => selected(d).map((v) => ({ d, v, label: labelOf(d, v) })));
  const onlyType = chips.length > 0 && chips.every((c) => c.d.key === "type");

  return (
    <div
      className="bg-apollo-page border-apollo-border sticky top-14 z-20 -mx-6 flex flex-col gap-2.5 border-y px-6 py-3"
      data-testid="orcid-coverage-filters"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground mr-0.5 text-[13px]">Filter</span>
        {defs.map((d) => (
          <FacetPopover
            key={d.key}
            def={d}
            selected={selected(d)}
            onToggle={(v) => toggle(d, v)}
            onClear={() => clear(d)}
            valueLabel={(v) => labelOf(d, v)}
          />
        ))}
        {chips.length > 0 ? (
          <button
            type="button"
            onClick={() => apply({ nih: "all", types: [], units: [] })}
            className="text-apollo-slate h-[34px] px-1.5 text-[13px]"
            data-testid="orcid-coverage-clear-all"
          >
            Clear all
          </button>
        ) : null}
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="orcid-coverage-chips">
          {chips.map(({ d, v, label }) => (
            <span
              key={`${d.key}:${v}`}
              className="border-apollo-border-strong bg-apollo-surface inline-flex h-[26px] items-center gap-1 rounded-full border pr-1 pl-2.5 text-[12.5px] whitespace-nowrap"
            >
              <span className="text-muted-foreground">{d.label}</span> {label}
              <button
                type="button"
                onClick={() => (d.single ? clear(d) : toggle(d, v))}
                aria-label={`Remove ${d.label}: ${label}`}
                className="text-muted-foreground hover:bg-apollo-surface-2 hover:text-foreground flex size-5 items-center justify-center rounded-full"
              >
                <X className="size-[11px]" strokeWidth={2.6} aria-hidden />
              </button>
            </span>
          ))}
          <span className="text-muted-foreground ml-1.5 min-w-0 flex-[1_1_260px] text-[12.5px]">
            {onlyType
              ? "Person type applies to the department table only."
              : "Person type applies to the department table only; other filters apply to both."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
