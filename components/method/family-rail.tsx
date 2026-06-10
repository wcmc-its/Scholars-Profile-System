"use client";

/**
 * Family rail for the supercategory page (the `subtopic-rail` analog). Lists the
 * supercategory's publicly-visible families; selecting one sets `?family=fam_NNNN`
 * on the supercategory page and drives the right content panel.
 *
 * Distinct from the #819 per-scholar `?family=` filter, which lives on a PROFILE
 * route, not `/methods`. This rail's `?family=` is a within-supercategory-page
 * deep-link param (a different surface, a different flag — §OQ-9).
 *
 * Styling mirrors the subtopic rail's #172 selected state: 3px WCM-red left
 * border + warm-neutral fill on the active item, `tabular-nums` scholar count on
 * the right, plus a mono-middot `exemplarTools` line (static display strings, NOT
 * clickable — §3.6). Families arrive pre-sorted by scholar count desc.
 */
import { useState, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export type FamilyRailItem = {
  /** The opaque A2 family id (`fam_NNNN`) — the `?family=` deep-link value. */
  familyId: string;
  /** Human family label, rendered as the row title. */
  familyLabel: string;
  /** Distinct-scholar count (additive/accurate `_count.cwid`). */
  scholarCount: number;
  /** Up to ~3 representative member-tool display names (static exemplars). */
  exemplarTools: string[];
};

export function FamilyRail({
  families,
  activeFamilyId,
  onSelect,
}: {
  families: FamilyRailItem[];
  activeFamilyId: string | null;
  onSelect: (familyId: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const filterLower = filter.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!filterLower) return families;
    return families.filter((f) => f.familyLabel.toLowerCase().includes(filterLower));
  }, [families, filterLower]);

  const handleClick = useCallback(
    (familyId: string) => {
      onSelect(activeFamilyId === familyId ? null : familyId);
    },
    [activeFamilyId, onSelect],
  );

  return (
    <aside className="w-full" aria-label="Method families">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        FAMILIES ({families.length})
      </div>
      <div className="relative mb-3">
        <Input
          type="text"
          placeholder="Filter families…"
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
          No families match &ldquo;{filter}&rdquo;
        </div>
      ) : (
        <ScrollArea className="h-full">
          <ul className="flex flex-col">
            {visible.map((f, i) => {
              const isActive = activeFamilyId === f.familyId;
              const showHairline = i > 0;
              return (
                <li key={f.familyId}>
                  <button
                    type="button"
                    onClick={() => handleClick(f.familyId)}
                    // #172 selected state: 3px WCM-red left border + warm neutral
                    // fill + text weight. Unselected rows reserve the same gutter
                    // via a transparent border so selection doesn't shift layout.
                    className={`flex w-full items-start justify-between gap-2 rounded px-3 py-2.5 text-left border-l-[3px] ${
                      showHairline ? "border-t border-t-[#f0f1f3]" : ""
                    } ${
                      isActive
                        ? "border-l-[var(--color-primary-cornell-red)] bg-[#f5f4f0] font-semibold"
                        : "border-l-transparent hover:bg-[#f5f6f8]"
                    }`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base break-words leading-snug">
                        {f.familyLabel}
                      </div>
                      {f.exemplarTools.length > 0 && (
                        <div className="mt-0.5 truncate text-xs font-normal text-muted-foreground">
                          {f.exemplarTools.join(" · ")}
                        </div>
                      )}
                    </div>
                    <span
                      className={`shrink-0 self-center text-sm tabular-nums ${
                        isActive ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {f.scholarCount}
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
