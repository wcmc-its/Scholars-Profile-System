/**
 * §16 Spotlight surface — unified ReCiterAI publication highlight.
 *
 * Server Component. Cream surface, 1-3 publication cards in equal-width
 * columns separated by 1px vertical rules, with a singular/plural caveat
 * and a "View all N publications →" link. Renders nothing when given zero
 * cards (per spec: omit the surface entirely, no empty state).
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
import { sanitizePubTitle } from "@/lib/utils";
import { methodologyHref } from "@/lib/methodology-anchors";
import type { SpotlightData, SpotlightCard } from "@/lib/api/spotlight";

const COUNT_WORD = ["zero", "One", "Two", "Three"] as const;

export function Spotlight({ data }: { data: SpotlightData | null }) {
  if (!data || data.cards.length === 0) return null;
  const { cards, totalCount, viewAllHref } = data;

  const word = COUNT_WORD[cards.length] ?? String(cards.length);
  const noun = cards.length === 1 ? "publication" : "publications";
  const gridClass =
    cards.length === 3
      ? "md:grid-cols-3"
      : cards.length === 2
        ? "md:grid-cols-2"
        : "md:grid-cols-1 md:max-w-[600px]";

  return (
    <section className="my-8 rounded-[14px] bg-[#f5f3ee] px-[26px] pb-6 pt-[22px]">
      <header className="mb-[22px] flex flex-wrap items-baseline justify-between gap-[10px]">
        <h2 className="m-0 font-serif text-[22px] font-medium leading-[1.15] tracking-[-0.01em]">
          Spotlight
        </h2>
        <span className="text-[12.5px] italic text-[var(--color-text-tertiary)]">
          {word} {noun} surfaced by ReCiterAI ·{" "}
          <Link
            href={methodologyHref("spotlight")}
            className="not-italic underline decoration-black/25 underline-offset-2 hover:text-foreground"
          >
            how this works
          </Link>
        </span>
      </header>

      <div className={`grid grid-cols-1 ${gridClass}`}>
        {cards.map((card, i) => (
          <SpotlightPubCard key={card.pmid} card={card} index={i} total={cards.length} />
        ))}
      </div>

      <div className="mt-[22px]">
        <Link
          href={viewAllHref as never}
          className="border-b-[0.5px] border-black/25 pb-px text-[13px] text-[var(--color-text-secondary)] no-underline hover:text-foreground"
        >
          View all {totalCount.toLocaleString()} publications →
        </Link>
      </div>
    </section>
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
  const titleHtml = sanitizePubTitle(card.title);
  const titleHref = card.pubmedUrl ?? card.doi ?? "#";
  const isExternal = titleHref !== "#";

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
      <h3 className="m-0 text-[15px] font-medium leading-[1.35] tracking-[-0.005em] text-foreground line-clamp-3">
        <a
          href={titleHref}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          className="text-foreground no-underline hover:underline"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      </h3>
      <AuthorChipRow authors={card.authors} />
      <div className="mt-auto text-[12px] italic leading-[1.4] text-[var(--color-text-tertiary)]">
        {card.journal ? (
          <span
            dangerouslySetInnerHTML={{ __html: sanitizePubTitle(card.journal) }}
          />
        ) : null}
        {card.journal && card.year !== null ? " · " : null}
        {card.year !== null ? String(card.year) : null}
      </div>
    </article>
  );
}
