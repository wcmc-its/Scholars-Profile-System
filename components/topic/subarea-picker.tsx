"use client";

/**
 * "Subarea ▾" picker on /topics/{slug}/scholars: every subarea with its
 * publication count, sortable A–Z or by count. Each option is a plain link, so
 * the filter stays URL state. No db imports: this module is client-bundled.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type SubareaOption = { id: string; label: string; pubCount: number; href: string };

export function SubareaPicker({
  options,
  allHref,
  selected,
}: {
  options: SubareaOption[];
  allHref: string;
  selected: string | null;
}) {
  const [sort, setSort] = useState<"count" | "alpha">("count");
  const rows = [...options].sort(
    sort === "alpha" ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.pubCount - a.pubCount,
  );
  const current = options.find((o) => o.id === selected);
  const all = { id: "", label: "All subareas", pubCount: options.reduce((n, o) => n + o.pubCount, 0), href: allHref };
  return (
    <Popover>
      <PopoverTrigger className="border-apollo-border-strong bg-apollo-surface flex h-[38px] max-w-[380px] min-w-0 items-center gap-2 rounded-lg border pr-2.5 pl-3 text-sm">
        <span className="text-muted-foreground whitespace-nowrap">Subarea</span>
        <span className="min-w-0 truncate">{current?.label ?? "All subareas"}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(380px,calc(100vw-32px))] rounded-[10px] p-0">
        <div className="border-apollo-border flex items-center gap-2.5 border-b px-3 py-2.5">
          <span className="text-muted-foreground text-[12.5px]">Sort</span>
          <div className="bg-apollo-surface-2 flex rounded-[7px] p-0.5" role="group" aria-label="Sort subareas">
            {(
              [
                ["alpha", "A–Z"],
                ["count", "Most publications"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                aria-pressed={sort === k}
                onClick={() => setSort(k)}
                className="rounded-[5px] px-2.5 py-1 text-[12.5px] aria-pressed:bg-white aria-pressed:font-semibold aria-pressed:shadow-sm"
              >
                {l}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground ml-auto text-xs">Publications</span>
        </div>
        <ul className="max-h-[360px] overflow-auto py-1">
          {[all, ...rows].map((o) => {
            const on = (o.id || null) === selected;
            return (
              <li key={o.id || "all"}>
                <a
                  href={o.href}
                  aria-current={on ? "true" : undefined}
                  className={`hover:bg-apollo-surface-2 flex items-baseline gap-2.5 px-3 py-[7px] text-[13.5px] ${on ? "bg-apollo-surface-2 font-semibold" : ""}`}
                >
                  <span className="min-w-0 flex-1 leading-[1.35] text-pretty">{o.label}</span>
                  <span className="text-muted-foreground shrink-0 text-[13px] font-normal tabular-nums">
                    {o.pubCount.toLocaleString()}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
