/**
 * The fixed bottom selection bar shared by the select-and-hide surfaces on
 * /edit — "Positions & appointments" (`positions-card.tsx`) and the Education /
 * Funding / Mentees panels (`entity-panel.tsx`).
 *
 * Renders nothing until something is selected, then the bar over the list: the
 * live count, an optional "Also select the N older …" link for a date-ordered
 * list, the hide verb, and Clear. The spacer below it keeps the last rows
 * scrollable above the fixed bar.
 */
"use client";

import { ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";

/** "entry" → "entries", "grant" → "grants" — consonant + y takes -ies. */
export const pluralNoun = (one: string) =>
  /[^aeiou]y$/.test(one) ? `${one.slice(0, -1)}ies` : `${one}s`;

/** "1 grant" / "2 grants". */
export const plural = (n: number, one: string) => `${n} ${n === 1 ? one : pluralNoun(one)}`;

export type SelectionBarProps = {
  count: number;
  /** Singular — pluralized here ("appointment" → "2 appointments selected"). */
  noun: string;
  /** Selectable rows below the topmost selection; 0 drops the extend link. */
  extendCount?: number;
  /** Singular noun for the extend link ("older appointment"); omit to drop it. */
  extendLabelNoun?: string;
  onExtend: () => void;
  onHide: () => void;
  onClear: () => void;
  busy: boolean;
  hideLabel?: string;
};

export function SelectionBar({
  count,
  noun,
  extendCount = 0,
  extendLabelNoun,
  onExtend,
  onHide,
  onClear,
  busy,
  hideLabel = "Hide from profile",
}: SelectionBarProps) {
  if (count === 0) return null;
  return (
    <>
      <div
        role="region"
        aria-label={`Selected ${pluralNoun(noun)}`}
        className="bg-apollo-surface border-apollo-border-strong fixed bottom-[22px] left-1/2 z-20 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-[11px] border px-4 py-[11px] shadow-[0_8px_24px_rgba(34,30,28,.16)]"
      >
        <span aria-live="polite" className="text-[13px] font-medium">
          {plural(count, noun)} selected
        </span>
        {extendLabelNoun && extendCount > 0 && (
          <button
            type="button"
            className="text-apollo-slate inline-flex items-center gap-1 text-[12.5px] underline underline-offset-2"
            onClick={onExtend}
          >
            <ArrowDown className="size-3" aria-hidden />
            Also select the {plural(extendCount, extendLabelNoun)}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="apollo" size="sm" disabled={busy} onClick={onHide}>
            {hideLabel}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
      {/* Keeps the last rows scrollable above the fixed bar (56px + 22px offset). */}
      <div aria-hidden className="h-20" />
    </>
  );
}
