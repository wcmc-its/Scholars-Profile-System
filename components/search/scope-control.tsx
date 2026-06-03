import Link from "next/link";
import { Info, Sparkles } from "lucide-react";
import type { Scope } from "@/lib/api/search-flags";

/**
 * PLAN R2/R3 — the unified match-scope affordance shared by all three search
 * tabs. Replaces the "Boosted via MeSH" banner (`mesh-boost-control`) and the
 * standalone "Search interpretation" popover (#265, `search-interpretation-popover`).
 *
 *  - `ScopeControl` — three always-visible inline text options (no dropdown),
 *    styled to match the existing Funding Sort links; each navigates to its
 *    `?match=` URL (built by `buildScopeHref`).
 *  - `ScopeNote` — one quiet explanation line (no banner card) with a trailing
 *    ⓘ that exposes the MeSH definition on hover AND keyboard focus.
 *
 * Both render only when a query→MeSH mapping exists (the caller gates on the
 * resolved concept label), per R3.
 */

const SCOPE_OPTIONS: ReadonlyArray<{ value: Scope; label: string }> = [
  { value: "exact", label: "Exact word" },
  { value: "expanded", label: "Word + concepts" },
  { value: "concept", label: "Concept only" },
];

export function ScopeControl({
  active,
  hrefs,
}: {
  active: Scope;
  hrefs: Record<Scope, string>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Match scope"
      className="inline-flex items-center gap-2 text-[13px]"
    >
      <span className="mr-0.5 text-muted-foreground">Scope</span>
      {SCOPE_OPTIONS.map((opt, i) => {
        const isActive = active === opt.value;
        return (
          <span key={opt.value}>
            {i > 0 ? <span className="text-muted-foreground"> · </span> : null}
            <Link
              href={hrefs[opt.value]}
              role="radio"
              aria-checked={isActive}
              className={
                isActive
                  ? "font-semibold text-[#1a1a1a]"
                  : "text-[#5a5a5a] hover:text-[#1a1a1a]"
              }
            >
              {opt.label}
            </Link>
          </span>
        );
      })}
    </div>
  );
}

export function ScopeNote({
  scope,
  query,
  conceptLabel,
}: {
  scope: Scope;
  query: string;
  conceptLabel: string;
}) {
  const text =
    scope === "exact"
      ? `Matching the exact word “${query}”.`
      : scope === "concept"
        ? `Matching the ${conceptLabel} concept only.`
        : `Also matching the related concept ${conceptLabel}.`;
  const definition =
    `MeSH (Medical Subject Headings) is the U.S. National Library of Medicine’s ` +
    `controlled vocabulary for biomedical literature. ${conceptLabel} is its preferred ` +
    `term for “${query}”.`;
  return (
    <div className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <Sparkles aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span>{text}</span>
      {/* ⓘ — pure CSS hover + keyboard-focus (group-focus-within) tooltip; no JS. */}
      <span className="group relative inline-flex">
        <button
          type="button"
          aria-label="What is a MeSH concept?"
          className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
        >
          <Info aria-hidden className="size-3.5" strokeWidth={2} />
        </button>
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 w-[300px] -translate-x-1/2 rounded-md border border-border bg-popover p-2.5 text-left text-[12.5px] font-normal leading-[1.5] text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {definition}
        </span>
      </span>
    </div>
  );
}
