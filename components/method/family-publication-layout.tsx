"use client";

/**
 * The method FAMILY page's publication feed wrapper. With no entity rail the
 * feed renders full-width; with one, `FamilyEntityRailLayout` embeds it as the
 * right column of the shared `RailLayout` (`embedded`). The supercategory page's
 * family rail + panel lives in `supercategory-rail-layout.tsx`.
 */
import { Suspense } from "react";
import { FamilyPublicationFeed } from "@/components/method/publication-feed";

export function FamilyPublicationLayout({
  supercategorySlug,
  familySegment,
  familyLabel,
  cellLineLabels,
  embedded = false,
}: {
  supercategorySlug: string;
  familySegment: string;
  familyLabel: string;
  /** #1166 — entity id → label for the feed's `?entity=` context-bar chip. */
  cellLineLabels?: Record<string, string>;
  /** #1166 — when the layout is the RIGHT column of the family-page master-detail,
   *  the page supplies its own `mt-16`+`<hr>` wrapper, so suppress this one's to
   *  avoid a stray rule above the feed inside the grid. */
  embedded?: boolean;
}) {
  const feed = (
    // The feed reads `?entity=` via useSearchParams (#1166) — Suspense lets the
    // static shell emit and hydrate at request time (parity with the type-B layout).
    <Suspense fallback={null}>
      <FamilyPublicationFeed
        supercategorySlug={supercategorySlug}
        familySegment={familySegment}
        familyLabel={familyLabel}
        cellLineLabels={cellLineLabels}
      />
    </Suspense>
  );

  if (embedded) return feed;

  return (
    <div className="mt-16">
      <hr className="mb-10 border-border" />
      {feed}
    </div>
  );
}
