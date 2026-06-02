"use client";

import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { MatchProvenanceNote } from "@/components/search/match-provenance-note";
import type { PublicationHit } from "@/lib/api/search";
import { sanitizePubTitle } from "@/lib/utils";

// SEARCH_PUB_HIGHLIGHT — render the matched title. The OpenSearch fragment wraps
// matches in <mark>; the indexed title may also carry scientific <sub>/<sup>/<i>
// markup. Keep that whitelist plus <mark>, drop everything else, then style the
// surviving marks as a quiet pale-brand tint behind the span — keeping the title
// glyph color (the title is already bold; a tint reads as "highlight", not the
// recolored-glyph "link/alert" the nearby blue links would clash with) and never
// the post-it-yellow <mark> default (#20). `box-decoration-clone` keeps the pill
// intact if a match wraps across lines.
const TITLE_TAG_WHITELIST = /^(?:i|em|b|strong|sup|sub|mark)$/;
const MARK_CLASS = "box-decoration-clone rounded-[3px] bg-[#b31b1b]/10 px-[3px]";

export function highlightedTitleHtml(fragment: string): string {
  // 1. Keep the scientific-notation whitelist + <mark>; drop everything else.
  //    Normalize marks to a bare tag; the pill class is applied in step 3.
  const cleaned = fragment.replace(
    /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi,
    (_, slash: string, raw: string) => {
      const name = raw.toLowerCase();
      if (!TITLE_TAG_WHITELIST.test(name)) return "";
      return slash ? `</${name}>` : `<${name}>`;
    },
  );
  // 2. Merge adjacent marks separated only by whitespace into one pill, so a
  //    contiguous phrase ("Microbiome Research") reads as a single highlight
  //    rather than two abutting tinted boxes.
  const merged = cleaned.replace(/<\/mark>(\s+)<mark>/gi, "$1");
  // 3. First-occurrence-only: a title that repeats a matched term shouldn't
  //    strobe. Keep the first <mark> per normalized term, unwrap later repeats,
  //    and apply the pale-tint pill to the survivors.
  const seen = new Set<string>();
  return merged.replace(/<mark>([\s\S]*?)<\/mark>/gi, (_, inner: string) => {
    const key = inner.replace(/<[^>]*>/g, "").toLowerCase().trim();
    if (seen.has(key)) return inner;
    seen.add(key);
    return `<mark class="${MARK_CLASS}">${inner}</mark>`;
  });
}

/**
 * Single row on the /search?type=publications result list.
 *
 * Extracted from `app/(public)/search/page.tsx` as part of #288 PR-B so the
 * title can wire to the publication detail modal trigger without making the
 * surrounding server component a client component. The visual + layout
 * shape is unchanged from the inline `<li>` it replaces.
 */
export function PublicationResultRow({ hit }: { hit: PublicationHit }) {
  const titleHtml = hit.titleHighlight
    ? highlightedTitleHtml(hit.titleHighlight)
    : sanitizePubTitle(hit.title);
  const { open } = usePublicationModal();
  return (
    <li className="border-b border-[#e3e2dd] py-5">
      <div className="mb-2 text-[16px] font-semibold leading-snug">
        <button
          type="button"
          onClick={() => open(hit.pmid)}
          className="text-left text-[#1a1a1a] hover:text-[#2c4f6e] hover:underline"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      </div>
      <div className="mb-2 text-[13px] leading-snug text-[#4a4a4a]">
        {hit.journal ? <em className="not-italic">{hit.journal}</em> : null}
        {hit.journal && hit.year ? ". " : null}
        {hit.year ?? null}.
      </div>
      <AuthorChipRow authors={hit.wcmAuthors} pmid={hit.pmid} />
      {/* Issue #707 — #688-parity "Why this match" note when this publication
          matched via the resolved MeSH concept (its meshDescriptorUi intersects
          the descriptor's descendant set), which the title highlighter can't
          explain when the typed term isn't in the title. */}
      {hit.matchProvenance ? <MatchProvenanceNote provenance={hit.matchProvenance} /> : null}
      {/* Issue #284 — impact and concept-impact land inline in the meta row
          (between citations and PMID). When both are non-null the row shows
          `Impact: 42 · Concept: 38` so the §1.8 reweighting delta is visible.
          Both null → block omitted. */}
      <PublicationMeta
        citationCount={hit.citationCount}
        impactScore={hit.impactScore}
        impactJustification={hit.impactJustification}
        conceptImpactScore={hit.conceptImpactScore}
        pmid={hit.pmid}
        pmcid={hit.pmcid}
        doi={hit.doi}
        abstract={hit.abstract}
        className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
      />
    </li>
  );
}
