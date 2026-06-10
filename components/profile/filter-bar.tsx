"use client";

import { Filter, Tag, User, Wrench, X } from "lucide-react";

import type { PositionFilter } from "@/components/profile/author-position-badge";

/**
 * Unified filter bar for the facet-filter redesign (PROFILE_FACET_REDESIGN,
 * default OFF). Renders the active topic + method selections as removable chips
 * with a trailing publication count and a Clear-all action, replacing the prose
 * <ActiveFilterBanner> when the redesign flag is on. Translated from the
 * signed-off mockup `.planning/unified_facets_filtered_state.html` (lines 5–11):
 * Tabler icons + literal hex there become lucide-react icons + the
 * `--color-facet-*` design tokens here.
 *
 * Returns null when nothing is selected, so a flag-on profile with no active
 * filter shows no bar (matching the default-state mockup).
 */
export function FilterBar({
  topics,
  families,
  positions,
  count,
  countGeneration = 0,
  onRemoveTopic,
  onRemoveFamily,
  onRemovePosition,
  onClearAll,
}: {
  topics: { ui: string; label: string }[];
  families: { familyId: string; familyLabel: string }[];
  /** #12 — author-position selections surfaced as a third-hue (warm amber) chip.
   *  Pre-labelled by the cluster (which owns the bucket→label map). */
  positions: { bucket: Exclude<PositionFilter, "all">; label: string }[];
  count: number;
  /** #17 — monotonic generation counter from the cluster; a change keys the
   *  count span to remount so its one-shot bump keyframe self-plays. 0 on first
   *  paint (no bump on mount). prefers-reduced-motion zeroes the keyframe. */
  countGeneration?: number;
  onRemoveTopic: (ui: string) => void;
  onRemoveFamily: (id: string) => void;
  onRemovePosition: (bucket: Exclude<PositionFilter, "all">) => void;
  onClearAll: () => void;
}) {
  if (topics.length === 0 && families.length === 0 && positions.length === 0) return null;

  return (
    <div
      role="status"
      className="border-border-strong mb-5 flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3.5 py-2.5"
    >
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <Filter className="size-3.5" aria-hidden="true" />
        Filtering
      </span>

      {topics.map((t) => (
        <span
          key={t.ui}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-facet-topic-fill)] px-2.5 py-1 text-[13px] text-[var(--color-facet-topic-text)] dark:ring-1 dark:ring-inset dark:ring-[var(--color-facet-topic-border)]"
        >
          <Tag className="size-3.5" aria-hidden="true" />
          {t.label}
          <button
            type="button"
            onClick={() => onRemoveTopic(t.ui)}
            aria-label={`Remove ${t.label} filter`}
            className="-mr-0.5 inline-flex items-center"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}

      {families.map((f) => (
        <span
          key={f.familyId}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-facet-method-fill)] px-2.5 py-1 text-[13px] text-[var(--color-facet-method-text)] dark:ring-1 dark:ring-inset dark:ring-[var(--color-facet-method-border)]"
        >
          <Wrench className="size-3.5" aria-hidden="true" />
          {f.familyLabel}
          <button
            type="button"
            onClick={() => onRemoveFamily(f.familyId)}
            aria-label={`Remove ${f.familyLabel} filter`}
            className="-mr-0.5 inline-flex items-center"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}

      {/* #12 — author-position chip, the distinct third hue (warm amber). Reads
          topics -> methods -> position, matching the section stacking + the
          off-branch banner phrase order. */}
      {positions.map((p) => (
        <span
          key={p.bucket}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-facet-position-fill)] px-2.5 py-1 text-[13px] text-[var(--color-facet-position-text)] dark:ring-1 dark:ring-inset dark:ring-[var(--color-facet-position-border)]"
        >
          <User className="size-3.5" aria-hidden="true" />
          {p.label}
          <button
            type="button"
            onClick={() => onRemovePosition(p.bucket)}
            aria-label={`Remove ${p.label} filter`}
            className="-mr-0.5 inline-flex items-center"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}

      <span className="ml-auto whitespace-nowrap text-[13px] font-medium">
        {/* #17 — only the number bumps (the unit word stays static). Keying by
            countGeneration remounts the span so the one-shot keyframe replays on
            each filter change; generation 0 (first paint) carries no bump class. */}
        <span
          key={`count-${countGeneration}`}
          className={countGeneration > 0 ? "facet-count-bump tabular-nums" : "tabular-nums"}
        >
          {count}
        </span>{" "}
        {count === 1 ? "publication" : "publications"}
      </span>
      <button
        type="button"
        onClick={onClearAll}
        className="whitespace-nowrap text-xs font-medium underline-offset-4 hover:underline"
        style={{ color: "var(--color-accent-slate)" }}
      >
        Clear all
      </button>
    </div>
  );
}
