import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { buildDefinedTermJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import {
  getFamily,
  getFamilyScholars,
  getDistinctScholarCountForFamily,
  getRepresentativePubsForFamily,
  getFamilyCellLineEntities,
  getDistinctPmidCountForFamily,
} from "@/lib/api/methods";
import { supercategoryLabel } from "@/lib/methods/supercategory-labels";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { Spotlight } from "@/components/shared/spotlight";
import { FamilyPublicationLayout } from "@/components/method/family-publication-layout";
import { CellLineRail } from "@/components/method/cell-line-rail";
import { ScrollFade } from "@/components/ui/scroll-fade";
import type { SpotlightData } from "@/lib/api/spotlight";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// #985 — force-dynamic: the #800/#801 family-visibility overlay gate is
// per-request, but ISR (revalidate=21600) cached the rendered shell for up to
// 6h, leaving a steward-suppressed/sensitive family publicly reachable until the
// next revalidate. The data layer is already overlay-gated; force-dynamic makes
// the page honor it. (Restoring ISR + purge-on-edit for perf is the #985 follow-up.)
export const dynamic = "force-dynamic";

const SPOTLIGHT_CARDS = 3;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ supercategory: string; family: string }>;
}): Promise<Metadata> {
  if (!isMethodPagesEnabled()) return { title: "Method not found" };
  const { supercategory, family } = await params;
  const resolved = await getFamily(supercategory, family).catch(() => null);
  if (!resolved) return { title: "Method not found" };
  const scholarCount = await getDistinctScholarCountForFamily(
    resolved.supercategory,
    resolved.familyLabel,
  ).catch(() => 0);
  return {
    title: `${resolved.familyLabel} — Research Methods at WCM`,
    description: `Explore WCM researchers and publications using ${resolved.familyLabel} — ${scholarCount} scholars.`,
    alternates: {
      canonical: `/methods/${resolved.supercategorySlug}/${resolved.familySlug}`,
    },
  };
}

