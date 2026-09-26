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
 * fetch). Each row is the shared feed `PubRow`, so the two views read the same.
 */
import { PubRow } from "@/components/taxonomy/publication-feed";
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
          <PubRow key={h.pmid} hit={h} />
        ))}
      </ul>
    </section>
  );
}
