import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { buildDefinedTermJsonLd } from "@/lib/seo/jsonld";
import {
  getFamily,
  getFamilyScholars,
  getDistinctScholarCountForFamily,
  getRepresentativePubsForFamily,
} from "@/lib/api/methods";
import { supercategoryLabel } from "@/lib/methods/supercategory-labels";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { Spotlight } from "@/components/shared/spotlight";
import { FamilyPublicationLayout } from "@/components/method/family-publication-layout";
import type { SpotlightData } from "@/lib/api/spotlight";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export const revalidate = 21600;
export const dynamicParams = true;

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

  const [topScholars, scholarCount, representativePubs] = await Promise.all([
    getFamilyScholars(resolved.supercategory, resolved.familyLabel).catch(() => null),
    getDistinctScholarCountForFamily(resolved.supercategory, resolved.familyLabel).catch(
      () => 0,
    ),
    getRepresentativePubsForFamily(
      resolved.supercategory,
      resolved.familyLabel,
      SPOTLIGHT_CARDS,
    ).catch(() => []),
  ]);

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
    description: null,
  });

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
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

        {/* TopScholarsChipRow's built-in "+ N more" link is hardcoded to
            `/topics/{slug}/scholars`; on a method page the enumerative list
            lives at `/methods/[sc]/[fam]/scholars`, so we render the chips
            WITHOUT the topic link (omit topicSlug) and provide a separate
            method-scoped "+ N more scholars →" affordance below. */}
        {topScholars && (
          <div id="top-scholars" className="scroll-mt-20">
            <TopScholarsChipRow scholars={topScholars} topicLabel={resolved.familyLabel} />
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

      <Spotlight data={spotlightData} />

      <section id="publications" className="scroll-mt-20">
        <FamilyPublicationLayout
          supercategorySlug={resolved.supercategorySlug}
          familySegment={resolved.familySlug}
          familyLabel={resolved.familyLabel}
        />
      </section>
    </main>
  );
}
