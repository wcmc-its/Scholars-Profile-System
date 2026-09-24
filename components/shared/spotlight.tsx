"use client";

/**
 * §16 Spotlight surface — unified ReCiterAI publication highlight.
 *
 * Client Component (title click opens the shared publication modal — see
 * card title below). Cream surface, 1-3 publication cards in equal-width
 * columns separated by 1px vertical rules, with a singular/plural caveat
 * and a "View all N publications →" link. Renders nothing when given zero
 * cards (per spec: omit the surface entirely, no empty state).
 *
 * `variant="unit"` (department / center / division pages only — Unit Page
 * v2): warm surface-2 panel, auto-fit grid (min 260px), a 1px left rule on
 * every card, trailing-period tidy + full-title tooltip, the venue line
 * pinned to the card bottom, and the 28px spotlight author chips. Topic and
 * methods pages pass no variant and keep the original rendering.
 *
 * Visual contract: `.planning/source-docs/spotlight-departments-and-friends.html`.
 * Data contract: `SpotlightData` from `lib/api/spotlight.ts`.
 *
 * Slice 1 callers: topic page, department page. Slices 2/3 add center +
 * division. The home-page Spotlight (eight-subtopic carousel) is a
 * different surface and is not affected.
 */
import Link from "next/link";
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { pubTitleProps } from "@/components/publication/pub-html";
import { htmlToPlainText, sanitizePubTitle } from "@/lib/utils";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import { usePublicationModal } from "@/components/publication/publication-modal";
import type { SpotlightData, SpotlightCard } from "@/lib/api/spotlight";

/** Unit Page v2 `tidy()` — drop a title's trailing period, including one that
 *  sits before closing inline tags (e.g. `…in the <i>gut</i>.`). */
function stripTrailingPeriod(html: string): string {
  return html.replace(/\.(\s*(?:<\/[a-z]+>\s*)*)$/i, "$1");
}

export type SpotlightVariant = "default" | "unit";

export function Spotlight({
  data,
  variant = "default",
}: {
  data: SpotlightData | null;
  variant?: SpotlightVariant;
}) {
  if (!data || data.cards.length === 0) return null;
  const { cards, totalCount, viewAllHref } = data;
  const unit = variant === "unit";

  const gridClass =
    cards.length === 3
      ? "md:grid-cols-3"
      : cards.length === 2
        ? "md:grid-cols-2"
        : "md:grid-cols-1 md:max-w-[600px]";

  const viewAll = (
    <Link
      href={viewAllHref as never}
      className={
        unit
          ? "mt-7 inline-block text-[14px] text-foreground underline decoration-apollo-border-strong underline-offset-[3px] hover:text-apollo-slate"
          : "border-b-[0.5px] border-black/25 pb-px text-[13px] text-[var(--color-text-secondary)] no-underline hover:text-foreground"
      }
    >
      View all {totalCount.toLocaleString()} publications →
    </Link>
  );

  // Unit variant: cards flow in an auto-fit grid (min 260px) and every card
  // carries a left rule (the card's -1px overlap keeps adjacent rules
  // single-width).
  return (
    <section
      className={
        unit
          ? "my-8 rounded-[13px] bg-apollo-surface-2 px-[26px] pb-7 pt-[26px]"
          : "my-8 rounded-[14px] bg-[#f5f3ee] px-[26px] pb-6 pt-[22px]"
      }
    >
      <header className={unit ? "mb-5" : "mb-[22px]"}>
        <h2
          className={
            unit
              ? "m-0 inline-flex items-center gap-2 text-[22px] font-medium leading-[28px]"
              : "m-0 inline-flex items-center gap-2 text-[22px] font-medium leading-[1.15] tracking-[-0.01em]"
          }
        >
          Spotlight
          <SectionInfoButton label="Spotlight" anchor="spotlight">
            Spotlight rotates publications with the strongest recent activity
            in a research area, scored by ReCiterAI from PubMed records.
            Refreshes weekly.
          </SectionInfoButton>
        </h2>
      </header>

      <div
        className={
          unit
            ? "grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-0 gap-y-6"
            : `grid grid-cols-1 ${gridClass}`
        }
      >
        {cards.map((card, i) =>
          unit ? (
            <UnitSpotlightPubCard key={card.pmid} card={card} />
          ) : (
            <SpotlightPubCard key={card.pmid} card={card} index={i} total={cards.length} />
          ),
        )}
      </div>

      {unit ? viewAll : <div className="mt-[22px]">{viewAll}</div>}
    </section>
  );
}

