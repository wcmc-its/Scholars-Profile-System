"use client";

/**
 * The one master-detail rail shared by the topic page (subareas), the method
 * category page (families) and the method family page (cell lines / specific
 * entities). It replaces `SubtopicRail`, `EntityRail`, `FamilyRail` and
 * `CellLineRail`; each page maps its own item shape onto `TaxonomyRailItem` and
 * supplies copy through props (see the adapters next to each page's layout).
 *
 * Two row styles, both kept byte-for-byte from the rails they replace:
 *
 *   - `plain` (subareas): the label wraps (`break-words`), the count sits inline
 *     and vertically centered; rows at or under `lessCommonThreshold` fade to
 *     `opacity-60` and a "Less common" divider opens that run.
 *   - `captioned` (families, entities): the label clamps to two lines with an
 *     optional descriptor line beneath it, and the count stacks over a caption
 *     ("pubs" / "papers") with an accessible label.
 *
 * Selection (#172): 3px WCM-red left border + warm-neutral fill + weight on the
 * active row; unselected rows reserve the same 3px gutter with a transparent
 * border so selecting never shifts layout. Clicking the active row TOGGLES it
 * off (`onSelect(null)`). The optional "All …" row is the explicit way back: it
 * is current when nothing is selected and selecting it calls `onSelect(null)`.
 * It is hidden while the filter has text (the mockup's behavior), since it is
 * not a filter match.
 *
 * `interactive: false` items render as plain labels with no button (a cell line
 * with no verbatim usage evidence, or a generic bucket, would drive an empty
 * feed — #1166 punch #1 / #1168 WS-B).
 *
 * The filter text can be controlled (`filter` + `onFilterChange`) so the
 * desktop rail and the mobile sheet copy share one filter state; uncontrolled
 * use keeps its own. `size="touch"` (the mobile sheet copy) gives rows a 44px
 * minimum height and the filter's clear button a 44px hit area; `idSuffix`
 * keeps element ids unique when two copies of the rail exist at once.
 */
