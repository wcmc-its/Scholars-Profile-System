"use client";

/**
 * One scholar card for `ScholarCardGrid`: a plain profile link below `md`, the
 * same link wrapped in the `taxonomy-card` PersonPopover at `md`+, both inside
 * the pick state that highlights the filtered scholar and dims the rest.
 *
 * Client-composed on purpose: Radix `HoverCardTrigger asChild` must get a
 * client-built element (see the grid's header comment).
 */
import type { ComponentProps } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import { ScholarCardPickState } from "@/components/taxonomy/scholar-filter";
import { profilePath } from "@/lib/profile-url";

const AREA_LIMIT = 3;

export type ScholarCardData = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  /** Up to 3 area labels (subareas / families). Empty → no bullets. */
  areas: string[];
};

export type ScholarCardPopover = {
  /** Names the scope in the popover ("N publications in {label}"). */
  label: string;
  /** Topic pages. */
  topicSlug?: string;
  /** Method pages: the supercategory id, plus the family label on a family page. */
  supercategory?: string;
  familyLabel?: string;
  /** The page's feed takes the scholar filter (topic, method family). */
  filterable?: boolean;
};

export function ScholarCard({
  scholar,
  popover,
}: {
  scholar: ScholarCardData;
  popover: ScholarCardPopover;
}) {
  return (
    <ScholarCardPickState cwid={scholar.cwid}>
      <ScholarCardLink scholar={scholar} className="flex md:hidden" />
      <PersonPopover
        cwid={scholar.cwid}
        surface="taxonomy-card"
        contextTopicSlug={popover.topicSlug}
        contextTopicLabel={popover.label}
        contextSupercategory={popover.supercategory}
        contextFamilyLabel={popover.familyLabel}
        filterable={popover.filterable}
      >
        <ScholarCardLink scholar={scholar} className="hidden md:flex" />
      </PersonPopover>
    </ScholarCardPickState>
  );
}

// Forwards the rest props (and ref, a prop in React 19): as the hover trigger's
// `asChild` child it must carry Radix's handlers and data-state onto the <a>.
function ScholarCardLink({
  scholar,
  className,
  ...rest
}: { scholar: ScholarCardData; className: string } & ComponentProps<"a">) {
  const areas = scholar.areas.slice(0, AREA_LIMIT);
  return (
    <a
      {...rest}
      href={profilePath(scholar.slug)}
      data-testid="scholar-card"
      className={`${className} border-border bg-background min-h-11 w-full min-w-0 items-start gap-3 rounded-[10px] border px-3.5 py-3 transition-colors hover:border-[var(--color-accent-slate)] group-data-[pick=picked]/pick:border-apollo-slate group-data-[pick=picked]/pick:bg-apollo-slate-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)] sm:h-full`}
    >
      <HeadshotAvatar
        size="md"
        cwid={scholar.cwid}
        preferredName={scholar.preferredName}
        identityImageEndpoint={scholar.identityImageEndpoint}
        className="mt-0.5 shrink-0"
        fallbackTone="rail"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[14px] font-[650] text-pretty [overflow-wrap:anywhere]">
          {scholar.preferredName}
        </span>
        {scholar.primaryTitle ? (
          <span className="text-muted-foreground text-[13px] leading-[1.35] text-pretty [overflow-wrap:anywhere]">
            {scholar.primaryTitle}
          </span>
        ) : null}
        {areas.length > 0 && (
          // Mockup areaStyle="Bullets": 4px WCM-red dot, text wraps under
          // itself (hanging indent), no chip fill. Same at every width.
          <ul className="mt-1.5 flex min-w-0 flex-col gap-0.5" data-testid="scholar-card-areas">
            {areas.map((a) => (
              <li
                key={a}
                data-testid="scholar-card-area"
                className="flex min-w-0 items-baseline gap-[7px] text-[12.5px] leading-[1.4]"
              >
                <span
                  aria-hidden
                  className="size-1 shrink-0 -translate-y-0.5 rounded-full bg-[var(--color-primary-cornell-red)]"
                />
                <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">{a}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </a>
  );
}