/* line-clamp lives on the click target, not the <h3>: clamping it keeps its
   bounding box equal to the visible 3 lines. With the clamp on the h3
   instead, the inner target's box spanned the full (un-clamped) title and
   overlapped the author-chip row below it, tripping axe target-size (WCAG
   2.5.8) even though the layout looked fine (#586). Same visual result,
   target box now matches the clamp. Opens the shared publication modal on
   click, same as every other publication surface (profile, topic-feed,
   search) — previously linked straight to PubMed/DOI, inconsistent with the
   rest of the site. Applies to both card variants below. */

function SpotlightVenue({ card, className }: { card: SpotlightCard; className: string }) {
  return (
    <div className={className}>
      {card.journal ? (
        <span
          dangerouslySetInnerHTML={{ __html: sanitizePubTitle(card.journal) }}
        />
      ) : null}
      {card.journal && card.year !== null ? " · " : null}
      {card.year !== null ? String(card.year) : null}
    </div>
  );
}

function SpotlightPubCard({
  card,
  index,
  total,
}: {
  card: SpotlightCard;
  index: number;
  total: number;
}) {
  const { open } = usePublicationModal();
  const titleHtml = sanitizePubTitle(card.title);

  // First card has no left rule; subsequent cards add a left rule on md+.
  // On mobile (single column), each card after the first gets a top rule.
  const dividerClass =
    index === 0
      ? "md:pl-0 md:border-l-0"
      : "border-t border-black/10 pt-[22px] md:border-t-0 md:pt-0 md:border-l md:border-l-black/10 md:pl-[22px]";
  const rightPadClass = index < total - 1 ? "md:pr-[22px]" : "";

  return (
    <article className={`flex flex-col gap-[11px] ${dividerClass} ${rightPadClass}`}>
      {card.kickerHref ? (
        <Link
          href={card.kickerHref as never}
          className="text-[10.5px] font-medium uppercase tracking-[0.08em] leading-[1.4] text-[var(--color-primary-cornell-red)] no-underline hover:underline"
        >
          {card.kicker}
        </Link>
      ) : (
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] leading-[1.4] text-[var(--color-primary-cornell-red)]">
          {card.kicker}
        </span>
      )}
      <h3 className="m-0 text-[15px] font-medium leading-[1.35] tracking-[-0.005em] text-foreground">
        <button
          type="button"
          onClick={() => open(card.pmid)}
          aria-haspopup="dialog"
          {...pubTitleProps(titleHtml, "line-clamp-3 text-left text-foreground hover:underline")}
        />
      </h3>
      <AuthorChipRow authors={card.authors} pmid={card.pmid} />
      <SpotlightVenue
        card={card}
        className="text-[12px] italic leading-[1.4] text-[var(--color-text-tertiary)]"
      />
    </article>
  );
}

function UnitSpotlightPubCard({ card }: { card: SpotlightCard }) {
  const { open } = usePublicationModal();
  const titleHtml = stripTrailingPeriod(sanitizePubTitle(card.title));
  const fullTitle = htmlToPlainText(card.title, Number.POSITIVE_INFINITY);
  const kickerClass =
    "line-clamp-2 min-h-[30px] text-[11px] font-semibold uppercase leading-[15px] tracking-[0.1em] text-[var(--color-primary-cornell-red)]";

  return (
    <article className="-ml-px flex flex-col gap-3 border-l border-apollo-border-strong px-[22px]">
      {card.kickerHref ? (
        <Link
          href={card.kickerHref as never}
          className={`${kickerClass} no-underline hover:underline`}
        >
          {card.kicker}
        </Link>
      ) : (
        <span className={kickerClass}>{card.kicker}</span>
      )}
      <h3 className="m-0 text-[15.5px] font-medium leading-[21px] text-foreground">
        <button
          type="button"
          onClick={() => open(card.pmid)}
          aria-haspopup="dialog"
          title={fullTitle || undefined}
          {...pubTitleProps(
            titleHtml,
            "line-clamp-3 text-pretty text-left text-foreground underline-offset-[3px] transition-colors duration-[120ms] ease-out hover:text-apollo-slate hover:underline",
          )}
        />
      </h3>
      <AuthorChipRow authors={card.authors} pmid={card.pmid} variant="spotlight" />
      <SpotlightVenue card={card} className="mt-auto text-[13px] italic text-muted-foreground" />
    </article>
  );
}