export default async function FamilyPage({
  params,
}: {
  params: Promise<{ supercategory: string; family: string }>;
}) {
  if (!isMethodPagesEnabled()) notFound();
  const { supercategory, family } = await params;

  const resolved = await getFamily(supercategory, family);
  if (!resolved) notFound();

  const [
    topScholars,
    scholarCount,
    representativePubs,
    cellLineEntities,
    distinctPmidTotal,
  ] = await Promise.all([
    getFamilyScholars(resolved.supercategory, resolved.familyLabel).catch(() => null),
    getDistinctScholarCountForFamily(resolved.supercategory, resolved.familyLabel).catch(() => 0),
    getRepresentativePubsForFamily(
      resolved.supercategory,
      resolved.familyLabel,
      SPOTLIGHT_CARDS,
    ).catch(() => []),
    // #1166 — the family's specific cell lines ([] when the flag is off).
    getFamilyCellLineEntities(resolved.supercategory, resolved.familyLabel).catch(() => []),
    // #1166 punch #3 — the real distinct research-article total for the family
    // (the feed's `totalResearchOnly` denominator), used for the rail copy + the
    // Spotlight volume gate. 0 when the lens is off / family gated / no pmids.
    getDistinctPmidCountForFamily(resolved.supercategory, resolved.familyLabel).catch(() => 0),
  ]);

  // #1166 — when the family resolves to specific cell lines, the master-detail
  // cell-line rail (Surface B §5.1) sits in the left column of the publications
  // section, driving the `?entity=` feed filter. When there are no cell lines,
  // the publications feed renders without the rail.
  const hasCellLines = cellLineEntities.length > 0;
  const cellLineLabels = Object.fromEntries(cellLineEntities.map((e) => [e.entityId, e.label]));

  const scLabel = supercategoryLabel(resolved.supercategory);

  // Spotlight (§5.A, optional) — map the representative pubs onto SpotlightCard.
  // Omitted entirely when the family has no representative publications (e.g.
  // pre-#175 rollup where `ScholarFamily.pmids` is unpopulated — §E9).
  const spotlightData: SpotlightData | null =
    representativePubs.length > 0
      ? {
          cards: representativePubs.map((p) => ({
            pmid: p.pmid,
            kicker: resolved.familyLabel,
            kickerHref: null,
            title: p.title,
            journal: p.journal,
            year: p.year || null,
            pubmedUrl: p.pubmedUrl,
            doi: p.doi,
            authors: p.authors,
          })),
          totalCount: representativePubs.length,
          viewAllHref: "#publications",
        }
      : null;

  const jsonLd = buildDefinedTermJsonLd({
    id: resolved.familyId,
    label: resolved.familyLabel,
    // #879 — the generated gloss enriches the DefinedTerm description. `null` until
    // the rollup populates it / the METHODS_LENS_FAMILY_DEFINITIONS flag is on
    // (getFamily only reads it when gated), so no SEO side channel leaks pre-flip.
    // NOTE: buildDefinedTermJsonLd runs this through overviewToDescription() — HTML
    // strip + whitespace collapse + a 300-char cap — so the STRUCTURED-DATA copy is
    // SEO-normalized, not byte-verbatim like the on-page <p>. Intended: glosses are
    // 1–2 sentence (~≤40 word) capability blurbs, comfortably under the cap; the
    // visible paragraph below renders the definition verbatim (em-dashes included).
    description: resolved.definition,
  });

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/methods">Methods</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href={`/methods/${resolved.supercategorySlug}`}>
              {scLabel}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{resolved.familyLabel}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="mb-10">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          METHOD
        </div>
        <h1 className="page-title mt-2 text-3xl font-bold leading-tight tracking-tight">
          {resolved.familyLabel}
        </h1>

        {/* #879 — generated capability gloss (render-only passthrough from the A2
            tools-a2-v3 taxonomy). Present only when METHODS_LENS_FAMILY_DEFINITIONS
            is on AND the rollup populated it (getFamily reads it under the same
            gate). Em-dashes render verbatim (house style, no transform). */}
        {resolved.definition && (
          <div className="mt-3 max-w-prose">
            <p className="text-base leading-relaxed text-muted-foreground">
              {resolved.definition}
            </p>
            {resolved.definitionSource === "generated" && (
              <p className="mt-1 text-xs italic text-muted-foreground/80">
                AI-generated definition
              </p>
            )}
          </div>
        )}

        {/* TopScholarsChipRow's built-in "+ N more" link is hardcoded to
            `/topics/{slug}/scholars`; on a method page the enumerative list
            lives at `/methods/[sc]/[fam]/scholars`, so we render the chips
            WITHOUT the topic link (omit topicSlug) and provide a separate
            method-scoped "+ N more scholars →" affordance below. */}
        {topScholars && (
          <div id="top-scholars" className="scroll-mt-20">
            <TopScholarsChipRow
              scholars={topScholars}
              topicLabel={resolved.familyLabel}
              enablePopover
              contextMethods
            />
          </div>
        )}

        {scholarCount > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-border pt-4 text-sm text-muted-foreground">
            <span>
              {scholarCount.toLocaleString()} {scholarCount === 1 ? "scholar" : "scholars"}
            </span>
            {topScholars && scholarCount > topScholars.length && (
              <a
                href={`/methods/${resolved.supercategorySlug}/${resolved.familySlug}/scholars`}
                className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
              >
                + {(scholarCount - topScholars.length).toLocaleString()} more scholars →
              </a>
            )}
          </div>
        )}
      </section>

      {/* Spotlight (§5.A) — render only when the family is substantial enough: a real
          distinct-pmid total ≥ 12 AND at least 3 representative cards to fill the
          grid. Below that threshold the surface reads as sparse, so it's suppressed. */}
      {spotlightData && spotlightData.cards.length >= 3 && distinctPmidTotal >= 12 && (
        <Spotlight data={spotlightData} />
      )}

      <section id="publications" className="scroll-mt-20">
        {hasCellLines ? (
          // #1166 Surface B — master-detail: the cell-line rail (left) drives the
          // shared `?entity=` filter the feed (right) reads. Mirrors the
          // supercategory layout's sticky-rail + cornell-red divider for parity.
          <div className="mt-16">
            <hr className="mb-10 border-border" />
            <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
              <div className="lg:w-[280px] lg:shrink-0 lg:self-start lg:sticky lg:top-[84px]">
                <Suspense fallback={null}>
                  <ScrollFade viewportClassName="lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
                    <CellLineRail entities={cellLineEntities} />
                  </ScrollFade>
                </Suspense>
              </div>
              <div className="min-w-0 flex-1 lg:border-l-[3px] lg:border-[var(--color-primary-cornell-red)] lg:pl-6">
                <FamilyPublicationLayout
                  supercategorySlug={resolved.supercategorySlug}
                  familySegment={resolved.familySlug}
                  familyLabel={resolved.familyLabel}
                  cellLineLabels={cellLineLabels}
                  embedded
                />
              </div>
            </div>
          </div>
        ) : (
          <FamilyPublicationLayout
            supercategorySlug={resolved.supercategorySlug}
            familySegment={resolved.familySlug}
            familyLabel={resolved.familyLabel}
            cellLineLabels={cellLineLabels}
          />
        )}
      </section>
    </main>
  );
}
