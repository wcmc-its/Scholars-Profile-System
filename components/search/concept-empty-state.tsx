/**
 * Issue #274 — empty state for the publications tab when a MeSH-resolved
 * query (§1.6 concept_filtered / concept_fallback) returns zero hits.
 *
 * The generic `EmptyState` reads as "no results" with no signal that the
 * narrow concept-search is the reason. This component names the resolved
 * descriptor explicitly and offers the existing `mesh=off` escape as a
 * primary CTA, optionally promising a concrete count when the broad-search
 * fallback is non-zero. With a real count attached the broaden affordance
 * stops being speculative and becomes useful.
 *
 * Server Component — purely presentational, no hooks.
 */
import Link from "next/link";

export function ConceptEmptyState({
  query,
  descriptorName,
  broadCount,
  broadenHref,
}: {
  /** Original query string, shown in the heading verbatim. */
  query: string;
  /** Resolved MeSH descriptor's canonical name (`MeshResolution.name`). */
  descriptorName: string;
  /**
   * Result count for the same query with `mesh=off`. When > 0, the CTA
   * promises the exact number; when 0, the CTA is hidden and the message
   * falls back to "no publications in this corpus mention the phrase
   * either." When null, the broad count wasn't computed — the CTA still
   * renders but without a number.
   */
  broadCount: number | null;
  /** Href for the "Search broadly instead" link — same target as the chip. */
  broadenHref: string;
}) {
  const headingTail = query ? ` for "${query}"` : "";

  return (
    <div className="mt-12 flex flex-col items-center text-center">
      <div className="text-lg font-medium">
        No publications tagged with this concept{headingTail}
      </div>
      <div className="mt-1 max-w-[520px] text-sm text-[#757575]">
        No publication in this corpus is MeSH-tagged with{" "}
        <span className="font-medium text-[#4a4a4a]">{descriptorName}</span>.
        {broadCount !== null && broadCount === 0 ? (
          <> A broad-text search for the phrase also returns nothing — try a different term.</>
        ) : null}
      </div>
      {broadCount !== 0 ? (
        <Link
          href={broadenHref}
          className="mt-4 inline-flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-3 py-1.5 text-[13px] text-[#1a1a1a] hover:border-[#2c4f6e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1"
        >
          {broadCount !== null
            ? `Search broadly for "${query}" — ${broadCount.toLocaleString()} ${
                broadCount === 1 ? "result" : "results"
              }`
            : `Search broadly for "${query}"`}
        </Link>
      ) : null}
    </div>
  );
}