import { useState, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

export type TaxonomyRailItem = {
  /** Opaque selection id, the value passed to `onSelect`. */
  id: string;
  /** Row title. */
  label: string;
  /** Optional descriptor line beneath the title (`captioned` rows only). */
  descriptor?: string | null;
  /** The visible right-side number. */
  count: number;
  /** Caption beneath the count (`captioned` rows only; defaults to "pubs"). */
  countLabel?: string;
  /** Accessible label for the count span. `captioned` rows default to
   *  `${count} ${countLabel}`; `plain` rows carry none unless given. */
  ariaLabel?: string;
  /** When false, the row is a plain non-clickable label (no toggle, no role). */
  interactive?: boolean;
};

export type TaxonomyRailAllRow = {
  /** e.g. "All subareas". */
  label: string;
  /** Total shown on the row; omitted when no honest total exists. */
  count?: number | null;
  /** Caption beneath the count (`captioned` rows only). */
  countLabel?: string;
};

export type TaxonomyRailProps = {
  items: TaxonomyRailItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** `aria-label` for the rail landmark. */
  railLabel: string;
  /** Uppercase header text (e.g. `SUBAREAS (12)`). */
  headerText: string;
  /** Filter input placeholder. */
  filterPlaceholder: string;
  /** Render the filter input (default true). Off for short, non-filterable
   *  rails; `filter` is then ignored and every item shows. */
  showFilter?: boolean;
  /** Noun for the empty-filter message (e.g. "subareas", "cell lines"). */
  noMatchNoun: string;
  /** Optional "All …" row above the items. */
  allRow?: TaxonomyRailAllRow;
  /** Rows with `count <= threshold` get the "Less common" treatment. Items must
   *  arrive sorted DESC by count for the divider to land in one place. */
  lessCommonThreshold?: number;
  variant?: "plain" | "captioned";
  size?: "default" | "touch";
  /** Controlled filter text (pair with `onFilterChange`). */
  filter?: string;
  onFilterChange?: (value: string) => void;
  /** Appended to element ids so two copies can coexist on one page. */
  idSuffix?: string;
};

export function TaxonomyRail({
  items,
  selectedId,
  onSelect,
  railLabel,
  headerText,
  filterPlaceholder,
  showFilter = true,
  noMatchNoun,
  allRow,
  lessCommonThreshold,
  variant = "plain",
  size = "default",
  filter: controlledFilter,
  onFilterChange,
  idSuffix = "",
}: TaxonomyRailProps) {
  const [ownFilter, setOwnFilter] = useState("");
  const filter = showFilter ? (controlledFilter ?? ownFilter) : "";
  const setFilter = onFilterChange ?? setOwnFilter;
  const filterLower = filter.trim().toLowerCase();
  const touch = size === "touch";
  const captioned = variant === "captioned";

  const visible = useMemo(() => {
    if (!filterLower) return items;
    return items.filter((it) => it.label.toLowerCase().includes(filterLower));
  }, [items, filterLower]);

  const isLessCommon = useCallback(
    (count: number) => lessCommonThreshold !== undefined && count <= lessCommonThreshold,
    [lessCommonThreshold],
  );

  // First visible index at or under the threshold (items pre-sorted DESC).
  const lessCommonIndex = useMemo(() => {
    if (lessCommonThreshold === undefined) return -1;
    return visible.findIndex((it) => it.count <= lessCommonThreshold);
  }, [visible, lessCommonThreshold]);

  const handleClick = useCallback(
    (id: string) => {
      onSelect(selectedId === id ? null : id);
    },
    [selectedId, onSelect],
  );

  const showAllRow = allRow !== undefined && filterLower.length === 0;

  const rowBase = `flex w-full ${captioned ? "items-start" : "items-center"} justify-between gap-2 rounded px-3 py-2.5 text-left border-l-[3px]${
    touch ? " min-h-11" : ""
  }`;
  const rowState = (isActive: boolean, dim: boolean) =>
    isActive
      ? "border-l-[var(--color-primary-cornell-red)] bg-[#f5f4f0] font-semibold"
      : `border-l-transparent hover:bg-[#f5f6f8]${dim ? " opacity-60" : ""}`;

  const renderCount = (
    count: number,
    isActive: boolean,
    countLabel: string | undefined,
    ariaLabel: string | undefined,
  ) =>
    captioned ? (
      <span
        className={`shrink-0 text-right tabular-nums ${
          isActive ? "text-foreground" : "text-muted-foreground"
        }`}
        aria-label={ariaLabel ?? `${count.toLocaleString()} ${countLabel ?? "pubs"}`}
      >
        <span className="block text-sm leading-none font-medium">{count.toLocaleString()}</span>
        <span className="text-muted-foreground/80 mt-0.5 block text-[10px] tracking-wide uppercase">
          {countLabel ?? "pubs"}
        </span>
      </span>
    ) : (
      <span
        className={`shrink-0 self-center text-sm tabular-nums ${
          isActive ? "text-foreground" : "text-muted-foreground"
        }`}
        aria-label={ariaLabel}
      >
        {count.toLocaleString()}
      </span>
    );

  const renderBody = (it: TaxonomyRailItem, isActive: boolean) => (
    <>
      <div className="min-w-0 flex-1">
        {captioned ? (
          <div className="line-clamp-2 text-base leading-snug [overflow-wrap:anywhere]">
            {it.label}
          </div>
        ) : (
          <div className="text-base leading-snug [overflow-wrap:anywhere] break-words">
            {it.label}
          </div>
        )}
        {captioned && it.descriptor && (
          // line-clamp-1 (NOT `truncate`): clips to one line with an ellipsis
          // but does NOT set white-space:nowrap. Inside the rail's Radix
          // ScrollArea (a shrink-to-fit `display:table` viewport), a nowrap
          // line expands the row to the full un-truncated width and pushes the
          // count off the right edge (the original "count clipped" bug).
          <div className="text-muted-foreground mt-0.5 line-clamp-1 text-xs font-normal">
            {it.descriptor}
          </div>
        )}
      </div>
      {renderCount(it.count, isActive, it.countLabel, it.ariaLabel)}
    </>
  );

  const filterId = `taxonomy-rail-filter${idSuffix}`;

  return (
    <aside className="w-full" aria-label={railLabel}>
      <div className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">
        {headerText}
      </div>
      {showFilter && (
        <div className="relative mb-3">
          <Input
            id={filterId}
            type="text"
            aria-label={filterPlaceholder.replace(/…$/, "")}
            placeholder={filterPlaceholder}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={touch ? "pr-11" : "pr-8"}
          />
          {filter.length > 0 && (
            <button
              type="button"
              aria-label="Clear filter"
              aria-controls={filterId}
              onClick={() => setFilter("")}
              className={
                touch
                  ? "text-muted-foreground absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center"
                  : "text-muted-foreground absolute top-1/2 right-2 -translate-y-1/2"
              }
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="text-muted-foreground py-4 text-center text-sm italic">
          No {noMatchNoun} match &ldquo;{filter}&rdquo;
        </div>
      ) : (
        <ScrollArea className="h-full">
          <ul className="flex flex-col">
            {showAllRow && (
              <li>
                <button
                  type="button"
                  data-rail-all=""
                  onClick={() => onSelect(null)}
                  className={`${rowBase} ${rowState(selectedId === null, false)}`}
                  aria-current={selectedId === null ? "true" : undefined}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-base leading-snug break-words">{allRow.label}</div>
                  </div>
                  {typeof allRow.count === "number" &&
                    renderCount(allRow.count, selectedId === null, allRow.countLabel, undefined)}
                </button>
              </li>
            )}
            {visible.map((it, i) => {
              const isActive = selectedId === it.id;
              const interactive = it.interactive !== false;
              const showDivider = i === lessCommonIndex && lessCommonIndex > 0;
              // Hairline above every row except the first, and except the row
              // that carries the "Less common" separator (its own rule). The
              // "All …" row, when shown, counts as the first row.
              const showHairline = (i > 0 || showAllRow) && !showDivider;
              const hairline = showHairline ? " border-t border-t-[#f0f1f3]" : "";
              return (
                <li key={it.id}>
                  {showDivider && (
                    <div className="relative my-2 flex items-center">
                      <Separator className="flex-1" />
                      <span className="bg-background text-muted-foreground absolute left-1/2 -translate-x-1/2 px-2 text-sm italic">
                        Less common
                      </span>
                    </div>
                  )}
                  {interactive ? (
                    <button
                      type="button"
                      onClick={() => handleClick(it.id)}
                      className={`${rowBase}${hairline} ${rowState(isActive, isLessCommon(it.count))}`}
                      aria-current={isActive ? "true" : undefined}
                    >
                      {renderBody(it, isActive)}
                    </button>
                  ) : (
                    // Non-interactive row: reserves the same 3px gutter + hairline
                    // so it sits flush with clickable rows, but has no role/onClick.
                    <div className={`${rowBase} border-l-transparent${hairline}`}>
                      {renderBody(it, false)}
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
