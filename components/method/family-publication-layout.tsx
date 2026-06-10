"use client";

/**
 * Method-page publication layouts (the `subtopic-publication-layout` analog),
 * exporting BOTH page bodies:
 *
 *   - `FamilyPublicationLayout` — the FAMILY page (type A). A family is a single
 *     leaf, so there is NO rail: the publication feed renders full-width (the
 *     topic layout's `hasSubtopics === false` path).
 *
 *   - `SupercategoryFamilyLayout` — the SUPERCATEGORY page (type B), the direct
 *     Topic-page analog: a sticky family RAIL on the left + a right content panel
 *     (family researcher row → publication feed) selected via `?family=fam_NNNN`.
 *     This `?family=` is a within-supercategory-page deep-link param, DISTINCT
 *     from the #819 per-scholar profile filter (different route, different flag).
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FamilyRail, type FamilyRailItem } from "@/components/method/family-rail";
import { FamilyPublicationFeed } from "@/components/method/publication-feed";
import { FamilyScholarsRow } from "@/components/method/family-scholars-row";
import { SupercategoryAllWorkFeed } from "@/components/method/supercategory-all-work-feed";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { familySegmentFor } from "@/lib/method-url";
import type { MethodPublicationHit } from "@/lib/api/methods";

// ---------------------------------------------------------------------------
// Family page (type A) — full-width feed, no rail.
// ---------------------------------------------------------------------------

export function FamilyPublicationLayout({
  supercategorySlug,
  familySegment,
  familyLabel,
}: {
  supercategorySlug: string;
  familySegment: string;
  familyLabel: string;
}) {
  return (
    <div className="mt-16">
      <hr className="mb-10 border-border" />
      <FamilyPublicationFeed
        supercategorySlug={supercategorySlug}
        familySegment={familySegment}
        familyLabel={familyLabel}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supercategory page (type B) — family rail + ?family= right panel.
// ---------------------------------------------------------------------------

export function SupercategoryFamilyLayout(props: {
  supercategorySlug: string;
  supercategoryLabel: string;
  families: FamilyRailItem[];
  /** familyId → { label, familySegment } for building the feed/scholars hrefs. */
  familyMeta: Record<string, { familyLabel: string; familySegment: string }>;
  /** Representative recent publications across all families — the default
   *  "All work" panel shown until a family is selected (§A2). */
  allWorkPubs: MethodPublicationHit[];
}) {
  // useSearchParams() forces a CSR bailout during prerender — Suspense lets the
  // static build emit the fallback and hydrate the full UI at request time.
  return (
    <Suspense fallback={null}>
      <SupercategoryFamilyLayoutInner {...props} />
    </Suspense>
  );
}

function SupercategoryFamilyLayoutInner({
  supercategorySlug,
  supercategoryLabel,
  families,
  familyMeta,
  allWorkPubs,
}: {
  supercategorySlug: string;
  supercategoryLabel: string;
  families: FamilyRailItem[];
  familyMeta: Record<string, { familyLabel: string; familySegment: string }>;
  allWorkPubs: MethodPublicationHit[];
}) {
  const searchParams = useSearchParams();
  const requestedFamily = searchParams.get("family");
  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(
    requestedFamily && families.some((f) => f.familyId === requestedFamily)
      ? requestedFamily
      : null,
  );

  // Scroll the panel into view when a `?family=` deep-link resolves, once per
  // distinct requested family (mirrors the subtopic layout's scroll behavior).
  const lastScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (requestedFamily && families.some((f) => f.familyId === requestedFamily)) {
      setActiveFamilyId(requestedFamily);
      if (lastScrolledRef.current !== requestedFamily) {
        lastScrolledRef.current = requestedFamily;
        requestAnimationFrame(() => {
          document.getElementById("families")?.scrollIntoView();
        });
      }
    }
  }, [requestedFamily, families]);

  const hasFamilies = families.length > 0;
  const activeMeta = activeFamilyId ? familyMeta[activeFamilyId] ?? null : null;
  const activeLabel = activeMeta?.familyLabel ?? null;
  // Prefer the precomputed segment; fall back to deriving it from the rail item.
  const activeSegment =
    activeMeta?.familySegment ??
    (activeLabel && activeFamilyId ? familySegmentFor(activeLabel, activeFamilyId) : null);

  return (
    <div className="mt-16">
      <hr className="mb-10 border-border" />
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        {hasFamilies && (
          <div className="lg:w-[280px] lg:shrink-0 lg:self-start lg:sticky lg:top-[84px]">
            <ScrollFade viewportClassName="lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
              <FamilyRail
                families={families}
                activeFamilyId={activeFamilyId}
                onSelect={setActiveFamilyId}
              />
            </ScrollFade>
          </div>
        )}
        <div
          className={`min-w-0 flex-1 ${
            hasFamilies
              ? "lg:border-l-[3px] lg:border-[var(--color-primary-cornell-red)] lg:pl-6"
              : ""
          }`}
        >
          {activeFamilyId && activeLabel ? (
            <>
              <header className="mb-4">
                <h2 className="text-xl font-semibold leading-tight">{activeLabel}</h2>
              </header>
              <FamilyScholarsRow
                supercategorySlug={supercategorySlug}
                familyId={activeFamilyId}
                familyLabel={activeLabel}
              />
              {activeSegment && (
                <FamilyPublicationFeed
                  supercategorySlug={supercategorySlug}
                  familySegment={activeSegment}
                  familyLabel={activeLabel}
                />
              )}
            </>
          ) : (
            <SupercategoryAllWorkFeed
              pubs={allWorkPubs}
              supercategoryLabel={supercategoryLabel}
            />
          )}
        </div>
      </div>
    </div>
  );
}
