"use client";

/**
 * The one two-column rail + results layout shared by the topic page (subareas),
 * the method category page (families) and the method family page (cell lines /
 * specific entities). It replaces `SubtopicPublicationLayout`,
 * `SupercategoryFamilyLayout` and the family page's inline master-detail.
 *
 * It owns:
 *   - the selection, seeded from the page's query param (`?subtopic=`,
 *     `?family=`, `?entity=`) on load and kept in sync with it, and WRITTEN back
 *     on every change with `history.replaceState` (no navigation, no scroll, no
 *     server round trip; Next syncs `useSearchParams` from it);
 *   - the scroll-once deep-link behavior (scroll the section into view once per
 *     distinct requested value, never for a value this layout just wrote);
 *   - the subhead (red kind eyebrow, the selected item's serif title + "Clear ×",
 *     then the body);
 *   - desktop (`lg`+): the sticky rail column (the selected row's spine is the
 *     only red connector; the panel has no rule of its own);
 *   - below `lg`: an in-flow trigger bar opening a left Sheet with the same
 *     rail (shared filter state). Picking closes the sheet, scrolls to and
 *     focuses the results region, and announces the change politely.
 *
 * Callers are the per-page client adapters (they may pass functions; the pages
 * themselves are server components and only pass data to the adapters).
 */
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ScrollFade } from "@/components/ui/scroll-fade";
import {
  TaxonomyRail,
  type TaxonomyRailAllRow,
  type TaxonomyRailItem,
} from "@/components/taxonomy/taxonomy-rail";
import { scrollIntoViewAndFocus } from "@/lib/scroll-focus";

export type RailLayoutSubhead = {
  title: string;
  /** Rendered under the title row (description, definition, links…). */
  body?: ReactNode;
};

export type RailLayoutProps = {
  items: TaxonomyRailItem[];
  /** Query-param name the selection lives in. */
  paramKey: string;
  /** Map a raw param value to a selectable item id (null = no selection).
   *  Defaults to an exact id match against `items`. */
  resolveParam?: (raw: string | null) => string | null;
  /** Map a selected id to the value written to the URL. Defaults to the id. */
  serializeParam?: (id: string) => string;
  /** Params dropped from the URL whenever the selection changes (e.g. "page"). */
  clearParamsOnChange?: string[];
  /** Fragment (without `#`) written with the param; keeps the current one when omitted. */
  urlHash?: string;
  /** Element id scrolled into view once per distinct deep-linked value. */
  deepLinkScrollTargetId?: string;
  /** Rail copy + options. */
  rail: {
    railLabel: string;
    headerText: string;
    filterPlaceholder: string;
    showFilter?: boolean;
    noMatchNoun: string;
    allRow?: TaxonomyRailAllRow;
    lessCommonThreshold?: number;
    variant?: "plain" | "captioned";
  };
  /** Mobile trigger copy. */
  mobile: {
    /** Eyebrow, e.g. "Subarea". Rendered uppercase. */
    eyebrow: string;
    /** Label shown when nothing is selected, e.g. "All subareas". */
    allLabel: string;
    /** Count shown when nothing is selected (omit when no honest total). */
    allCount?: number | null;
    /** Screen-reader unit read after the trigger's count. Default "publications". */
    countNoun?: string;
  };
  /** Prefix for the results region id (`${idPrefix}-results`). */
  idPrefix: string;
  /** Subhead for the selected item; null/undefined → no subhead (and no Clear). */
  renderSubhead?: (selectedId: string) => RailLayoutSubhead | null;
  /** The results panel. */
  children: (selectedId: string | null) => ReactNode;
};

export function RailLayout(props: RailLayoutProps) {
  // useSearchParams() forces a CSR bailout during prerender. Suspense lets the
  // static build emit the fallback and hydrate the full UI at request time.
  return (
    <Suspense fallback={null}>
      <RailLayoutInner {...props} />
    </Suspense>
  );
}

