"use client";

/**
 * Neutral, presentational master-detail rail (the shared core of the supercategory
 * `FamilyRail` and the family-page cell-line rail). It owns its own text filter and
 * renders rows = a bold (when active) title + an optional descriptor line BENEATH
 * it + a right-aligned `tabular-nums` count stacked over a caption ("pubs"/"papers").
 *
 * It is intentionally copy-agnostic and field-agnostic: callers map their own item
 * shape onto the generic `RailItem` and supply the rail's aria label, header text,
 * filter placeholder, and no-match noun. The visual contract (#172 selected state:
 * 3px WCM-red left border + warm-neutral fill + weight; the `line-clamp-1` — NOT
 * `truncate` — descriptor that keeps the count from clipping inside the Radix
 * ScrollArea viewport) is preserved verbatim from the original `FamilyRail` so the
 * supercategory page is byte-for-byte unchanged.
 *
 * Selection is master-detail: `onSelect(activeId === id ? null : id)` TOGGLES, so
 * clicking the active row clears the selection (the in-rail "all work" path). Rows
 * may be non-interactive (`item.interactive === false`) — rendered as plain labels
 * that can't be selected (e.g. a non-evidenced cell line that would yield an empty
 * feed). Items arrive pre-sorted.
 */
import { useState, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export type RailItem = {
  /** Opaque selection id — the value passed to `onSelect`. */
  id: string;
  /** Row title. */
  label: string;
  /** Optional descriptor rendered on its own line beneath the title. */
  descriptor?: string | null;
  /** The visible right-side number. */
  count: number;
  /** Caption beneath the count (defaults to "pubs"). */
  countLabel?: string;
  /** Accessible label for the count span (defaults to `${count} ${countLabel}`). */
  ariaLabel?: string;
  /** When false, the row is a plain non-clickable label (no toggle, no role). */
  interactive?: boolean;
};

export function EntityRail({
  items,
  activeId,
  onSelect,
  railLabel,
  headerText,
  filterPlaceholder,
  noMatchNoun,
}: {
  items: RailItem[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** `aria-label` for the rail landmark. */
  railLabel: string;
  /** Uppercase header text (e.g. `FAMILIES (12)`). */
  headerText: string;
  /** Filter input placeholder. */
  filterPlaceholder: string;
  /** Noun for the empty-filter message (e.g. "families", "cell lines"). */
  noMatchNoun: string;
}) {
  const [filter, setFilter] = useState("");
  const filterLower = filter.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!filterLower) return items;
    return items.filter((it) => it.label.toLowerCase().includes(filterLower));
  }, [items, filterLower]);

  const handleClick = useCallback(
    (id: string) => {
      onSelect(activeId === id ? null : id);
    },
    [activeId, onSelect],
  );

  return (
    <aside className="w-full" aria-label={railLabel}>
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {headerText}
      </div>
      <div className="relative mb-3">
        <Input
          type="text"
          placeholder={filterPlaceholder}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pr-8"
        />
        {filter.length > 0 && (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setFilter("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="py-4 text-center text-sm italic text-muted-foreground">
          No {noMatchNoun} match &ldquo;{filter}&rdquo;
        </div>
      ) : (
        <ScrollArea className="h-full">
          <ul className="flex flex-col">
            {visible.map((it, i) => {
              const isActive = activeId === it.id;
              const showHairline = i > 0;
              const interactive = it.interactive !== false;
              const descriptor = it.descriptor;

              // The shared row body: title + (optional) descriptor + right count.
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-base leading-snug">{it.label}</div>
                    {descriptor && (
                      // line-clamp-1 (NOT `truncate`): clips to one line with an
                      // ellipsis but does NOT set white-space:nowrap. Inside the
                      // rail's Radix ScrollArea (a shrink-to-fit `display:table`
                      // viewport), a nowrap line expands the row to the full
                      // un-truncated width and pushes the count off the right
                      // edge — the original "count clipped" bug. Wrappable content
                      // keeps the row capped at the rail width so the count shows.
                      <div className="mt-0.5 line-clamp-1 text-xs font-normal text-muted-foreground">
                        {descriptor}
                      </div>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-right tabular-nums ${
                      isActive ? "text-foreground" : "text-muted-foreground"
                    }`}
                    aria-label={
                      it.ariaLabel ??
                      `${it.count.toLocaleString()} ${it.countLabel ?? "pubs"}`
                    }
                  >
                    <span className="block text-sm font-medium leading-none">
                      {it.count.toLocaleString()}
                    </span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground/80">
                      {it.countLabel ?? "pubs"}
                    </span>
                  </span>
                </>
              );

              return (
                <li key={it.id}>
                  {interactive ? (
                    <button
                      type="button"
                      onClick={() => handleClick(it.id)}
                      // #172 selected state: 3px WCM-red left border + warm neutral
                      // fill + text weight. Unselected rows reserve the same gutter
                      // via a transparent border so selection doesn't shift layout.
                      className={`flex w-full items-start justify-between gap-2 rounded px-3 py-2.5 text-left border-l-[3px] ${
                        showHairline ? "border-t border-t-[#f0f1f3]" : ""
                      } ${
                        isActive
                          ? "border-l-[var(--color-primary-cornell-red)] bg-[#f5f4f0] font-semibold"
                          : "border-l-transparent hover:bg-[#f5f6f8]"
                      }`}
                      aria-current={isActive ? "true" : undefined}
                    >
                      {body}
                    </button>
                  ) : (
                    // Non-interactive row: a plain, non-clickable label. Reserves the
                    // same 3px gutter (transparent) + hairline so it sits flush with
                    // clickable rows, but has no role/onClick — it can't be selected
                    // and so can't drive an empty feed (#1 non-evidenced dead-end).
                    <div
                      className={`flex w-full items-start justify-between gap-2 rounded px-3 py-2.5 text-left border-l-[3px] border-l-transparent ${
                        showHairline ? "border-t border-t-[#f0f1f3]" : ""
                      }`}
                    >
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </aside>
  );
}
