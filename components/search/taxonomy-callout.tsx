"use client";

/**
 * Taxonomy-match callout for /search.
 *
 * Single compact row when one entity matches; same row + a disclosure
 * affordance when 2+ match. Click the chevron to expand inline with up
 * to 4 secondary rows + an optional "additional matches in Browse →"
 * overflow row.
 *
 * The whole primary row navigates to the matched topic page; only the
 * disclosure chevron stays put. Two anchors (main content + CTA) plus
 * a button (disclosure) compose the multi-match primary; HTML doesn't
 * allow buttons inside anchors, so we layer two same-href links and
 * paint a unified hover state via a wrapping group.
 *
 * A11y / contrast notes:
 *   - Body / counts use zinc-600 not zinc-500 — zinc-500 (#71717a) on
 *     the #eef4f9 surface lands at 4.36:1, just below WCAG AA. zinc-600
 *     (#52525b) clears at 6.85:1.
 *   - Disclosure button has 24px+ tap area (px-2.5 py-1.5).
 *   - All focusable elements get an explicit slate ring on focus-visible
 *     so keyboard focus stays visible against the tinted surface.
 *   - Secondary list animates via a grid-template-rows transition so
 *     expand/collapse doesn't snap; aria-hidden keeps SR quiet when
 *     collapsed.
 */
import Link from "next/link";
import { useState } from "react";
import type { TaxonomyMatchResult, TaxonomyMatch } from "@/lib/api/search-taxonomy";

const SURFACE =
  "rounded-lg border border-[#d6e2ec] bg-[#eef4f9] transition-colors group-hover:bg-[#e6eef6] group-hover:border-[#c2d2df]";
const HOVER_GROUP = "group";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1";

export function TaxonomyCallout({ result }: { result: TaxonomyMatchResult }) {
  const [expanded, setExpanded] = useState(false);

  if (result.state === "none") return null;
  const { primary, secondary, overflowCount, query } = result;
  const hasDisclosure = secondary.length + overflowCount > 0;

  return (
    <div className="my-3">
      <div
        className={`${SURFACE} ${HOVER_GROUP} relative flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-[13.5px] leading-snug`}
      >
        <PrimaryContent match={primary} />
        {hasDisclosure ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="taxonomy-callout-secondary"
            onClick={() => setExpanded((v) => !v)}
            className={`shrink-0 rounded px-2.5 py-1.5 text-[12.5px] text-zinc-600 transition-colors hover:text-zinc-900 ${FOCUS_RING}`}
          >
            additional matches{" "}
            <span
              aria-hidden="true"
              className={`inline-block transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            >
              ▾
            </span>
          </button>
        ) : null}
        <PrimaryCta match={primary} />
      </div>

      {hasDisclosure ? (
        <div
          id="taxonomy-callout-secondary"
          aria-hidden={!expanded}
          className={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out ${
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <ul className="mt-1 flex min-h-0 flex-col gap-0.5 rounded-lg border border-[#d6e2ec] bg-[#eef4f9] px-3.5 py-2">
            {secondary.map((m) => (
              <li key={`${m.entityType}:${m.id}`}>
                <SecondaryRow match={m} />
              </li>
            ))}
            {overflowCount > 0 ? (
              <li>
                <Link
                  href={`/search?q=${encodeURIComponent(query)}`}
                  className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[12.5px] italic text-zinc-600 transition-colors hover:text-[var(--color-primary-cornell-red)] hover:no-underline ${FOCUS_RING}`}
                >
                  and {overflowCount} more matching research area
                  {overflowCount === 1 ? "" : "s"} in Browse &rarr;
                </Link>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PrimaryContent({ match }: { match: TaxonomyMatch }) {
  return (
    <Link
      href={match.href}
      className={`min-w-0 flex-1 rounded text-zinc-600 no-underline hover:no-underline ${FOCUS_RING}`}
      aria-label={ariaLabelFor(match)}
    >
      <span className="font-semibold text-zinc-900">{match.name}</span>
      <span> is a research area at WCM</span>
      <span className="text-zinc-600">
        {" "}
        &middot; {formatCount(match.scholarCount, "scholar")} &middot;{" "}
        {formatCount(match.publicationCount, "publication")}
      </span>
    </Link>
  );
}

function PrimaryCta({ match }: { match: TaxonomyMatch }) {
  return (
    <Link
      href={match.href}
      tabIndex={-1}
      aria-hidden="true"
      className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[var(--color-accent-slate)] no-underline transition-colors group-hover:text-[var(--color-primary-cornell-red)] hover:no-underline max-sm:mt-1.5 max-sm:w-full max-sm:border-t max-sm:border-[#d6e2ec] max-sm:pt-1.5"
    >
      View topic page &rarr;
    </Link>
  );
}

function SecondaryRow({ match }: { match: TaxonomyMatch }) {
  return (
    <Link
      href={match.href}
      aria-label={ariaLabelFor(match)}
      className={`group/row flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-[13px] no-underline transition-colors hover:bg-white/60 hover:no-underline ${FOCUS_RING}`}
    >
      <span className="min-w-0 flex-1 text-zinc-600">
        <span className="font-semibold text-zinc-900">{match.name}</span>
        <span className="text-zinc-600">
          {" "}
          &middot; {formatCount(match.scholarCount, "scholar")} &middot;{" "}
          {formatCount(match.publicationCount, "publication")}
        </span>
      </span>
      <span className="shrink-0 whitespace-nowrap text-[12.5px] font-medium text-[var(--color-accent-slate)] group-hover/row:text-[var(--color-primary-cornell-red)]">
        View &rarr;
      </span>
    </Link>
  );
}

function formatCount(n: number, noun: string): string {
  const formatted = n.toLocaleString();
  return n === 1 ? `${formatted} ${noun}` : `${formatted} ${noun}s`;
}

function ariaLabelFor(match: TaxonomyMatch): string {
  if (match.entityType === "parentTopic") {
    return `View ${match.name}, a research area at WCM`;
  }
  return `View ${match.name}, a subtopic of ${match.parentTopicLabel ?? "a research area"} at WCM`;
}
