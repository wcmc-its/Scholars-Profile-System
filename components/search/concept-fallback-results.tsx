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

/**
 * Issue #298 §10 / #991 #11 — persistent screen-reader announcement for the
 * broad-text co-render.
 *
 * A polite `aria-live` region only reliably announces content that mutates
 * *after* the region already exists in the DOM. The previous version mounted the
 * region together with its text inside `ConceptFallbackResults`, so on the
 * result swap the region and its text appeared simultaneously and many
 * SR/browser pairs stayed silent. The fix is to render this region
 * **unconditionally** (the page always mounts it, even with no fallback), so when
 * a query produces a broad-text co-render the count is *written into* an existing
 * live region and is announced.
 *
 * `total === null` ⇒ no co-render is shown; the region stays present but empty.
 *
 * NOTE: a true verification of the announcement still requires a real screen
 * reader (VoiceOver + NVDA) on a live result swap; this is the structurally
 * correct shape, not an automated SR-verified one.
 */
export function ConceptFallbackAnnouncement({
  query,
  total,
}: {
  /** Original query string, echoed verbatim in the announcement. */
  query: string;
  /** Broad-text total when a co-render is shown; `null` when none — keeps the
   *  region mounted-but-empty so a later count write is announced. */
  total: number | null;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="sr-only"
      data-testid="concept-fallback-announcement"
    >
      {total !== null
        ? `Showing ${total.toLocaleString()} broader ${
            total === 1 ? "result" : "results"
          } mentioning ${query} below.`
        : ""}
    </p>
  );
}

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
      {/* §4.3 — divider band. Identical copy across zero / sparse triggers.
          The screen-reader announcement is NOT here — it lives in the persistent
          <ConceptFallbackAnnouncement> the page renders unconditionally, so the
          count is written into a live region that already exists in the DOM and
          is therefore reliably announced on the result swap (#991 #11). */}
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
