/**
 * The shared select-and-hide machinery for `/edit`: the fixed bottom selection
 * bar, the row-selection state machine behind it, and the bounded fan-out its
 * "Hide from profile" runs. Used by "Positions & appointments"
 * (`positions-card.tsx`), the Education / Funding / Mentees panels
 * (`entity-panel.tsx`) and "My publications" (`publications-card.tsx`).
 *
 * The bar renders nothing until something is selected, then floats over the
 * list: the live count, an optional "Also select the N older …" link for a
 * date-ordered list, the hide verb, and Clear. It is `fixed`, so the space that
 * keeps the last rows scrollable above it is the CALLER's job —
 * {@link SelectionBarSpacer}, rendered inside whatever actually scrolls (the
 * bounded `ScrollArea` on Publications / Funding, the page itself elsewhere).
 * A spacer emitted from here would land outside a bounded scroll container and
 * clear nothing.
 */
"use client";

import * as React from "react";
import { ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";

/** "1 grant" / "2 grants", from the caller's own authored forms. */
export const plural = (n: number, one: string, other: string) =>
  `${n} ${n === 1 ? one : other}`;

/** Most writes in flight at once. A selection can be hundreds of rows ("Also
 *  select the N older …" on a 500-publication list) and every row is its own
 *  POST opening its own Aurora write transaction, so a batch goes out in
 *  ordered chunks rather than all at once. */
const CONCURRENCY = 4;

/** `items.map(fn)` with at most {@link CONCURRENCY} promises in flight. Results
 *  keep input order, so a caller can pair them back up with the batch. */
export async function mapChunked<T, R>(
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  }
  return out;
}

/** The minimum a rendered row exposes to take part in a selection. */
export type SelectableRow = { id: string; selectable: boolean };

/**
 * The selection state machine the three cards share: which rows are ticked,
 * what "Also select the N older …" would add (every selectable row below the
 * TOPMOST tick, in the list's own visual order), and how a finished batch
 * settles.
 *
 * `rows` is the list as rendered, so filtering changes what "older" means but
 * never drops a selected row from the batch.
 */
export function useRowSelection(
  rows: ReadonlyArray<SelectableRow>,
  /** Called when the last tick goes away — the cards drop their batch alert,
   *  which only ever describes rows that are still selected. */
  onEmptied?: () => void,
) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());

  const firstSelected = rows.findIndex((r) => selected.has(r.id));
  const older =
    firstSelected < 0
      ? []
      : rows.slice(firstSelected + 1).filter((r) => r.selectable && !selected.has(r.id));

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!on && selected.size <= 1) onEmptied?.();
  }

  function clear() {
    setSelected(new Set());
    onEmptied?.();
  }

  function selectAlsoOlder() {
    setSelected((prev) => new Set([...prev, ...older.map((r) => r.id)]));
  }

  /** A finished batch: subtract it, add its failures back. NEVER
   *  `new Set(failed)` — the batch can be a single row that was never part of
   *  the selection (the Publications reject interstitial's "hide it instead"),
   *  and overwriting would wipe every tick outside it. */
  function settle(batch: ReadonlyArray<string>, failed: ReadonlyArray<string>) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of batch) next.delete(id);
      for (const id of failed) next.add(id);
      return next;
    });
  }

  return { selected, toggle, clear, older, selectAlsoOlder, settle };
}

/** Keeps the last rows scrollable above the fixed bar (56px + its 22px offset).
 *  Rendered by the caller inside whatever scrolls — see the module docblock. */
export function SelectionBarSpacer({ count }: { count: number }) {
  return count > 0 ? <div aria-hidden className="h-20" /> : null;
}

export type SelectionBarProps = {
  count: number;
  /** Authored count forms — "appointment" / "appointments". They also name the
   *  "Also select the N older …" link ("2 older appointments"). */
  noun: string;
  nounPlural: string;
  /** Selectable rows below the topmost selection; 0 drops the extend link, as
   *  does omitting `onExtend` (a list with no meaningful order — Mentees). */
  extendCount?: number;
  onExtend?: () => void;
  onHide: () => void;
  onClear: () => void;
  busy: boolean;
};

export function SelectionBar({
  count,
  noun,
  nounPlural,
  extendCount = 0,
  onExtend,
  onHide,
  onClear,
  busy,
}: SelectionBarProps) {
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label={`Selected ${nounPlural}`}
      className="bg-apollo-surface border-apollo-border-strong fixed bottom-[22px] left-1/2 z-20 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-[11px] border px-4 py-[11px] shadow-[0_8px_24px_rgba(34,30,28,.16)]"
    >
      <span aria-live="polite" className="text-[13px] font-medium">
        {plural(count, noun, nounPlural)} selected
      </span>
      {onExtend && extendCount > 0 && (
        <button
          type="button"
          // Disabled mid-batch with the rest of the bar: a selection made while
          // the writes are in flight would be discarded when they settle.
          disabled={busy}
          className="text-apollo-slate inline-flex items-center gap-1 text-[12.5px] underline underline-offset-2 disabled:opacity-50"
          onClick={onExtend}
        >
          <ArrowDown className="size-3" aria-hidden />
          Also select the {extendCount} older {extendCount === 1 ? noun : nounPlural}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="apollo" size="sm" disabled={busy} onClick={onHide}>
          Hide from profile
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
