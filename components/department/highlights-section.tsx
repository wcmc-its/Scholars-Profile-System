/**
 * Generic "Three items surfaced by ReCiterAI" section — used by both the
 * Recent publications and Active grants highlight rows. Server Component.
 *
 * Layout: eyebrow + caveat header with a bottom rule, then a 3-column grid
 * with 1px vertical dividers between cards (no gap), followed by a "View all"
 * link to the corresponding tab.
 *
 * The section is suppressed (returns null) when `items` is empty per spec.
 */
import Link from "next/link";

type Props = {
  eyebrow: string;
  caveatItem: string;
  /** 3 cards max, but renders whatever is provided. */
  cards: React.ReactNode[];
  totalCount: number;
  viewAllHref: string;
  viewAllLabel: string;
};

export function HighlightsSection({
  eyebrow,
  caveatItem,
  cards,
  totalCount,
  viewAllHref,
  viewAllLabel,
}: Props) {
  if (cards.length === 0) return null;
  return (
    <section className="mt-10">
      <header className="flex items-baseline justify-between border-b border-[var(--color-border)] pb-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
          {eyebrow}
        </span>
        <span className="text-[12px] italic text-[var(--color-text-secondary)]">
          Three {caveatItem} surfaced by ReCiterAI &middot;{" "}
          <Link
            href="/about/methodology#department-highlights"
            className="not-italic text-[var(--color-accent-slate)] hover:underline"
          >
            how this works
          </Link>
        </span>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3">
        {cards.map((card, i) => (
          <div
            key={i}
            className={`p-4 ${
              i < cards.length - 1
                ? "md:border-r md:border-[var(--color-border)]"
                : ""
            }`}
          >
            {card}
          </div>
        ))}
      </div>
      <div className="mt-[14px]">
        <Link
          href={viewAllHref}
          className="text-[12px] font-medium text-[var(--color-accent-slate)] hover:underline"
        >
          View all {totalCount.toLocaleString()} {viewAllLabel} &rarr;
        </Link>
      </div>
    </section>
  );
}
