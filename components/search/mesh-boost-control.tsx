"use client";

/**
 * Issue #638 — MeSH boost control (replaces the full-width ConceptChip
 * banner). A collapsible control that lives in the publications toolbar
 * (its own full-width row, above Export/Sort), with the off-switch exposed
 * at rest.
 *
 * Mirrors ConceptChip's three env-flag-driven modes (§259 §6.1) so the copy
 * stays mechanism-accurate — "Boosted via MeSH" only in expanded_default,
 * where the descriptor re-weights recall rather than filtering:
 *
 *   strict           → "Showing pubs for MeSH concept: «X»"  off: Search broadly instead
 *   expanded_default → "Boosted via MeSH: «X»"               off: Don't use MeSH      panel: Narrow to this concept only
 *   expanded_narrow  → "Narrowed to MeSH concept: «X»"       off: Expand to related
 *
 * Resting row: sparkle + heading + concept name + chevron trigger, with a
 * SEPARATE off-switch <Link> (not nested in the trigger — HTML forbids nested
 * interactive content, and a separate control avoids click-target ambiguity).
 * Chevron reveals a panel (the optional narrow link + the existing
 * "Search interpretation" affordance, passed in as `interpretationSlot`).
 *
 * Default open state: collapsed when the resolved concept equals the query
 * (nothing surprising to show); open when they differ (e.g. "IVF" →
 * "Reproductive Medicine") — exactly the case the user needs to see.
 *
 * The scope-note hover lives inside the "Search interpretation" popover, so
 * the resting concept name stays a plain span (no nested focusable element).
 */
import * as React from "react";
// Route the off-switch + "Narrow to this concept only" links through the
// shared search useTransition (same as facet / sort / pagination links) so a
// concept-mode change dims the results in place instead of leaving the page
// frozen with no feedback. Outside a SearchTransitionProvider TransitionLink
// still navigates via router.push, so the control degrades gracefully.
import { TransitionLink as Link } from "@/components/search/transition-link";
import { ChevronDown, Sparkles, X } from "lucide-react";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1";
const PANEL_LINK =
  "text-[var(--color-accent-slate)] no-underline hover:text-[var(--color-primary-cornell-red)] hover:underline";

type BaseProps = {
  resolution: MeshResolution;
  /** Raw user query — drives the default open/closed compare. */
  matchedQuery: string;
  /** The existing <SearchInterpretationPopover>, rendered inside the panel. */
  interpretationSlot?: React.ReactNode;
};

type MeshBoostControlProps = BaseProps &
  (
    | { mode: "strict"; broadenHref: string }
    | { mode: "expanded_default"; narrowHref: string; broadenHref: string }
    | { mode: "expanded_narrow"; expandHref: string }
  );

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function MeshBoostControl(props: MeshBoostControlProps) {
  const { resolution, matchedQuery, mode, interpretationSlot } = props;
  const panelId = React.useId();
  // Open when the resolved concept differs from the typed query (the
  // surprising case worth surfacing unprompted); collapsed when they match.
  const [open, setOpen] = React.useState(
    () => normalize(resolution.name) !== normalize(matchedQuery),
  );

  const heading =
    mode === "strict"
      ? "Showing pubs for MeSH concept:"
      : mode === "expanded_default"
        ? "Boosted via MeSH:"
        : "Narrowed to MeSH concept:";

  // The resting off-switch. expanded_narrow's escape re-expands ("clear")
  // rather than disabling; strict / expanded_default disable via mesh=off.
  // WCAG 2.5.3 (Label in Name): the accessible name must start with the
  // visible text so voice-control users can activate by what they read.
  const offSwitch =
    mode === "expanded_narrow"
      ? {
          href: props.expandHref,
          label: "Expand to related",
          aria: "Expand to related concepts — re-enable broader MeSH boosting",
        }
      : mode === "strict"
        ? {
            href: props.broadenHref,
            label: "Search broadly instead",
            aria: "Search broadly instead — turn off MeSH boosting",
          }
        : {
            href: props.broadenHref,
            label: "Don't use MeSH",
            aria: "Don't use MeSH — turn off MeSH boosting",
          };

  const narrowHref = mode === "expanded_default" ? props.narrowHref : null;
  // Panel is worth a chevron only when it has content (narrow link and/or
  // the interpretation affordance). It always has the interpretation slot in
  // practice, but guard so an empty panel never ships a dead toggle.
  const hasPanel = Boolean(narrowHref) || Boolean(interpretationSlot);

  return (
    <div
      className="my-3 rounded-md border border-[#d6e2ec] bg-[#eef4f9] text-[13.5px] leading-snug"
      aria-label="Search refined by MeSH concept"
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        {hasPanel ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded text-left text-zinc-600 ${FOCUS_RING}`}
          >
            <Sparkles
              aria-hidden
              className="h-4 w-4 shrink-0 text-[var(--color-accent-slate)]"
              strokeWidth={2}
            />
            <span className="min-w-0 truncate">
              {heading}{" "}
              <span className="font-semibold text-zinc-900">{resolution.name}</span>
            </span>
            <ChevronDown
              aria-hidden
              className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              strokeWidth={2}
            />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-zinc-600">
            <Sparkles
              aria-hidden
              className="h-4 w-4 shrink-0 text-[var(--color-accent-slate)]"
              strokeWidth={2}
            />
            <span className="min-w-0 truncate">
              {heading}{" "}
              <span className="font-semibold text-zinc-900">{resolution.name}</span>
            </span>
          </div>
        )}
        <Link
          href={offSwitch.href}
          aria-label={offSwitch.aria}
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-[#c8c6be] bg-white px-2.5 py-1 text-[12px] whitespace-nowrap text-zinc-600 no-underline transition-colors hover:border-[var(--color-accent-slate)] hover:text-zinc-900 ${FOCUS_RING}`}
        >
          {offSwitch.label} <X aria-hidden className="h-3 w-3" strokeWidth={2} />
        </Link>
      </div>

      {hasPanel ? (
        <div
          id={panelId}
          aria-hidden={!open}
          // Collapsed rows stay in the DOM but `inert` removes them from the
          // tab order + a11y tree (WCAG 4.1.2), matching TaxonomyCallout #575.
          inert={!open}
          className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
        >
          <div className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#d6e2ec] px-3.5 py-2.5 text-[12.5px]">
              {narrowHref ? (
                <Link href={narrowHref} className={`${PANEL_LINK} ${FOCUS_RING}`}>
                  Narrow to this concept only
                </Link>
              ) : null}
              {interpretationSlot ? (
                <span className="ml-auto">{interpretationSlot}</span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
