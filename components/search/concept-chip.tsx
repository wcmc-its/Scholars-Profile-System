/**
 * Issue #259 §1.11 / §6.1 — resolved-concept chip for the publications tab.
 *
 * Renders above the result tabs when a query resolves to a MeSH descriptor
 * (§1.5). The chip carries three modes, each surfacing a different set of
 * affordances per SPEC §6.1:
 *
 *   "strict"          — flag = strict / pre-PR-3 prod behavior. Today's copy:
 *                        "Showing pubs for MeSH concept: «X»" + "Search broadly instead ✕"
 *   "expanded_default" — flag = expanded, no chip override. New copy:
 *                        "Boosted by MeSH concept: «X»" + "Narrow to this concept only · Don't use MeSH ✕"
 *   "expanded_narrow" — `?mesh=strict` engaged. New copy:
 *                        "Narrowed to MeSH concept: «X»" + "Expand to related ✕"
 *
 * The required hrefs differ per mode; the props are a TypeScript
 * discriminated union so caller mistakes (missing `narrowHref` in
 * `expanded_default`, missing `expandHref` in `expanded_narrow`) fail at
 * build time, not runtime.
 *
 *   - Hover/focus on the descriptor name surfaces the scope note in the
 *     shared `HoverTooltip` pill (dark zinc-900, white text — the chip-
 *     aesthetic used everywhere else). Immediate-on-hover (no 200ms
 *     delay) and `wide` so a sentence-length scope note wraps cleanly
 *     instead of overflowing. Behavior unchanged across all three modes.
 *   - Surface tint and border match TaxonomyCallout for visual consistency
 *     (#eef4f9 / #d6e2ec); the chip is a different affordance but lives in
 *     the same band of the page and shouldn't visually compete.
 *   - Server Component — purely presentational, no hooks. Each link is a
 *     Next `<Link>` that navigates to the URL the page computed.
 */
import Link from "next/link";
import { Tag } from "lucide-react";
import type { MeshResolution } from "@/lib/api/search-taxonomy";
import { HoverTooltip } from "@/components/ui/hover-tooltip";

type ConceptChipProps =
  | {
      mode: "strict";
      resolution: MeshResolution;
      matchedQuery: string;
      /** URL for the "Search broadly instead" escape — `?mesh=off`. */
      broadenHref: string;
    }
  | {
      mode: "expanded_default";
      resolution: MeshResolution;
      matchedQuery: string;
      /** URL for the "Narrow to this concept only" link — `?mesh=strict`. */
      narrowHref: string;
      /** URL for the "Don't use MeSH ✕" link — `?mesh=off`. */
      broadenHref: string;
    }
  | {
      mode: "expanded_narrow";
      resolution: MeshResolution;
      matchedQuery: string;
      /** URL for the "Expand to related ✕" link — mesh param stripped. */
      expandHref: string;
    };

export function ConceptChip(props: ConceptChipProps) {
  const { resolution, matchedQuery, mode } = props;

  const heading =
    mode === "strict"
      ? "Showing pubs for MeSH concept:"
      : mode === "expanded_default"
        ? "Boosted by MeSH concept:"
        : "Narrowed to MeSH concept:";

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
            {heading}{" "}
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
            {mode === "strict" ? (
              <>
                {" · "}
                <Link
                  href={props.broadenHref}
                  className="text-[var(--color-accent-slate)] no-underline hover:text-[var(--color-primary-cornell-red)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
                >
                  Search broadly instead &#x2715;
                </Link>
              </>
            ) : mode === "expanded_default" ? (
              <>
                {" · "}
                <Link
                  href={props.narrowHref}
                  className="text-[var(--color-accent-slate)] no-underline hover:text-[var(--color-primary-cornell-red)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
                >
                  Narrow to this concept only
                </Link>
                {" · "}
                <Link
                  href={props.broadenHref}
                  className="text-[var(--color-accent-slate)] no-underline hover:text-[var(--color-primary-cornell-red)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
                >
                  Don&rsquo;t use MeSH &#x2715;
                </Link>
              </>
            ) : (
              <>
                {" · "}
                <Link
                  href={props.expandHref}
                  className="text-[var(--color-accent-slate)] no-underline hover:text-[var(--color-primary-cornell-red)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
                >
                  Expand to related &#x2715;
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
