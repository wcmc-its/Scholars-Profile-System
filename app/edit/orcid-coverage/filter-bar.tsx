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
 */
"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { FacetPopover, type FacetDef } from "@/components/edit/facet-popover";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import type { NihFilter } from "@/lib/edit/orcid-coverage";

type Sel = { nih: NihFilter; types: string[]; units: string[] };

const BOTH = "Narrows both tables.";

function query(s: Sel) {
  const q = new URLSearchParams();
  for (const t of s.types) q.append("type", t);
  for (const u of s.units) q.append("unit", u);
  q.set("nih", s.nih);
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
  const defs: FacetDef[] = [
    {
      key: "nih",
      label: "NIH funding",
      single: true,
      options: nihOptions.map(({ value, label }) => ({ value, label, count: -1 })),
      scope: BOTH,
    },
    {
      key: "type",
      label: "Person type",
      options: facets.roleCategories,
      scope: "Narrows the department table only.",
    },
    {
      key: "dept",
      label: "Department",
      options: deptOptions,
      search: `Search ${deptOptions.length} departments and divisions`,
      scope: BOTH,
    },
    {
      key: "center",
      label: "Center",
      // A memberless center can only return zero — hidden unless already selected.
      options: facets.centers.filter((c) => c.count > 0 || units.has(c.value)),
      search: `Search ${facets.centers.length} centers`,
      scope: BOTH,
    },
    {
      key: "inst",
      label: "Institution",
      options: facets.institutions,
      search: `Search ${facets.institutions.length} institutions`,
      scope: BOTH,
    },
  ];

  const selected = (d: FacetDef): string[] =>
    d.key === "nih"
      ? sel.nih === "all"
        ? []
        : [sel.nih]
      : d.key === "type"
        ? sel.types
        : sel.units.filter((u) => d.options.some((o) => o.value === u));
  const toggle = (d: FacetDef, value: string) => {
    if (d.key === "nih") return apply({ ...sel, nih: value as NihFilter });
    const list = d.key === "type" ? sel.types : sel.units;
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    apply(d.key === "type" ? { ...sel, types: next } : { ...sel, units: next });
  };
  const clear = (d: FacetDef) => {
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
                onClick={() => toggle(d, d.key === "nih" ? "all" : v)}
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
