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
 * Server-renderable (no hooks). Each card is ONE client boundary
 * (`ScholarCard`): the Radix hover trigger (`asChild`) must receive a link
 * built on the client. A server-built link passed across the boundary can
 * arrive as an unresolved reference, and the trigger then renders nothing.
 */
import {
  ScholarCard,
  type ScholarCardData,
  type ScholarCardPopover,
} from "@/components/taxonomy/scholar-card";
import { SectionInfoButton } from "@/components/shared/section-info-button";

export type { ScholarCardData, ScholarCardPopover };

export const SCHOLAR_CARD_LIMIT = 6;

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
            <ScholarCard scholar={s} popover={popover} />
          </li>
        ))}
      </ul>
    </section>
  );
}
