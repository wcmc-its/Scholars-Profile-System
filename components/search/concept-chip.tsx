/**
 * Issue #259 §1.11 — resolved-concept chip for the publications tab.
 *
 * Renders above the result tabs when a query resolves to a MeSH descriptor
 * (§1.5). Shape:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Showing pubs for MeSH concept: Electronic Health Records    │
 *   │  Matched your search for "EHR" · Search broadly instead ✕    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 *   - Hover/focus on the descriptor name surfaces the scope note in the
 *     shared `HoverTooltip` pill (dark zinc-900, white text — the chip-
 *     aesthetic used everywhere else). Immediate-on-hover (no 200ms
 *     delay) and `wide` so a sentence-length scope note wraps cleanly
 *     instead of overflowing.
 *   - "Search broadly instead" links to the same URL with `mesh=off` added,
 *     which the page reads to suppress the resolution before passing it
 *     to `searchPublications`. The §1.2 msm floor stays in force; the
 *     §1.6 OR-of-evidence shape is bypassed.
 *   - Renders independently of `TaxonomyCallout`; spec §1.11 says "Chip
 *     appears in addition to the existing curated-topic callout when both
 *     fire."
 *   - Server Component — purely presentational, no hooks. The escape link
 *     navigates; no client-side state required.
 */
import Link from "next/link";
import { Tag } from "lucide-react";
import type { MeshResolution } from "@/lib/api/search-taxonomy";
import { HoverTooltip } from "@/components/ui/hover-tooltip";

export function ConceptChip({
  resolution,
  matchedQuery,
  broadenHref,
}: {
  /** Non-null MeSH resolution from `matchQueryToTaxonomy` (§1.5). The
   *  page should only render this component when the resolution is
   *  present AND the user has not already opted into broad mode via
   *  `mesh=off`. */
  resolution: MeshResolution;
  /** Original query string for the secondary line. Distinct from
   *  `resolution.matchedForm` (the surface form that triggered the match);
   *  showing the raw user input keeps the line legible when the resolution
   *  came from an entry-term match like "EHR" → "Electronic Health Records". */
  matchedQuery: string;
  /** URL for the "Search broadly instead" escape; the page builds this
   *  with the current params + `mesh=off` so the user lands on the same
   *  tab/filters/sort but with the resolution suppressed. */
  broadenHref: string;
}) {
  // Surface tint and border match TaxonomyCallout for visual consistency
  // (#eef4f9 / #d6e2ec); the chip is a different affordance but lives in
  // the same band of the page and shouldn't visually compete.
  return (
    <div
      className="my-3 rounded-lg border border-[#d6e2ec] bg-[#eef4f9] px-3.5 py-2.5 text-[13.5px] leading-snug"
      aria-label="Search refined by MeSH concept"
    >
      <div className="flex items-start gap-2.5">
        <Tag
          aria-hidden
          className="mt-[2px] h-4 w-4 shrink-0 text-[var(--color-accent-slate)]"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1">
          <div className="text-zinc-600">
            Showing pubs for MeSH concept:{" "}
            {/* Scope-note tooltip uses the shared dark-pill aesthetic via
                HoverTooltip. Immediate-on-hover (no 200ms delay) so the
                description appears the moment the user lands on the name.
                Wide layout wraps sentence-length scope notes (NLM data
                ranges from a few words to a short paragraph). Descriptors
                without a scope note render a plain span so we don't
                attach an empty-text tooltip target. */}
            {resolution.scopeNote ? (
              <HoverTooltip
                text={resolution.scopeNote}
                immediate
                wide
                placement="bottom"
              >
                <span
                  tabIndex={0}
                  className="cursor-help font-semibold text-zinc-900 underline decoration-dotted decoration-zinc-400 underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
                >
                  {resolution.name}
                </span>
              </HoverTooltip>
            ) : (
              <span className="font-semibold text-zinc-900">
                {resolution.name}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12.5px] text-zinc-600">
            Matched your search for{" "}
            <span className="font-medium text-zinc-700">
              &ldquo;{matchedQuery}&rdquo;
            </span>
            {" · "}
            <Link
              href={broadenHref}
              className="text-[var(--color-accent-slate)] no-underline hover:text-[var(--color-primary-cornell-red)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
            >
              Search broadly instead &#x2715;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
