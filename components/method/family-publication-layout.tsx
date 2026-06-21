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
import { familySegmentFor, resolveFamilyParam } from "@/lib/method-url";
import type { MethodPublicationHit } from "@/lib/api/methods";

// ---------------------------------------------------------------------------
// Family page (type A) — full-width feed, no rail.
// ---------------------------------------------------------------------------

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
  /** #1166 — entity id → label for the feed's `?cellLine=` context-bar chip. */
  cellLineLabels?: Record<string, string>;
  /** #1166 — when the layout is the RIGHT column of the family-page master-detail,
   *  the page supplies its own `mt-16`+`<hr>` wrapper, so suppress this one's to
   *  avoid a stray rule above the feed inside the grid. */
  embedded?: boolean;
}) {
  const feed = (
    // The feed reads `?cellLine=` via useSearchParams (#1166) — Suspense lets the
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

// ---------------------------------------------------------------------------
// Supercategory page (type B) — family rail + ?family= right panel.
// ---------------------------------------------------------------------------

/** familyId → right-panel metadata: the label + canonical URL segment (for the
 *  feed/scholars hrefs + the "View full method page" link), plus the #879
 *  generated definition. `definition` is null whenever the definitions flag is
 *  off — `getSupercategoryRollup` populates it under the same gate as `getFamily`. */
type FamilyPanelMeta = {
  familyLabel: string;
  familySegment: string;
  definition: string | null;
  definitionSource: string | null;
};

export function SupercategoryFamilyLayout(props: {
  supercategorySlug: string;
  supercategoryLabel: string;
  families: FamilyRailItem[];
  familyMeta: Record<string, FamilyPanelMeta>;
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
  familyMeta: Record<string, FamilyPanelMeta>;
  allWorkPubs: MethodPublicationHit[];
}) {
  const searchParams = useSearchParams();
  const requestedFamily = searchParams.get("family");
  // `familyId` re-mints on every A2 rebuild, so resolve the deep-link by the
  // STABLE label-slug (bare id accepted for back-compat) — never a raw-id match,
  // which silently drifts to a different family after a rebuild (#940).
  const resolvedFamilyId = resolveFamilyParam(requestedFamily, families);
  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(resolvedFamilyId);

  // Scroll the panel into view when a `?family=` deep-link resolves, once per
  // distinct requested family (mirrors the subtopic layout's scroll behavior).
  const lastScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (resolvedFamilyId) {
      setActiveFamilyId(resolvedFamilyId);
      if (lastScrolledRef.current !== requestedFamily) {
        lastScrolledRef.current = requestedFamily;
        requestAnimationFrame(() => {
          document.getElementById("families")?.scrollIntoView();
        });
      }
    }
  }, [resolvedFamilyId, requestedFamily]);

  const hasFamilies = families.length > 0;
  const activeMeta = activeFamilyId ? familyMeta[activeFamilyId] ?? null : null;
  const activeLabel = activeMeta?.familyLabel ?? null;
  // Prefer the precomputed segment; fall back to deriving it from the rail item.
  const activeSegment =
    activeMeta?.familySegment ??
    (activeLabel && activeFamilyId ? familySegmentFor(activeLabel, activeFamilyId) : null);
  // #879 — the generated capability gloss, mirroring the standalone family page.
  // Null (nothing rendered) when the definitions flag is off or the rollup never
  // populated it — the panel stays a clean preview rather than guessing copy.
  const activeDefinition = activeMeta?.definition ?? null;
  const activeDefinitionSource = activeMeta?.definitionSource ?? null;

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
                {/* #879 — generated capability gloss, mirroring the standalone
                    family page so the panel is self-explanatory rather than a
                    bare list of scholars + papers. Em-dashes render verbatim
                    (house style). */}
                {activeDefinition && (
                  <div className="mt-2 max-w-prose">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {activeDefinition}
                    </p>
                    {activeDefinitionSource === "generated" && (
                      <p className="mt-1 text-xs italic text-muted-foreground/80">
                        AI-generated definition
                      </p>
                    )}
                  </div>
                )}
                {activeSegment && (
                  // The supercategory panel and the standalone family page show the
                  // same family. The rail click is an in-page deep-link (`?family=`),
                  // not navigation, so signpost the canonical family page explicitly
                  // — otherwise the two surfaces read as accidental duplicates. The
                  // family label is kept in the link text so it stands alone for a11y.
                  <a
                    href={`/methods/${encodeURIComponent(supercategorySlug)}/${encodeURIComponent(
                      activeSegment,
                    )}`}
                    className="mt-1 inline-block text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
                  >
                    View full {activeLabel} method page →
                  </a>
                )}
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
