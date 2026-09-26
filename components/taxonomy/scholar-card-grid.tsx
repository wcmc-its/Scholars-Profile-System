/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — the "Scholars in this area" / "Scholars
 * using this" block on topic, method family and method category pages. Replaces
 * `TopScholarsChipRow` when the flag is on.
 *
 * Top 6 portrait cards: headshot (initials fallback), name, title, and up to 3
 * area chips (topic → the scholar's top subareas; category → their families;
 * family → none). Each card is ONE link to the profile.
 *
 * Layout: 1 column below `sm` as compact horizontal rows (min-h-11, the whole
 * row one link, areas collapsed to one truncated line), 2 columns at `sm`, 3 at
 * `lg`. Every text run is `min-w-0` + truncated / line-clamped so a long title
 * cannot push the page wider than a 390px viewport.
 *
 * Hover card: the PersonPopover wraps the card only at `md`+. Radix HoverCard
 * never opens on touch, and its trigger `preventDefault`s touchstart, which on
 * iOS swallows the link's click, so the narrow-viewport copy is a plain link.
 *
 * Server-renderable (no hooks); `PersonPopover` and `SectionInfoButton` are the
 * client boundaries, composed inside their own modules.
 */
import type { ReactElement } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import { profilePath } from "@/lib/profile-url";

export const SCHOLAR_CARD_LIMIT = 6;
const AREA_CHIP_LIMIT = 3;

export type ScholarCardData = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  /** Up to 3 area labels (subareas / families). Empty → no chips. */
  areas: string[];
};

export type ScholarCardPopover = {
  /** Topic pages: the popover's "Recent in {topic}" context. */
  topicSlug?: string;
  topicLabel?: string;
  /** Method pages: add the "Prominent method families" section (#853). */
  contextMethods?: boolean;
};

export function ScholarCardGrid({
  heading,
  scholars,
  viewAll,
  popover = {},
}: {
  heading: string;
  scholars: ScholarCardData[];
  /** "View all N scholars →". Omitted where no scholars page exists. */
  viewAll?: { href: string; count: number } | null;
  popover?: ScholarCardPopover;
}) {
  const shown = scholars.slice(0, SCHOLAR_CARD_LIMIT);
  if (shown.length === 0) return null;
  const headingId = "scholar-card-grid-heading";

  return (
    <section aria-labelledby={headingId} className="mt-8 min-w-0" data-testid="scholar-card-grid">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="inline-flex items-center gap-1.5 text-xl font-medium">
          {heading}
          <SectionInfoButton label={heading} anchor="topScholars">
            Full-time faculty identified by ReCiterAI from their first- or senior-author
            publications in this research area. Curators do not handpick this list; it updates
            weekly as new work appears.
          </SectionInfoButton>
        </h2>
        {viewAll && viewAll.count > 0 && (
          <a
            href={viewAll.href}
            className="ml-auto text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            View all {viewAll.count.toLocaleString()} {viewAll.count === 1 ? "scholar" : "scholars"}{" "}
            →
          </a>
        )}
      </div>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3.5 lg:grid-cols-3">
        {shown.map((s) => (
          <li key={s.cwid} className="min-w-0">
            <ScholarCardLink scholar={s} className="md:hidden" />
            <WithPopover scholar={s} popover={popover}>
              <ScholarCardLink scholar={s} className="hidden md:flex" />
            </WithPopover>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WithPopover({
  scholar,
  popover,
  children,
}: {
  scholar: ScholarCardData;
  popover: ScholarCardPopover;
  children: ReactElement;
}) {
  if (popover.topicSlug) {
    return (
      <PersonPopover
        cwid={scholar.cwid}
        surface="top-scholar"
        contextTopicSlug={popover.topicSlug}
        contextTopicLabel={popover.topicLabel}
      >
        {children}
      </PersonPopover>
    );
  }
  return (
    <PersonPopover
      cwid={scholar.cwid}
      surface="top-scholar"
      contextMethods={popover.contextMethods}
    >
      {children}
    </PersonPopover>
  );
}

function ScholarCardLink({ scholar, className }: { scholar: ScholarCardData; className: string }) {
  const areas = scholar.areas.slice(0, AREA_CHIP_LIMIT);
  return (
    <a
      href={profilePath(scholar.slug)}
      data-testid="scholar-card"
      className={`${className} border-border bg-background min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:border-[var(--color-accent-slate)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)] sm:h-full sm:items-start sm:px-3.5 sm:py-3`}
    >
      <HeadshotAvatar
        size="md"
        cwid={scholar.cwid}
        preferredName={scholar.preferredName}
        identityImageEndpoint={scholar.identityImageEndpoint}
        className="shrink-0 max-sm:h-10 max-sm:w-10"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{scholar.preferredName}</span>
        {scholar.primaryTitle ? (
          <span className="text-muted-foreground truncate text-[13px] leading-snug sm:line-clamp-2 sm:[overflow-wrap:anywhere] sm:whitespace-normal">
            {scholar.primaryTitle}
          </span>
        ) : null}
        {areas.length > 0 && (
          <>
            {/* Compact row: one truncated line. */}
            <span className="text-muted-foreground truncate text-xs sm:hidden">
              {areas.join(" · ")}
            </span>
            <span
              className="mt-1.5 hidden min-w-0 flex-wrap gap-1 sm:flex"
              data-testid="scholar-card-areas"
            >
              {areas.map((a) => (
                <span
                  key={a}
                  className="bg-muted text-foreground max-w-full truncate rounded-full px-2 py-0.5 text-[11.5px] leading-snug"
                >
                  {a}
                </span>
              ))}
            </span>
          </>
        )}
      </span>
    </a>
  );
}
