"use client";

/**
 * Report 8's "Journal Impact Factor" rail control (reports redesign): a
 * segmented Any / ≥ 3 / ≥ 5 / ≥ 10 plus an "Exact minimum" box (one decimal),
 * both writing ONE hidden `jif` input. A segment submits at once; the box
 * submits on Enter or when it loses focus, never per keystroke — its `change`
 * stops here, since the body's `AutoSubmitForm` submits on every bubbling
 * change (the reason the old range slider stopped its bubble too). The submit
 * runs in the effect AFTER React wrote the new hidden value. Nothing here
 * reaches `@/lib/db`.
 */
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PRESETS = [0, 3, 5, 10] as const;

/** Text → a minimum in 0..max, one decimal; blank or junk → 0 (none). */
function toMinimum(text: string, max: number): number {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n * 10) / 10) : 0;
}

export function JifField({ defaultValue, max }: { defaultValue: number; max: number }) {
  const [value, setValue] = useState(defaultValue);
  const [text, setText] = useState(defaultValue > 0 ? String(defaultValue) : "");
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    root.current?.closest("form")?.requestSubmit();
  }, [value]);

  const commit = (next: number) => {
    setText(next > 0 ? String(next) : "");
    if (next === value) return;
    pending.current = true;
    setValue(next);
  };

  return (
    <div ref={root} className="flex flex-col gap-2.5" data-testid="jif-field">
      <input type="hidden" name="jif" value={String(value)} />
      <div
        role="group"
        aria-label="Minimum Journal Impact Factor"
        className="bg-apollo-surface-2 border-apollo-border-strong grid grid-cols-4 gap-0.5 rounded-lg border p-[3px]"
      >
        {PRESETS.map((p) => {
          const on = value === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => commit(p)}
              className={cn(
                "rounded-md py-[5px] text-center text-[13px]",
                on
                  ? "bg-apollo-surface text-foreground font-semibold shadow-[var(--apollo-shadow-card)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p === 0 ? "Any" : `≥ ${p}`}
            </button>
          );
        })}
      </div>
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground text-[13px] whitespace-nowrap">Exact minimum</span>
        <span className="text-sm" aria-hidden>
          ≥
        </span>
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step={0.1}
          placeholder="e.g. 7.5"
          value={text}
          onChange={(e) => {
            e.stopPropagation();
            setText(e.target.value);
          }}
          onBlur={() => commit(toMinimum(text, max))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            commit(toMinimum(text, max));
          }}
          className="bg-apollo-surface border-apollo-border-strong h-8 w-24 text-sm md:text-sm"
          data-testid="jif-exact"
        />
      </label>
    </div>
  );
}
