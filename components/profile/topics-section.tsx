"use client";

import { useMemo, useState } from "react";
import type { ScholarKeyword } from "@/lib/api/profile";

const INITIAL_VISIBLE = 10;
const PAGE_SIZE = 20;

export function TopicsSection({
  keywords,
  totalAcceptedPubs,
  selectedUis,
  onToggle,
  onClearAll: _onClearAll,
}: {
  keywords: ScholarKeyword[];
  totalAcceptedPubs: number;
  selectedUis: string[];
  onToggle: (descriptorUi: string) => void;
  onClearAll: () => void;
}) {
  const [revealed, setRevealed] = useState(INITIAL_VISIBLE);

  const selectedSet = useMemo(() => new Set(selectedUis), [selectedUis]);

  // Selected pills always render even when the visible window pushes them
  // past the revealed slice. When that happens, lift them into the visible
  // row in their original count-desc order; the rest of the row stays as the
  // top-N minus the pinned ones (so the row still shows N pills total).
  const visible = useMemo(() => {
    const topN = keywords.slice(0, revealed);
    const topUis = new Set(topN.map((k) => k.descriptorUi));
    const pinned = keywords.filter(
      (k) => k.descriptorUi && selectedSet.has(k.descriptorUi) && !topUis.has(k.descriptorUi),
    );
    if (pinned.length === 0) return topN;
    // Drop the lowest-rank top-N pills to make room for pinned ones, preserving
    // count-desc order overall.
    const headRoom = Math.max(0, revealed - pinned.length);
    return [...topN.slice(0, headRoom), ...pinned];
  }, [keywords, revealed, selectedSet]);

  const hasMore = keywords.length > revealed;
  const remaining = Math.max(0, keywords.length - revealed);
  const nextStep = Math.min(PAGE_SIZE, remaining);
  const isExpandedBeyondInitial = revealed > INITIAL_VISIBLE;

  return (
    <section className="mb-6">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
        Topics
        <span
          aria-label="About Topics"
          title="Topics derived from MeSH descriptors on accepted publications. Counts show publications tagged with each topic."
          className="border-border text-muted-foreground inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border text-[10px] leading-none"
        >
          ?
        </span>
      </h2>
      <p className="text-muted-foreground mb-3 text-sm">
        From {totalAcceptedPubs} accepted publications · click to filter publications
      </p>
      <ul className="flex flex-wrap gap-2">
        {visible.map((k) => {
          const ui = k.descriptorUi;
          const isSelected = ui ? selectedSet.has(ui) : false;
          const disabled = ui === null;
          return (
            <li key={ui ?? `__nolabel:${k.displayLabel}`}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={isSelected}
                onClick={() => ui && onToggle(ui)}
                data-mesh-ui={ui ?? ""}
                className={
                  isSelected
                    ? "inline-flex h-[26px] items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white"
                    : "border-border-strong inline-flex h-[26px] items-center gap-1.5 rounded-full border bg-background px-3 text-sm text-zinc-700 hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] disabled:cursor-default disabled:hover:border-border-strong disabled:hover:text-zinc-700 dark:text-zinc-200"
                }
              >
                <span>{k.displayLabel}</span>
                <span
                  className={
                    isSelected
                      ? "rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums"
                      : "text-[11px] tabular-nums opacity-55"
                  }
                >
                  {k.pubCount}
                </span>
                {isSelected ? (
                  <span
                    aria-hidden="true"
                    className="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[11px] leading-none"
                  >
                    ×
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {hasMore ? (
          <li>
            <button
              type="button"
              onClick={() => setRevealed((r) => r + PAGE_SIZE)}
              className="text-muted-foreground hover:text-[var(--color-accent-slate)] inline-flex h-[26px] items-center px-2 text-sm underline-offset-4 hover:underline"
            >
              Show next {nextStep} topics →
            </button>
          </li>
        ) : null}
        {isExpandedBeyondInitial ? (
          <li>
            <button
              type="button"
              onClick={() => setRevealed(INITIAL_VISIBLE)}
              className="text-muted-foreground hover:text-[var(--color-accent-slate)] inline-flex h-[26px] items-center px-2 text-sm underline-offset-4 hover:underline"
            >
              Show fewer ↑
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
