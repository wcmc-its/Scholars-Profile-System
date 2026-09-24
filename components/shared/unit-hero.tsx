/**
 * Shared hero building blocks for the department + center pages ("Unit Page
 * v2" mock): the subunit chip row (divisions / programs), the top-research-area
 * pill row, and the dashed-divider stats line. Server Components — pure markup
 * (the research-area pill's hover preview is its own client island).
 *
 * The division page keeps its own hero (it is not part of the v2 mock).
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AreaPreviewPill } from "@/components/shared/area-preview-pill";
import type { UnitAreaPreviews } from "@/lib/api/unit-area-previews";

/** 11px / 0.14em muted uppercase section label used inside the hero. */
export const UNIT_HERO_LABEL_CLASS =
  "text-[11px] uppercase tracking-[0.14em] text-muted-foreground";

export type UnitSubunitChip = {
  key: string;
  label: string;
  href: string;
  /** Scholar count shown after the name; omitted when unknown. */
  count?: number | null;
};

/**
 * "{N} DIVISIONS" / "{N} PROGRAMS" + a row of slate-outline chips. The chips
 * stay LINKS to the first-class division / program pages (the mock's
 * filter-in-place buttons are a pending product decision), restyled per the
 * mock: 26px, 12.5px, slate border, muted tabular count, slate-tint hover.
 */
export function UnitSubunitChips({
  noun,
  chips,
  ariaLabel,
}: {
  /** Singular / plural noun, e.g. ["division", "divisions"]. */
  noun: [string, string];
  chips: UnitSubunitChip[];
  ariaLabel: string;
}) {
  if (chips.length === 0) return null;
  return (
    <nav aria-label={ariaLabel}>
      <div id="subunits" className={cn("mt-7 scroll-mt-16", UNIT_HERO_LABEL_CLASS)}>
        {chips.length} {chips.length === 1 ? noun[0] : noun[1]}
      </div>
      <div className="mt-3 flex flex-wrap gap-[6px]">
        {chips.map((c) => (
          <a
            key={c.key}
            href={c.href}
            className="border-apollo-slate text-apollo-slate hover:bg-apollo-slate-tint inline-flex min-h-[26px] max-w-full items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-[12.5px] leading-tight no-underline transition-colors duration-[120ms] ease-out hover:no-underline"
          >
            {c.label}
            {typeof c.count === "number" && (
              <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                {c.count.toLocaleString()}
              </span>
            )}
          </a>
        ))}
      </div>
    </nav>
  );
}

/**
 * "TOP RESEARCH AREAS" + 32px pill links to /topics/{slug}, each with the
 * research-area hover preview (`AreaPreviewPill`) when `previews` has an entry
 * for it; a pill without one renders as the plain link.
 */
export function UnitResearchAreas({
  areas,
  infoButton,
  previews = {},
  basePath,
  unitShort,
  membersNoun,
}: {
  areas: Array<{ topicId: string; topicLabel: string; topicSlug: string; pubCount: number }>;
  /** The shipped (i) SectionInfoButton, kept beside the heading. */
  infoButton?: ReactNode;
  /** Per-area preview data from `getUnitAreaPreviews`, keyed by topic id. */
  previews?: UnitAreaPreviews;
  /** The unit's page path; the preview's "See all" appends `/areas/{topic}`. */
  basePath: string;
  /** Short unit name for "{n} {unitShort} authors". */
  unitShort: string;
  /** "faculty" (departments, divisions) or "members" (centers). */
  membersNoun: "faculty" | "members";
}) {
  if (areas.length === 0) return null;
  return (
    <div>
      <div className={cn("mt-6 inline-flex items-center gap-1.5", UNIT_HERO_LABEL_CLASS)}>
        Top research areas
        {infoButton}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {areas.map((t) => (
          <AreaPreviewPill
            key={t.topicId}
            area={t}
            preview={previews[t.topicId]}
            basePath={basePath}
            unitShort={unitShort}
            membersNoun={membersNoun}
          />
        ))}
      </div>
    </div>
  );
}

export type UnitStat = { value: number; label: string; href: string };

/**
 * Dashed-divider stats line. Zero-valued stats are dropped by the caller; each
 * surviving stat is a link (value in 600 foreground, label muted) separated by
 * a muted middle dot. `fallback` renders when no stat survives (the center's
 * "Membership data pending").
 */
export function UnitStatsLine({ stats, fallback }: { stats: UnitStat[]; fallback?: ReactNode }) {
  return (
    <div className="border-apollo-border-strong text-muted-foreground mt-[26px] flex flex-wrap gap-x-3 gap-y-1.5 border-t border-dashed pt-5 text-[15px]">
      {stats.map((s, i) => (
        <span key={s.label} className="flex gap-3 whitespace-nowrap">
          {i > 0 && <span aria-hidden="true">·</span>}
          <a
            href={s.href}
            className="text-muted-foreground hover:text-apollo-slate no-underline hover:underline hover:underline-offset-[3px]"
          >
            <strong className="text-foreground font-semibold">{s.value.toLocaleString()}</strong>{" "}
            {s.label}
          </a>
        </span>
      ))}
      {stats.length === 0 && fallback}
    </div>
  );
}
