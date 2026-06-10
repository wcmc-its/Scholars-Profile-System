"use client";

/**
 * Default "All work" panel for the supercategory page (UX feedback A2). When no
 * family is selected, the right panel was empty; this renders a server-computed,
 * non-paginated list of the supercategory's representative recent publications
 * (the union of every visible family's member pmids, newest-first) so something
 * loads immediately on landing. Selecting a family swaps to that family's full,
 * sortable/paginated feed.
 *
 * Server Component-friendly: the publication hits arrive as a prop (no client
 * fetch). Each row reuses the same title→modal + author-chip + meta affordances
 * the family feed uses, so the two views read consistently.
 */
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import { sanitizePubTitle } from "@/lib/utils";
import type { MethodPublicationHit } from "@/lib/api/methods";

export function SupercategoryAllWorkFeed({
  pubs,
  supercategoryLabel,
}: {
  pubs: MethodPublicationHit[];
  supercategoryLabel: string;
}) {
  if (pubs.length === 0) {
    return (
      <div className="py-8 text-sm text-muted-foreground">
        Select a method family to see its researchers and publications.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold leading-tight">
          Representative work across {supercategoryLabel}
        </h2>
        <p className="text-sm text-muted-foreground">
          A sample of recent first/senior-authored publications across every method
          family here. Select a family on the left to focus on its work.
        </p>
      </header>
      <ul className="divide-y divide-border">
        {pubs.map((h) => (
          <AllWorkRow key={h.pmid} hit={h} />
        ))}
      </ul>
    </section>
  );
}

function AllWorkRow({ hit }: { hit: MethodPublicationHit }) {
  const { open: openModal } = usePublicationModal();
  const titleHtml = sanitizePubTitle(hit.title);
  return (
    <li className="py-4">
      <div className="line-clamp-2 font-semibold leading-snug">
        <button
          type="button"
          onClick={() => openModal(hit.pmid)}
          className="text-left hover:underline"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      </div>
      {(hit.journal || hit.year) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {hit.journal && (
            <span
              className="italic"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(hit.journal) }}
            />
          )}
          {hit.journal && hit.year ? <span aria-hidden="true">·</span> : null}
          {hit.year ? <span>{hit.year}</span> : null}
        </div>
      )}
      <AuthorChipRow authors={hit.authors} pmid={hit.pmid} />
      <PublicationMeta
        citationCount={hit.citationCount}
        impactScore={hit.impactScore}
        impactJustification={null}
        pmid={hit.pmid}
        pmcid={hit.pmcid}
        doi={hit.doi}
        abstract={hit.abstract}
      />
    </li>
  );
}
