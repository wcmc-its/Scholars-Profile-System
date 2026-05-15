"use client";

import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import type { PublicationHit } from "@/lib/api/search";
import { sanitizePubTitle } from "@/lib/utils";

/**
 * Single row on the /search?type=publications result list.
 *
 * Extracted from `app/(public)/search/page.tsx` as part of #288 PR-B so the
 * title can wire to the publication detail modal trigger without making the
 * surrounding server component a client component. The visual + layout
 * shape is unchanged from the inline `<li>` it replaces.
 */
export function PublicationResultRow({ hit }: { hit: PublicationHit }) {
  const titleHtml = sanitizePubTitle(hit.title);
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
        className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#757575]"
      />
    </li>
  );
}
