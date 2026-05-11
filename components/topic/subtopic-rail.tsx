"use client";

import { useState, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

export type SubtopicRailItem = {
  id: string;
  label: string;
  displayName: string;
  description: string | null;
  shortDescription: string | null;
  pubCount: number;
};

const LESS_COMMON_THRESHOLD = 10;

export function SubtopicRail({
  subtopics,
  activeSubtopic,
  onSelect,
}: {
  subtopics: SubtopicRailItem[];
  activeSubtopic: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const filterLower = filter.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!filterLower) return subtopics;
    return subtopics.filter((s) => s.displayName.toLowerCase().includes(filterLower));
  }, [subtopics, filterLower]);

  // First index where pubCount <= threshold (subtopics pre-sorted DESC by pubCount).
  const lessCommonIndex = useMemo(() => {
    return visible.findIndex((s) => s.pubCount <= LESS_COMMON_THRESHOLD);
  }, [visible]);

  const handleClick = useCallback(
    (id: string) => {
      onSelect(activeSubtopic === id ? null : id);
    },
    [activeSubtopic, onSelect],
  );

  return (
    <aside className="w-full" aria-label="Subtopics">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        SUBTOPICS ({subtopics.length})
      </div>
      <div className="relative mb-3">
        <Input
          type="text"
          placeholder="Filter subtopics…"
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
          No subtopics match &ldquo;{filter}&rdquo;
        </div>
      ) : (
        <ScrollArea className="h-full">
          <ul className="flex flex-col">
            {visible.map((s, i) => {
              const isActive = activeSubtopic === s.id;
              const isLessCommon = s.pubCount <= LESS_COMMON_THRESHOLD;
              const showDivider = i === lessCommonIndex && lessCommonIndex > 0;
              // Hairline divider above every row except the first AND the
              // row that already carries the "Less common" separator (which
              // brings its own visual rule).
              const showHairline = i > 0 && !showDivider;
              return (
                <li key={s.id}>
                  {showDivider && (
                    <div className="relative my-2 flex items-center">
                      <Separator className="flex-1" />
                      <span className="absolute left-1/2 -translate-x-1/2 bg-background px-2 text-sm italic text-muted-foreground">
                        Less common
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleClick(s.id)}
                    // Issue #172 selected state: 3px WCM-red left border +
                    // warm neutral fill + text weight. The red accent visually
                    // couples this item to the right content panel; red is
                    // not used as a fill or link color elsewhere on the page.
                    // Unselected items reserve the same 3px gutter via a
                    // transparent border so selection doesn't shift layout.
                    className={`flex w-full items-center justify-between gap-2 rounded px-3 py-2.5 text-left border-l-[3px] ${
                      showHairline ? "border-t border-t-[#f0f1f3]" : ""
                    } ${
                      isActive
                        ? "border-l-[var(--color-primary-cornell-red)] bg-[#f5f4f0] font-semibold"
                        : `border-l-transparent hover:bg-[#f5f6f8]${isLessCommon ? " opacity-60" : ""}`
                    }`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base break-words leading-snug">
                        {s.displayName}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 self-center text-sm tabular-nums ${
                        isActive ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {s.pubCount}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </aside>
  );
}
