"use client";

/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — pick-to-filter scholars for the selected
 * rail item (subarea on topic pages, family on method category pages).
 *
 *   - `useScholarFilter(itemId)` owns the picked scholar. It is seeded from
 *     `?scholar=<cwid>` on load and written back with `history.replaceState`
 *     (the same no-navigation URL sync `RailLayout` uses for the rail param).
 *     It clears itself when the rail selection changes or is cleared, and when
 *     the item's roster loads without the requested cwid (a stale or foreign
 *     link), so a filter only ever applies to a scholar shown on the page.
 *   - `ScholarPickList` renders the roster as toggle cards (`aria-pressed`),
 *     each with its own separate "View profile →" link; unpicked cards dim.
 *   - `ScholarFilterChip` is the "Showing publications by X ×" line above the
 *     feed, with "View X's profile →".
 *
 * No db imports: the roster arrives from the existing scholars routes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { profilePath } from "@/lib/profile-url";
import { CWID_PATTERN } from "@/lib/cwid";

export const SCHOLAR_FILTER_PARAM = "scholar";

export type PickScholar = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint?: string;
};

function writeScholarParam(cwid: string | null) {
  try {
    const url = new URL(window.location.href);
    if (cwid === null) {
      if (!url.searchParams.has(SCHOLAR_FILTER_PARAM)) return;
      url.searchParams.delete(SCHOLAR_FILTER_PARAM);
    } else {
      url.searchParams.set(SCHOLAR_FILTER_PARAM, cwid);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL sync is best-effort; the in-page filter already changed.
  }
}

export type ScholarFilterState = {
  /** The picked scholar, once resolved against the loaded roster. */
  active: PickScholar | null;
  /** The picked cwid (may be pending until the roster loads). */
  selectedCwid: string | null;
  toggle: (s: PickScholar) => void;
  clear: () => void;
  /** Report the selected item's roster (null while loading / on item change). */
  onRosterLoaded: (roster: PickScholar[]) => void;
};

export function useScholarFilter(itemId: string | null): ScholarFilterState {
  const searchParams = useSearchParams();
  const [selectedCwid, setSelectedCwid] = useState<string | null>(() => {
    const raw = searchParams.get(SCHOLAR_FILTER_PARAM);
    return raw && CWID_PATTERN.test(raw) ? raw : null;
  });
  const [roster, setRoster] = useState<PickScholar[] | null>(null);
  const prevItemRef = useRef<string | null>(itemId);

  const set = useCallback((cwid: string | null) => {
    setSelectedCwid(cwid);
    writeScholarParam(cwid);
  }, []);

  // A different rail item (or Clear / "All") drops the scholar filter.
  useEffect(() => {
    if (prevItemRef.current === itemId) return;
    prevItemRef.current = itemId;
    setRoster(null);
    set(null);
  }, [itemId, set]);

  // No item selected: a `?scholar=` deep link has nothing to resolve against.
  useEffect(() => {
    if (itemId === null && selectedCwid !== null) set(null);
  }, [itemId, selectedCwid, set]);

  // The roster loaded without the requested scholar: drop the stale filter.
  useEffect(() => {
    if (roster && selectedCwid && !roster.some((s) => s.cwid === selectedCwid)) set(null);
  }, [roster, selectedCwid, set]);

  const onRosterLoaded = useCallback((list: PickScholar[]) => setRoster(list), []);

  const toggle = useCallback(
    (s: PickScholar) => set(selectedCwid === s.cwid ? null : s.cwid),
    [selectedCwid, set],
  );
  const clear = useCallback(() => set(null), [set]);

  const active =
    roster && selectedCwid ? (roster.find((s) => s.cwid === selectedCwid) ?? null) : null;

  return { active, selectedCwid, toggle, clear, onRosterLoaded };
}

export function ScholarPickList({
  heading,
  scholars,
  selectedCwid,
  onToggle,
  footer,
}: {
  heading: React.ReactNode;
  scholars: PickScholar[];
  selectedCwid: string | null;
  onToggle: (s: PickScholar) => void;
  /** Rendered after the cards (e.g. "+ N more" / "View all scholars →"). */
  footer?: React.ReactNode;
}) {
  return (
    <div className="mb-6 min-w-0" data-testid="scholar-pick-list">
      <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
        {heading}
      </div>
      <p className="sr-only">Select a scholar to show only their publications below.</p>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {scholars.map((s) => {
          const on = selectedCwid === s.cwid;
          const dim = selectedCwid !== null && !on;
          return (
            <li
              key={s.cwid}
              data-testid="scholar-pick-card"
              data-dimmed={dim ? "true" : undefined}
              className={`flex min-w-0 items-stretch rounded-lg border transition-[opacity,border-color] ${
                on
                  ? "border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)]/5"
                  : "border-border bg-background hover:border-[var(--color-accent-slate)]"
              } ${dim ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(s)}
                title={on ? "Show all publications" : "Show only this scholar's publications"}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
              >
                <HeadshotAvatar
                  size="roster"
                  cwid={s.cwid}
                  preferredName={s.preferredName}
                  identityImageEndpoint={s.identityImageEndpoint}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-semibold">{s.preferredName}</span>
                  {s.primaryTitle ? (
                    <span className="text-muted-foreground truncate text-xs">{s.primaryTitle}</span>
                  ) : null}
                </span>
              </button>
              <a
                href={profilePath(s.slug)}
                aria-label={`View ${s.preferredName}'s profile`}
                className="flex min-h-11 shrink-0 items-center rounded-r-lg px-3 text-xs font-medium whitespace-nowrap text-[var(--color-accent-slate)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
              >
                View profile →
              </a>
            </li>
          );
        })}
      </ul>
      {footer}
    </div>
  );
}

export function ScholarFilterChip({
  scholar,
  onClear,
}: {
  scholar: PickScholar;
  onClear: () => void;
}) {
  return (
    <div
      className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm"
      data-testid="scholar-filter-chip"
      role="status"
    >
      <span className="text-muted-foreground">Showing publications by</span>
      <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-[var(--color-accent-slate)]/30 bg-[var(--color-accent-slate)]/10 py-0.5 pr-0.5 pl-3 font-medium text-[var(--color-accent-slate)]">
        <span className="truncate">{scholar.preferredName}</span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear scholar filter"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-[var(--color-accent-slate)]/15 max-sm:size-11"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </span>
      <a
        href={profilePath(scholar.slug)}
        className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline sm:ml-auto"
      >
        View {scholar.preferredName}&apos;s profile →
      </a>
    </div>
  );
}
