"use client";

/**
 * The presentational pieces of the core review queue's v2 layout (Core Review
 * Queue v2 mockup): the scope rail, the "About these signals" note, the filters
 * panel and its active chips, and the keyboard-shortcuts popover.
 *
 * Props in, callbacks out — nothing here owns queue state or knows what a
 * `CoreQueueRow` is. `core-claim-queue.tsx` derives every label and count and
 * hands them down, so the vocabulary rules that file enforces (bands, "N of 4",
 * decoded priors) stay in one place, and this file never imports it back.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";

/** One rail entry: an evidence group, or a person. */
export interface RailItem {
  key: string;
  label: string;
  sub: string;
  /** Open (undecided) papers in this scope. */
  count: number;
}

export type RailMode = "evidence" | "person";

/**
 * The left pane. At `lg` and up it is the mockup's rail: the By evidence / By
 * person toggle, the scope list, and the "About these signals" note. Below `lg`
 * (phones, and the console IS used on phones) the list collapses to a native
 * select above the paper list — the designer drew no phone layout, and this is
 * the approved proposal — and the note stays desktop-only, since on a 390px
 * screen it would push the list a screen further down for copy a reviewer reads
 * once.
 */
export function ScopeRail({
  mode,
  onMode,
  items,
  activeKey,
  onSelect,
  emptyText,
  about,
}: {
  mode: RailMode;
  onMode: (m: RailMode) => void;
  items: RailItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** Shown instead of the list when the mode has nothing to scope by. */
  emptyText: string;
  about: ReactNode;
}) {
  return (
    <aside data-slot="core-queue-rail" className="flex min-w-0 flex-col gap-3">
      <div
        role="group"
        aria-label="Group candidates"
        className="bg-apollo-rail flex rounded-lg p-[3px]"
      >
        {(["evidence", "person"] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => onMode(m)}
              className={`focus-visible:ring-apollo-maroon flex-1 rounded-md px-2 py-1.5 text-[13px] focus-visible:ring-2 focus-visible:outline-none ${
                active
                  ? "bg-apollo-surface text-foreground shadow-[var(--apollo-shadow-card)]"
                  : "text-[var(--evidence-body)]"
              }`}
            >
              {m === "evidence" ? "By evidence" : "By person"}
            </button>
          );
        })}
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{emptyText}</p>
      ) : (
        <>
          <select
            aria-label="Choose a scope"
            value={activeKey}
            onChange={(e) => onSelect(e.target.value)}
            className="border-apollo-border-strong bg-apollo-surface focus-visible:ring-apollo-maroon rounded-md border px-2 py-2 text-[13px] focus-visible:ring-2 focus-visible:outline-none lg:hidden"
          >
            {items.map((i) => (
              <option key={i.key} value={i.key}>
                {i.label} ({i.count})
              </option>
            ))}
          </select>
          <ul
            aria-label={mode === "evidence" ? "Evidence groups" : "People"}
            className="hidden max-h-[70vh] flex-col gap-0.5 overflow-y-auto lg:flex"
          >
            {items.map((i) => {
              const active = i.key === activeKey;
              return (
                <li key={i.key}>
                  <button
                    type="button"
                    aria-pressed={active}
                    data-slot="core-queue-rail-item"
                    onClick={() => onSelect(i.key)}
                    className={`focus-visible:ring-apollo-maroon flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:outline-none ${
                      active
                        ? "border-apollo-border-strong bg-apollo-surface"
                        : "hover:bg-apollo-rail-hover border-transparent"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="text-foreground block text-[13px]">{i.label}</span>
                      <span className="text-muted-foreground mt-px block text-xs">{i.sub}</span>
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">{i.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="hidden lg:block">{about}</div>
    </aside>
  );
}

/**
 * What the co-author signal (signal 2) actually has to work with on this core.
 * Both counts come from ReciterAI's facility dictionary via etl/dynamodb Block
 * 6b (`PK=CORE#{id}, SK=STAFF_DICT`) — COUNTS, never the CWIDs.
 *
 * The two numbers are not interchangeable, and that is the whole reason this
 * renders both. `staffCount` is what the dictionary LISTS; `staffTrackedCount`
 * is how many of those the signal can actually MATCH (pipeline_cores/signals.py
 * `coauthorship_index` reads tracked CWIDs, so a listed staff member with no
 * personIdentifier upstream is invisible to it). They differ on 9 of the 14
 * live cores; the mockup's own core lists four and tracks one. So the sentence
 * leads with the tracked count and carries the listed one behind it, and the
 * two dead states say so outright rather than naming a number the signal
 * cannot use.
 *
 * Four states:
 *   - counts unpublished (either null; the ETL writes the pair together) —
 *     renders NOTHING. Not-yet-published must look like nothing at all, never
 *     like an empty roster.
 *   - listed 0 — the signal cannot fire.
 *   - listed > 0, tracked 0 — same conclusion, different (fixable upstream) cause.
 *   - tracked > 0 — "M of N", the fraction emphasised.
 *
 * v2 moved it off the toolbar into the rail's "About these signals" note (the
 * mockup's placement). The mockup's "Manage staff" link is still NOT built:
 * the roster lives in the facility dictionary, not in SPS, so there is no
 * destination for it.
 */
export function CoreStaffChip({
  staffCount,
  staffTrackedCount,
}: {
  staffCount: number | null;
  staffTrackedCount: number | null;
}) {
  if (staffCount === null || staffTrackedCount === null) return null;
  return (
    <p data-slot="core-staff-chip">
      {staffCount === 0 ? (
        <span>
          The facility dictionary lists no core staff, so the co-author signal cannot fire for this
          core.
        </span>
      ) : staffTrackedCount === 0 ? (
        <span>
          The facility dictionary lists {staffCount} core staff, but none are resolvable, so the
          co-author signal cannot fire for this core.
        </span>
      ) : (
        <span>
          Co-author signal draws on{" "}
          <span className="text-foreground font-semibold">
            {staffTrackedCount} of {staffCount}
          </span>{" "}
          core staff from the facility dictionary
        </span>
      )}
    </p>
  );
}

/**
 * The rail's static note. Every line is a statement about THIS core's data, not
 * the mockup's sample: the staff line is `CoreStaffChip` (silent when the engine
 * has published no counts), and the MeSH line counts the candidates whose prior
 * actually decodes to a MeSH-branch match rather than asserting that the core
 * has, or lacks, a mapped branch — the queue cannot see the mapping, only what
 * the prefilter emitted.
 */
export function AboutSignals({
  staffCount,
  staffTrackedCount,
  meshCount,
}: {
  staffCount: number | null;
  staffTrackedCount: number | null;
  /** Candidates whose topical prior decodes to a MeSH-branch match. */
  meshCount: number;
}) {
  return (
    <div
      data-slot="core-queue-about"
      className="border-apollo-border-strong flex flex-col gap-2 border-t pt-3 text-xs leading-normal text-[var(--evidence-body)]"
    >
      <p className="text-muted-foreground text-[11px] tracking-[0.1em] uppercase">
        About these signals
      </p>
      <CoreStaffChip staffCount={staffCount} staffTrackedCount={staffTrackedCount} />
      <p>
        Method family shows what a paper did, not whether this core did it. It is context and isn’t
        counted.
      </p>
      <p>
        {meshCount === 0
          ? "No candidate here carries a topical MeSH match, so that prior never shows."
          : `${meshCount} ${meshCount === 1 ? "candidate carries" : "candidates carry"} a topical MeSH match. It shows as a footnote on the paper and is never counted.`}
      </p>
    </div>
  );
}

export interface FacetOptionView {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetGroupView {
  key: string;
  label: string;
  options: FacetOptionView[];
}

/**
 * The Filters panel: one labelled group per facet, each option a genuine
 * checkbox carrying its live count. Options OR within a group and AND across
 * groups (the mockup's semantics); a value whose count is 0 is not offered at
 * all unless it is already ticked, so a single tick can never empty the list.
 */
export function FiltersPanel({
  id,
  groups,
  onToggle,
}: {
  id: string;
  groups: FacetGroupView[];
  onToggle: (group: string, value: string) => void;
}) {
  return (
    <div
      id={id}
      data-slot="core-queue-filters"
      className="border-apollo-border bg-apollo-surface grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-5 gap-y-3.5 rounded-[var(--apollo-radius-card)] border px-4 py-3.5"
    >
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing in this scope to filter on.</p>
      ) : null}
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.label} className="min-w-0">
          <p className="text-muted-foreground mb-1.5 text-[11px] tracking-[0.1em] uppercase">
            {g.label}
          </p>
          <div className="flex flex-wrap gap-1">
            {g.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="checkbox"
                aria-checked={o.selected}
                onClick={() => onToggle(g.key, o.value)}
                className={`focus-visible:ring-apollo-maroon inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs focus-visible:ring-2 focus-visible:outline-none ${
                  o.selected
                    ? "bg-apollo-slate border-apollo-slate text-white"
                    : "border-apollo-border-strong bg-apollo-surface text-foreground"
                }`}
              >
                {o.value} <span className="tabular-nums opacity-70">{o.count}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface ActiveChip {
  group: string;
  groupLabel: string;
  value: string;
}

/** The active-filter chips under the search row, each removable, plus the one
 *  reset ("Clear all"), which also drops the search text — so it shows for a
 *  text-only narrowing too. */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: ActiveChip[];
  onRemove: (group: string, value: string) => void;
  onClear: () => void;
}) {
  return (
    <div
      data-slot="core-queue-active-filters"
      className="flex flex-wrap items-center gap-1.5 text-xs"
    >
      {chips.map((c) => (
        <button
          key={`${c.group}:${c.value}`}
          type="button"
          aria-label={`Remove filter ${c.groupLabel}: ${c.value}`}
          onClick={() => onRemove(c.group, c.value)}
          className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1.5 pl-2.5"
        >
          <span className="text-muted-foreground">{c.groupLabel}:</span>
          {c.value}
          <X className="size-3" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="text-muted-foreground hover:text-foreground px-1"
      >
        Clear all
      </button>
    </div>
  );
}

/** The shortcuts the queue listens for, in the popover's order. */
export const SHORTCUTS: ReadonlyArray<{ label: string; keys: string[] }> = [
  { label: "Next paper", keys: ["j", "↓"] },
  { label: "Previous paper", keys: ["k", "↑"] },
  { label: "Confirm", keys: ["a"] },
  { label: "Reject", keys: ["r"] },
  { label: "Select / deselect", keys: ["x"] },
  { label: "Undo last decision", keys: ["u"] },
  { label: "Show this list", keys: ["?"] },
];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-apollo-border-strong bg-apollo-surface rounded border px-1 font-mono text-[11px]">
      {children}
    </kbd>
  );
}

/** "Shortcuts ?" and its popover. The popover is a plain disclosure, not a
 *  modal: it must not trap focus away from the queue the keys act on. */
export function ShortcutsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="core-queue-shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={onToggle}
        className={`border-apollo-border-strong inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-[var(--evidence-body)] ${
          open ? "bg-apollo-surface-2" : "bg-apollo-surface"
        }`}
      >
        Shortcuts <Kbd>?</Kbd>
      </button>
      {open ? (
        <div
          id="core-queue-shortcuts"
          data-slot="core-queue-shortcuts"
          className="border-apollo-border-strong bg-apollo-surface text-foreground absolute top-full right-0 z-20 mt-1 w-60 rounded-[10px] border px-3.5 py-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-muted-foreground text-[11px] tracking-[0.1em] uppercase">
              Keyboard shortcuts
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close shortcuts"
              className="text-muted-foreground leading-none"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <ul>
            {SHORTCUTS.map((s) => (
              <li
                key={s.label}
                className="border-apollo-border flex items-center justify-between gap-3 border-t py-1.5 text-[13px]"
              >
                <span>{s.label}</span>
                <span className="flex gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
