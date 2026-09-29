/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — the "Scholars in this area" / "Scholars
 * using this" block on topic, method family and method category pages. Replaces
 * `TopScholarsChipRow` when the flag is on.
 *
 * Top 6 portrait cards: headshot (initials fallback), name, title, and up to 3
 * area bullets (topic → the scholar's top subareas; category → their families;
 * family → none). Each card is ONE link to the profile. Name and title wrap in
 * full (no ellipsis).
 *
 * Layout: 1 column below `sm`, 2 at `sm`, 3 at `lg`; the whole card is one
 * link. Areas are a bulleted list (red 4px dots, wrapping with a hanging
 * indent) at every width. Every text run is `min-w-0` + `overflow-wrap:
 * anywhere` so a long label cannot push the page wider than a 390px viewport.
 *
 * Hover card (`taxonomy-card` surface): the scholar's paper count in the page's
 * scope, their two most recent, and "Filter publications →" where the page's
 * feed takes a scholar filter. The picked card highlights and the rest dim
 * (`ScholarCardPickState`). The PersonPopover wraps the card only at `md`+. Radix HoverCard
 * never opens on touch, and its trigger `preventDefault`s touchstart, which on
 * iOS swallows the link's click, so the narrow-viewport copy is a plain link.
 *
 * Server-renderable (no hooks); `PersonPopover`, `ScholarCardPickState` and
 * `SectionInfoButton` are the client boundaries, composed inside their own modules.
 */
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { PersonPopover } from "@/components/scholar/person-popover";
import { ScholarCardPickState } from "@/components/taxonomy/scholar-filter";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import { profilePath } from "@/lib/profile-url";

export const SCHOLAR_CARD_LIMIT = 6;
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

export function ScholarCardGrid({
  heading,
  scholars,
  viewAll,
  popover,
}: {
  heading: string;
  scholars: ScholarCardData[];
  /** "View all N scholars →". Omitted where no scholars page exists. */
  viewAll?: { href: string; count: number } | null;
  popover: ScholarCardPopover;
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
            className="text-apollo-slate ml-auto inline-flex min-h-11 items-center text-sm underline-offset-4 hover:underline sm:min-h-0"
          >
            View all {viewAll.count.toLocaleString()} {viewAll.count === 1 ? "scholar" : "scholars"}{" "}
            →
          </a>
        )}
      </div>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3.5 lg:grid-cols-3">
        {shown.map((s) => (
          <li key={s.cwid} className="min-w-0">
            <ScholarCardPickState cwid={s.cwid}>
              <ScholarCardLink scholar={s} className="flex md:hidden" />
              <PersonPopover
                cwid={s.cwid}
                surface="taxonomy-card"
                contextTopicSlug={popover.topicSlug}
                contextTopicLabel={popover.label}
                contextSupercategory={popover.supercategory}
                contextFamilyLabel={popover.familyLabel}
                filterable={popover.filterable}
              >
                <ScholarCardLink scholar={s} className="hidden md:flex" />
              </PersonPopover>
            </ScholarCardPickState>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScholarCardLink({ scholar, className }: { scholar: ScholarCardData; className: string }) {
  const areas = scholar.areas.slice(0, AREA_LIMIT);
  return (
    <a
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
