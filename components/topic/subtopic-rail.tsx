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
                    className={`flex w-full items-start justify-between gap-2 rounded px-3 py-2 text-left ${
                      isActive
                        ? "bg-[var(--color-accent-slate)] text-white"
                        : `hover:bg-accent${isLessCommon ? " opacity-60" : ""}`
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base">{s.displayName}</div>
                      {s.shortDescription ? (
                        <div className={`mt-0.5 truncate text-xs ${isActive ? "text-white/80" : "text-muted-foreground"}`}>
                          {s.shortDescription}
                        </div>
                      ) : null}
                    </div>
                    <span
                      className={`shrink-0 text-sm tabular-nums ${isActive ? "text-white" : "text-muted-foreground"}`}
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
