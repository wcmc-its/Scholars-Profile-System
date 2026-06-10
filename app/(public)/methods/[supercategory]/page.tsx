import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { buildDefinedTermJsonLd } from "@/lib/seo/jsonld";
import {
  getSupercategory,
  getSupercategoryRollup,
  getTopScholarsForSupercategory,
} from "@/lib/api/methods";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { SupercategoryFamilyLayout } from "@/components/method/family-publication-layout";
import type { FamilyRailItem } from "@/components/method/family-rail";
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ supercategory: string }>;
}): Promise<Metadata> {
  if (!isMethodPagesEnabled()) return { title: "Method not found" };
  const { supercategory } = await params;
  const sc = await getSupercategory(supercategory).catch(() => null);
  if (!sc) return { title: "Method not found" };
  return {
    title: `${sc.label} — Research Methods at WCM`,
    description: sc.description,
    alternates: { canonical: `/methods/${sc.slug}` },
  };
}

export default async function SupercategoryPage({
  params,
}: {
  params: Promise<{ supercategory: string }>;
}) {
  if (!isMethodPagesEnabled()) notFound();
  const { supercategory } = await params;

  const sc = await getSupercategory(supercategory);
  if (!sc) notFound();

  const [rollup, topScholars] = await Promise.all([
    getSupercategoryRollup(sc.id).catch(() => ({ families: [], allWorkPubs: [] })),
    getTopScholarsForSupercategory(sc.id).catch(() => null),
  ]);
  const { families, allWorkPubs } = rollup;

  // getSupercategory already rejects an all-suppressed/sensitive supercategory
  // (empty post-gate roster), so `families` is non-empty here in practice; guard
  // anyway so a race can't render an empty page.
  if (families.length === 0) notFound();

  const railItems: FamilyRailItem[] = families.map((f) => ({
    familyId: f.familyId,
    familyLabel: f.familyLabel,
    scholarCount: f.scholarCount,
    pubCount: f.pubCount ?? 0,
    exemplarTools: f.exemplarTools,
  }));
  const familyMeta: Record<string, { familyLabel: string; familySegment: string }> = {};
  for (const f of families) {
    familyMeta[f.familyId] = { familyLabel: f.familyLabel, familySegment: f.familySlug };
  }

  const jsonLd = buildDefinedTermJsonLd({
    id: sc.id,
    label: sc.label,
    description: sc.description,
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
            <BreadcrumbPage>{sc.label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="mb-10">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          RESEARCH METHODS
        </div>
        <h1 className="page-title mt-2 text-3xl font-bold leading-tight tracking-tight">
          {sc.label}
        </h1>
        {sc.description && (
          <p className="mt-3 max-w-prose text-base text-muted-foreground">{sc.description}</p>
        )}

        {/* Rolled-up top scholars across the supercategory's gated families.
            No supercategory-level "/scholars" page exists (scholar browse is
            per-family), so no scholarCount / "+ N more" affordance is passed. */}
        {topScholars && (
          <div id="top-scholars" className="scroll-mt-20">
            <TopScholarsChipRow scholars={topScholars} topicLabel={sc.label} enablePopover />
          </div>
        )}

        {/* Stats — family count (additive/accurate). The distinct cross-family
            scholar count is non-additive across co-membership, so it is not
            shown as a raw sum here (§3.2 / OQ-3). */}
        <div className="mt-4 border-t border-dashed border-border pt-4 text-sm text-muted-foreground">
          {families.length.toLocaleString()} method{" "}
          {families.length === 1 ? "family" : "families"}
        </div>
      </section>

      {/* Two-level body: family rail + ?family= right panel. */}
      <section id="families" className="scroll-mt-20">
        <SupercategoryFamilyLayout
          supercategorySlug={sc.slug}
          supercategoryLabel={sc.label}
          families={railItems}
          familyMeta={familyMeta}
          allWorkPubs={allWorkPubs}
        />
      </section>
    </main>
  );
}
