/**
 * Issue #298 §4 — broad-text fallback co-render for the publications tab.
 *
 * When a resolved-concept query is empty (zero-trigger, acceptance #1) or sparse
 * (sparse-trigger, acceptance #2), the page surfaces the broad-text alternative
 * inline instead of forcing the user through a "Search broadly" click. This
 * block is the bottom half of that co-render: a divider band that names the
 * broad-mention count, a capped top-N preview of the broad hits (§5, default
 * N=10), and a single "View all N broad results →" link that swaps the page to
 * `?mesh=off` (preserving filters, dropping the chip — §3 acceptance #6).
 *
 * The rows reuse `PublicationResultRow` — no second renderer — but they do NOT
 * participate in faceting or pagination (§7): the facet rail and Pagination are
 * computed off the PRIMARY result set, and this list is a discovery affordance,
 * not a working result set. The divider copy is identical across triggers on
 * purpose (§4.3): the user needs to know where the concept-tagged / broad-mention
 * line falls, not which arm fired.
 *
 * Server Component — purely presentational, no hooks. `total`/`hits` are passed
 * down from the SSR broad-search the page already runs for the empty-state count.
 */
import Link from "next/link";

import { PublicationResultRow } from "@/components/search/publication-result-row";
import type { PublicationHit } from "@/lib/api/search";

export function ConceptFallbackResults({
  query,
  hits,
  total,
  viewAllHref,
  cap = 10,
}: {
  /** Original query string, shown verbatim in the divider band. */
  query: string;
  /** Broad-text hits to preview. Already capped by the caller, but we slice
   *  defensively so the `cap` prop is authoritative regardless of input length. */
  hits: PublicationHit[];
  /** Total broad-text result count (un-capped) — names the divider + "View all". */
  total: number;
  /** Href for the "View all N broad results" link — the `?mesh=off` page. */
  viewAllHref: string;
  /** §5 — inline preview cap. Defaults to 10; tunable without an API change. */
  cap?: number;
}) {
  const shown = hits.slice(0, cap);
  if (shown.length === 0) return null;

  return (
    <section className="mt-8" aria-label="Broader results">
      {/* #298 §10 — concise screen-reader announcement so SR users learn the
          broad-text co-render appeared. The block streams in after the search
          page's loading status region, so a polite live region is read out on
          the result swap. Visually hidden; the divider band below carries the
          same information for sighted users. Copy is trigger-agnostic to match
          §4.3 (the user needs the broad-mention count, not which arm fired). */}
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="concept-fallback-announcement"
      >
        {`Showing ${total.toLocaleString()} broader ${
          total === 1 ? "result" : "results"
        } mentioning ${query} below.`}
      </p>
      {/* §4.3 — divider band. Identical copy across zero / sparse triggers. */}
      <div className="mb-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-[#e2e0d8]" />
        <div className="text-[13px] font-semibold text-[#4a4a4a]">
          More results mentioning &ldquo;{query}&rdquo; — {total.toLocaleString()}{" "}
          {total === 1 ? "publication" : "publications"}
        </div>
        <div className="h-px flex-1 bg-[#e2e0d8]" />
      </div>
      <ul>
        {shown.map((h) => (
          <PublicationResultRow key={h.pmid} hit={h} />
        ))}
      </ul>
      <div className="mt-2 flex justify-center">
        <Link
          href={viewAllHref}
          className="inline-flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-3 py-1.5 text-[13px] text-[#1a1a1a] hover:border-[#2c4f6e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
        >
          View all {total.toLocaleString()} broad {total === 1 ? "result" : "results"} →
        </Link>
      </div>
    </section>
  );
}
