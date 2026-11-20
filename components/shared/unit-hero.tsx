/**
 * Shared hero building blocks for the department + center pages ("Unit Page
 * v2" mock): the subunit list (divisions / programs), the ranked
 * top-research-area list, and the stats line. Server Components — pure markup
 * (the research-area pill's hover preview and the subunit chip row are their
 * own client islands).
 *
 * The division page keeps its own hero (it is not part of the v2 mock).
 */
import type { ReactNode } from "react";
import { chunkColumns, cn } from "@/lib/utils";
import { AreaPreviewPill } from "@/components/shared/area-preview-pill";
import type { UnitAreaPreviews } from "@/lib/api/unit-area-previews";
import {
  UnitSubunitChipRow,
  type SubunitChipView,
} from "@/components/shared/unit-subunit-chip-row";

/** 11px / 0.14em muted uppercase section label used inside the hero. */
export const UNIT_HERO_LABEL_CLASS =
  "text-[11px] uppercase tracking-[0.14em] text-muted-foreground";

export type UnitSubunitChip = SubunitChipView;

/**
 * "{N} DIVISIONS" / "{N} PROGRAMS" + up to three ranked columns of row links
 * (name in slate, muted tabular count under a header naming its unit). A chip with a
 * `filter` narrows the roster below in place (the mock's pick()) and keeps a
 * real `?div=<code>#people` href (other tabs / new-tab clicks; filtered by the
 * roster's client seed, so JS-off lands unfiltered); a chip without one links the
 * first-class division / program page. The chip row is a small client island
 * (`UnitSubunitChipRow`); this wrapper stays a Server Component.
 */
export function UnitSubunitChips({
  noun,
  chips,
  ariaLabel,
  countLabel = "Scholars",
  countInHeading = true,
}: {
  /** Singular / plural noun, e.g. ["division", "divisions"]. */
  noun: [string, string];
  chips: UnitSubunitChip[];
  ariaLabel: string;
  /** What each count counts — the right-hand column header. */
  countLabel?: string;
  /** "{N} divisions" (default) or just "Divisions", for a page whose stats
   *  line already carries the count. */
  countInHeading?: boolean;
}) {
  if (chips.length === 0) return null;
  return (
    <nav aria-label={ariaLabel}>
      <div id="subunits" className={cn("mt-7 scroll-mt-16", UNIT_HERO_LABEL_CLASS)}>
        {countInHeading
          ? `${chips.length} ${chips.length === 1 ? noun[0] : noun[1]}`
          : noun[1].charAt(0).toUpperCase() + noun[1].slice(1)}
      </div>
      <UnitSubunitChipRow
        chips={chips}
        itemLabel={noun[0].charAt(0).toUpperCase() + noun[0].slice(1)}
        countLabel={chips.some((c) => typeof c.count === "number") ? countLabel : undefined}
      />
    </nav>
  );
}

/**
 * "TOP RESEARCH AREAS" as a ranked list: up to two columns of numbered rows,
 * each a link to /topics/{slug} with a thin bar sized against the top area and
 * its publication count on the same line, so the spread between areas reads at a glance.
 * Each row keeps the research-area hover preview (`AreaPreviewPill`) when
 * `previews` has an entry for it; a row without one is the plain link.
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
  const max = Math.max(...areas.map((a) => a.pubCount), 1);
  const columns = chunkColumns(
    areas.map((a, i) => ({ area: a, rank: i + 1 })),
    areas.length <= 5 ? 1 : 2,
  );
  return (
    <div>
      <div className={cn("mt-6 inline-flex items-center gap-1.5", UNIT_HERO_LABEL_CLASS)}>
        Top research areas
        {infoButton}
      </div>
      <div
        className={cn(
          "mt-3 grid grid-cols-1 items-start gap-x-10",
          columns.length === 2 && "sm:grid-cols-2",
        )}
      >
        {columns.map((col, ci) => (
          <div key={ci} className="flex min-w-0 flex-col">
            <div
              className={cn(
                "border-apollo-border-strong text-muted-foreground justify-between border-b pb-1.5 text-[11px]",
                ci === 0 ? "flex" : "hidden sm:flex",
              )}
              aria-hidden="true"
            >
              <span>Research area</span>
              <span>Publications</span>
            </div>
            {col.map(({ area, rank }) => (
              <AreaPreviewPill
                key={area.topicId}
                area={area}
                preview={previews[area.topicId]}
                basePath={basePath}
                unitShort={unitShort}
                membersNoun={membersNoun}
                className={AREA_ROW_CLASS}
              >
                {/* One line per area: rank, name, bar, count. The bar sits
                    between name and count (fixed width) rather than on a second
                    line, so the list is as short as the divisions list. */}
                <span className="flex min-w-0 flex-1 items-baseline gap-3 text-[14px]">
                  <span className="flex min-w-0 flex-1 items-baseline">
                    <span
                      className="text-muted-foreground w-5 flex-none text-[12px] tabular-nums"
                      aria-hidden="true"
                    >
                      {rank}
                    </span>
                    <span className="text-apollo-slate min-w-0 decoration-1 underline-offset-4 group-hover:underline">
                      {area.topicLabel}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="bg-apollo-surface-2 hidden h-1 w-16 flex-none self-center rounded-sm sm:block"
                  >
                    <span
                      className="bg-apollo-border-strong block h-1 rounded-sm"
                      style={{ width: `${Math.round((area.pubCount / max) * 1000) / 10}%` }}
                    />
                  </span>
                  <span className="text-muted-foreground w-12 flex-none text-right text-[13px] whitespace-nowrap tabular-nums">
                    {area.pubCount.toLocaleString()}
                  </span>
                </span>
              </AreaPreviewPill>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A ranked research-area row: whole-row link, tinted on hover. */
const AREA_ROW_CLASS =
  "group border-apollo-border hover:bg-apollo-page flex items-baseline border-b py-[7px] no-underline transition-colors duration-[120ms] ease-out hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--apollo-ring)]";

export type UnitStat = { value: number; label: string; href: string };

/**
 * Stats line. Zero-valued stats are dropped by the caller; each surviving stat
 * is a link (value in 600 foreground, label muted) separated by a muted middle
 * dot. `fallback` renders when no stat survives (the center's "Membership data
 * pending"). `variant="inline"` sits directly under the unit name;
 * `"divider"` is the original dashed-rule line at the foot of the hero.
 */
export function UnitStatsLine({
  stats,
  fallback,
  variant = "divider",
}: {
  stats: UnitStat[];
  fallback?: ReactNode;
  variant?: "divider" | "inline";
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-wrap gap-x-3 gap-y-1.5",
        variant === "divider"
          ? "border-apollo-border-strong mt-[26px] border-t border-dashed pt-5 text-[15px]"
          : "mt-2.5 text-[14px]",
      )}
    >
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