function RailLayoutInner({
  items,
  paramKey,
  resolveParam,
  serializeParam,
  clearParamsOnChange,
  urlHash,
  deepLinkScrollTargetId,
  rail,
  mobile,
  idPrefix,
  renderSubhead,
  children,
}: RailLayoutProps) {
  const searchParams = useSearchParams();
  const requested = searchParams.get(paramKey);
  const resolved = resolveParam
    ? resolveParam(requested)
    : requested && items.some((it) => it.id === requested)
      ? requested
      : null;

  const [selectedId, setSelectedId] = useState<string | null>(resolved);
  const [filter, setFilter] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);
  const sheetBodyRef = useRef<HTMLDivElement>(null);
  const focusResultsOnCloseRef = useRef(false);

  // The sheet exists only below lg. If the viewport grows past lg while it is
  // open (an iPad rotating to landscape), `lg:hidden` hides the content but the
  // overlay, scroll lock and focus trap would stay, so close it instead.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (mq.matches) setSheetOpen(false);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Scroll the section into view when a deep-link resolves, once per distinct
  // requested value. The URL fragment alone is unreliable: links that set the
  // param without the fragment never scroll, and even with it the panel header
  // hydrates client-side, shifting layout after the browser's first scroll.
  // A value this layout wrote itself is pre-recorded in `lastScrolledRef` so a
  // rail click never scrolls.
  const lastScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    setSelectedId(resolved);
    if (resolved && deepLinkScrollTargetId && lastScrolledRef.current !== requested) {
      lastScrolledRef.current = requested;
      requestAnimationFrame(() => {
        document.getElementById(deepLinkScrollTargetId)?.scrollIntoView();
      });
    }
  }, [requested, resolved, deepLinkScrollTargetId]);

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      const value = id === null ? null : serializeParam ? serializeParam(id) : id;
      lastScrolledRef.current = value;
      try {
        const url = new URL(window.location.href);
        if (value === null) url.searchParams.delete(paramKey);
        else url.searchParams.set(paramKey, value);
        for (const p of clearParamsOnChange ?? []) url.searchParams.delete(p);
        if (urlHash !== undefined) url.hash = urlHash;
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      } catch {
        // URL sync is best-effort; the in-page selection already changed.
      }
    },
    [paramKey, serializeParam, clearParamsOnChange, urlHash],
  );

  // Clear × unmounts itself (the subhead goes away), so move focus to the
  // results region rather than letting it drop to <body>, and announce it.
  const clear = useCallback(() => {
    select(null);
    setAnnouncement(`Showing ${mobile.allLabel.toLowerCase()}`);
    resultsRef.current?.focus({ preventScroll: true });
  }, [select, mobile.allLabel]);

  const selectedItem = selectedId ? (items.find((it) => it.id === selectedId) ?? null) : null;

  const selectFromSheet = useCallback(
    (id: string | null) => {
      select(id);
      const item = id ? items.find((it) => it.id === id) : null;
      setAnnouncement(item ? `Showing ${item.label}` : `Showing ${mobile.allLabel.toLowerCase()}`);
      focusResultsOnCloseRef.current = true;
      setSheetOpen(false);
    },
    [select, items, mobile.allLabel],
  );

  const hasItems = items.length > 0;
  const subhead = selectedId && renderSubhead ? renderSubhead(selectedId) : null;
  const resultsId = `${idPrefix}-results`;

  const railProps = {
    items,
    selectedId,
    ...rail,
    filter,
    onFilterChange: setFilter,
  };

  const triggerLabel = selectedItem?.label ?? mobile.allLabel;
  const triggerCount = selectedItem ? selectedItem.count : mobile.allCount;

  return (
    <div className="mt-16">
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        {hasItems && (
          <div className="hidden lg:sticky lg:top-[84px] lg:block lg:w-[280px] lg:shrink-0 lg:self-start">
            <ScrollFade viewportClassName="lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
              <TaxonomyRail {...railProps} onSelect={select} />
            </ScrollFade>
          </div>
        )}
        {hasItems && (
          <div className="lg:hidden">
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger
                data-testid="taxonomy-rail-trigger"
                className="border-border bg-background focus-visible:ring-ring flex min-h-14 w-full items-center justify-between gap-3 rounded-md border border-l-[3px] border-l-[var(--color-primary-cornell-red)] px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
                    {mobile.eyebrow}
                  </span>
                  <span className="text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]">
                    {triggerLabel}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {typeof triggerCount === "number" && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {triggerCount.toLocaleString()}
                      <span className="sr-only"> {mobile.countNoun ?? "publications"}</span>
                    </span>
                  )}
                  <span className="text-xs font-semibold text-[var(--color-primary-cornell-red)]">
                    Change
                  </span>
                  <ChevronRight
                    className="size-4 text-[var(--color-primary-cornell-red)]"
                    aria-hidden
                  />
                </span>
              </SheetTrigger>
              <SheetContent
                side="left"
                aria-describedby={undefined}
                className="gap-0 p-0 motion-reduce:animate-none! motion-reduce:transition-none! lg:hidden [&_[data-slot=sheet-close-icon]]:top-1.5 [&_[data-slot=sheet-close-icon]]:right-1.5 [&_[data-slot=sheet-close-icon]]:flex [&_[data-slot=sheet-close-icon]]:size-11 [&_[data-slot=sheet-close-icon]]:items-center [&_[data-slot=sheet-close-icon]]:justify-center [&_[data-slot=sheet-close-icon]_svg]:size-5"
                onOpenAutoFocus={(e) => {
                  // Land on the current row, not the filter input: focusing the
                  // input pops the soft keyboard over the list on every open.
                  const target = sheetBodyRef.current?.querySelector<HTMLElement>(
                    'button[aria-current="true"]',
                  );
                  if (!target) return;
                  e.preventDefault();
                  target.focus();
                }}
                onCloseAutoFocus={(e) => {
                  if (!focusResultsOnCloseRef.current) return;
                  focusResultsOnCloseRef.current = false;
                  // Land on the results, not back on the trigger.
                  e.preventDefault();
                  const el = resultsRef.current;
                  el?.focus({ preventScroll: true });
                  // Scroll after the sheet's scroll lock has been released.
                  requestAnimationFrame(() => scrollIntoViewAndFocus(el));
                }}
              >
                <SheetHeader className="min-h-14 justify-center pr-14">
                  <SheetTitle>{rail.railLabel}</SheetTitle>
                </SheetHeader>
                <div ref={sheetBodyRef} className="overflow-y-auto p-4">
                  <TaxonomyRail
                    {...railProps}
                    onSelect={selectFromSheet}
                    size="touch"
                    idSuffix="-sheet"
                  />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        )}
        {/* Issue #172: the panel reads heading → description → scholars →
            controls → publications. No left rule: the selected rail row's
            maroon spine is the connector (mockup). */}
        <div
          id={resultsId}
          ref={resultsRef}
          tabIndex={-1}
          role="region"
          aria-label={`Results: ${subhead?.title ?? triggerLabel}`}
          className="min-w-0 flex-1 scroll-mt-20 outline-none"
        >
          {subhead && (
            <header className="mb-7 flex flex-col gap-1.5" data-testid="rail-subhead">
              {/* Mockup subHeadStyle="Eyebrow": the item kind in WCM red. */}
              <span className="text-xs font-semibold tracking-[0.1em] text-[var(--color-primary-cornell-red)] uppercase">
                {mobile.eyebrow}
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h2 className="min-w-0 font-serif text-[28px] leading-[1.2] font-normal [overflow-wrap:anywhere]">
                  {subhead.title}
                </h2>
                <button
                  type="button"
                  onClick={clear}
                  aria-label={`Clear ${subhead.title}, show ${mobile.allLabel.toLowerCase()}`}
                  className="border-apollo-border-strong bg-background text-muted-foreground inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] max-lg:h-11 max-lg:px-3.5"
                >
                  Clear
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
              {subhead.body}
            </header>
          )}
          {children(selectedId)}
        </div>
      </div>
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
