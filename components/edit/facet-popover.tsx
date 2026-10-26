/**
 * One filter dropdown: a trigger showing the selection, and a popover of
 * checkbox (or radio, `single`) options with an optional search box, the
 * facet's scope note and "Clear". Shared by the ORCID coverage filter bar
 * (`app/edit/orcid-coverage/filter-bar.tsx`) and the ORCID queue's
 * (`components/edit/orcid-queue-filter-bar.tsx`).
 */
"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataQualityFacetOption } from "@/lib/api/data-quality";
import { cn } from "@/lib/utils";

/** One dropdown's definition. */
export type FacetDef = {
  key: string;
  label: string;
  options: DataQualityFacetOption[];
  single?: boolean;
  search?: string;
  scope: string;
};

export function FacetPopover({
  def,
  selected,
  onToggle,
  onClear,
  valueLabel,
  testIdPrefix = "orcid-coverage-filter",
}: {
  def: FacetDef;
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  valueLabel: (value: string) => string;
  testIdPrefix?: string;
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
        data-testid={`${testIdPrefix}-${def.key}`}
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
                  {checked && def.single ? (
                    <span className="size-1.5 rounded-full bg-white" />
                  ) : null}
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
