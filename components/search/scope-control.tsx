import Link from "next/link";
import { ExternalLink, Search, Waypoints } from "lucide-react";
import type { Scope } from "@/lib/api/search-flags";

/**
 * The resolved MeSH concept behind the R3 explanation line, surfaced in the
 * enriched hover/focus card on the concept term. Derived once per request from
 * `MeshResolution` in the search page and threaded to all three tabs.
 */
export type ConceptInfo = {
  /** The descriptor's preferred term (e.g. "Clustered Regularly Interspaced
   *  Short Palindromic Repeats"). */
  label: string;
  /** The NLM descriptor UI (e.g. "D064112") — shown in the footer and used to
   *  deep-link the MeSH browser record. */
  descriptorUi: string;
  /** The MeSH scope note (the descriptor's definition). Null for the ~0.5% of
   *  descriptors with no scope note; the card then omits the definition line. */
  definition: string | null;
};

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
  concept,
}: {
  scope: Scope;
  query: string;
  concept: ConceptInfo;
}) {
  const cardId = `mesh-card-${concept.descriptorUi}`;
  const recordUrl = `https://meshb.nlm.nih.gov/record/ui?ui=${encodeURIComponent(
    concept.descriptorUi,
  )}`;

  // The concept term reveals an enriched MeSH card on hover AND keyboard focus
  // (pure CSS group-hover / group-focus-within — no JS, so this stays a server
  // component). Unlike the old definition-only tooltip the card is interactive
  // (a "View record" link), so it is NOT pointer-events-none; a transparent
  // `before:` strip bridges the 10px gap to the anchor row so the pointer can
  // travel from the term into the card without the hover dropping. The card is
  // anchored to the note row (which holds `relative`), not the term, so a long
  // label is free to wrap. Exact-word scope names the typed query, not a MeSH
  // concept, so it renders plain with no card.
  const term = (
    <span className="group inline">
      <button
        type="button"
        aria-describedby={cardId}
        className="inline whitespace-normal rounded-sm text-left font-semibold text-foreground underline decoration-muted-foreground decoration-dotted decoration-1 underline-offset-2 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
      >
        {concept.label}
      </button>
      <span
        id={cardId}
        role="tooltip"
        className="invisible absolute left-0 top-full z-[60] mt-2.5 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover text-left opacity-0 shadow-lg transition-opacity before:absolute before:-top-2.5 before:left-0 before:h-2.5 before:w-full before:content-[''] group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {/* Header — the MeSH concept identity */}
        <span className="block rounded-t-xl bg-[#eeedfe] px-[15px] pb-[13px] pt-[11px]">
          <span className="flex items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-[#4a40a8]">
            <Waypoints aria-hidden className="size-[13px]" strokeWidth={2} />
            MeSH concept
          </span>
          <span className="mt-[5px] block text-[15px] font-semibold leading-[1.35] text-[#26215c]">
            {concept.label}
          </span>
        </span>
        {/* Body — the matched query + the descriptor's definition */}
        <span className="block px-[15px] py-[13px]">
          <span className="flex items-center gap-[7px] text-[12.5px] text-muted-foreground">
            <Search
              aria-hidden
              className="size-3.5 shrink-0 opacity-70"
              strokeWidth={2}
            />
            <span>
              Matches your search{" "}
              <span className="rounded-[5px] bg-secondary px-1.5 py-px font-mono text-[12px] text-foreground">
                {query}
              </span>
            </span>
          </span>
          {concept.definition ? (
            <span className="mt-2.5 block text-[13px] leading-[1.5] text-muted-foreground">
              {concept.definition}
            </span>
          ) : null}
        </span>
        {/* Footer — provenance badge + outbound record link */}
        <span className="flex items-center justify-between border-t border-border px-[15px] py-[9px]">
          <span className="inline-flex items-center">
            <span className="rounded-[5px] bg-[#eeedfe] px-[7px] py-0.5 text-[11px] font-medium tracking-wide text-[#4a40a8]">
              MeSH
            </span>
            <span className="ml-2 font-mono text-[12px] text-muted-foreground">
              {concept.descriptorUi}
            </span>
          </span>
          <a
            href={recordUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12.5px] text-[#2c4f6e] hover:underline"
          >
            View record
            <ExternalLink aria-hidden className="size-[13px]" strokeWidth={2} />
          </a>
        </span>
      </span>
    </span>
  );

  return (
    <div className="relative inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <Waypoints aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span>
        {scope === "exact" ? (
          <>Matching the exact word “{query}”.</>
        ) : scope === "concept" ? (
          <>Matching the {term} concept only.</>
        ) : (
          <>Also matching the related concept {term}.</>
        )}
      </span>
    </div>
  );
}
