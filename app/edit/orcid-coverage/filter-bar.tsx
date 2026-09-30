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

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataQualityFacetOption, DataQualityFacets } from "@/lib/api/data-quality";
import type { NihFilter } from "@/lib/edit/orcid-coverage";
import { cn } from "@/lib/utils";

type Sel = { nih: NihFilter; types: string[]; units: string[] };

type FacetDef = {
  key: "nih" | "type" | "dept" | "center" | "inst";
  label: string;
  options: DataQualityFacetOption[];
  single?: boolean;
  search?: string;
  scope: string;
};

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

function FacetPopover({
  def,
  selected,
  onToggle,
  onClear,
  valueLabel,
}: {
  def: FacetDef;
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  valueLabel: (value: string) => string;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const active = selected.length > 0;
  const value =
    selected.length === 0
      ? ""
      : selected.length === 1
        ? valueLabel(selected[0])
        : `${selected.length} selected`;
  const ql = q.trim().toLowerCase();
  const options = def.options.filter((o) => !ql || o.label.toLowerCase().includes(ql));
  const on = (v: string) => (def.single && v === "all" ? !active : selected.includes(v));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setQ("");
      }}
    >
      <PopoverTrigger
        className={cn(
          "bg-apollo-surface text-foreground inline-flex h-[34px] items-center gap-1.5 rounded-lg border pr-2.5 pl-3 text-[13.5px] whitespace-nowrap",
          active ? "border-apollo-slate" : "border-apollo-border-strong",
        )}
        data-testid={`orcid-coverage-filter-${def.key}`}
      >
        <span className={active ? "text-muted-foreground" : undefined}>
          {value ? `${def.label}:` : def.label}
        </span>
        {value ? <span className="max-w-[16rem] truncate font-semibold">{value}</span> : null}
        <ChevronDown className="size-3.5" strokeWidth={2.4} aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="border-apollo-border-strong bg-apollo-surface flex w-[min(340px,calc(100vw-32px))] flex-col rounded-[10px] p-0"
      >
        {def.search ? (
          <div className="px-2.5 pt-2.5 pb-1.5">
            <label className="border-apollo-border-strong bg-apollo-surface flex h-[34px] items-center gap-2 rounded-[7px] border px-2.5">
              <Search className="text-muted-foreground size-3.5 flex-none" aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={def.search}
                aria-label={def.search}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
              />
            </label>
          </div>
        ) : null}
        <div
          className="max-h-80 overflow-auto py-1"
          role={def.single ? "radiogroup" : "group"}
          aria-label={def.label}
        >
          {options.map((o) => {
            const checked = on(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role={def.single ? "radio" : "checkbox"}
                aria-checked={checked}
                onClick={() => {
                  onToggle(o.value);
                  if (def.single) setOpen(false);
                }}
                className="hover:bg-apollo-surface-2 flex w-full items-start gap-2.5 px-3 py-[7px] text-left text-[13.5px]"
              >
                <span
                  className={cn(
                    "mt-px flex size-4 flex-none items-center justify-center border-[1.5px]",
                    def.single ? "rounded-full" : "rounded",
                    checked
                      ? "border-[var(--color-primary-cornell-red)] bg-[var(--color-primary-cornell-red)]"
                      : "border-apollo-border-strong bg-apollo-surface",
                  )}
                  aria-hidden
                >
                  {checked && def.single ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  {checked && !def.single ? (
                    <Check className="size-[11px] text-white" strokeWidth={3.5} />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 leading-[1.35] text-pretty">{o.label}</span>
                {o.count >= 0 ? (
                  <span className="text-muted-foreground flex-none text-[13px] tabular-nums">
                    {o.count.toLocaleString()}
                  </span>
                ) : null}
              </button>
            );
          })}
          {options.length === 0 ? (
            <div className="text-muted-foreground px-3 py-2.5 text-[13px]">No matches</div>
          ) : null}
        </div>
        <div className="border-apollo-border text-muted-foreground flex items-center gap-2 border-t px-3 py-2 text-[12.5px]">
          <span className="flex-1 leading-snug text-pretty">{def.scope}</span>
          {active ? (
            <button type="button" onClick={onClear} className="text-apollo-slate font-medium">
              Clear
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
