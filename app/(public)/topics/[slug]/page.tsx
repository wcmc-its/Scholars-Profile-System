import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getTopic,
  getTopScholarsForTopic,
  getSubtopicsForTopic,
  getDistinctScholarCountForTopic,
} from "@/lib/api/topics";
import { getSpotlightCardsForTopic } from "@/lib/api/spotlight";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { Spotlight } from "@/components/shared/spotlight";
import { SubtopicPublicationLayout } from "@/components/topic/subtopic-publication-layout";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// 6h fallback TTL; on-demand revalidation triggered by ETL writes (Plan 09).
export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const topic = await getTopic(slug).catch(() => null);
  if (!topic) return { title: "Topic not found" };
  const scholarCount = await getDistinctScholarCountForTopic(slug).catch(() => 0);
  return {
    title: `${topic.label} Research`,
    description: `Explore WCM researchers and publications in ${topic.label} — ${scholarCount} scholars.`,
    alternates: { canonical: `/topics/${slug}` },
  };
}

export default async function TopicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const topic = await getTopic(slug);
  if (!topic) notFound();

  const [topScholars, spotlightCards, subtopics, scholarCount] = await Promise.all([
    getTopScholarsForTopic(slug).catch(() => null),
    getSpotlightCardsForTopic(slug).catch(() => null),
    getSubtopicsForTopic(slug).catch(() => null),
    getDistinctScholarCountForTopic(slug).catch(() => 0),
  ]);

  const subtopicList = subtopics ?? [];
  const subtopicCount = subtopicList.length;
  const totalPubsForStats = subtopicList.reduce((sum, s) => sum + s.pubCount, 0);
  const spotlightData = spotlightCards
    ? {
        cards: spotlightCards,
        totalCount: totalPubsForStats,
        viewAllHref: "#publications",
      }
    : null;

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      {/* Breadcrumbs — UI-SPEC §7 */}
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/#browse-all-research-areas">Research areas</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{topic.label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Hero */}
      <section className="mb-10">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          RESEARCH AREA
        </div>
        <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight">
          {topic.label}
        </h1>
        {topic.description && (
          <p className="mt-3 max-w-prose text-base text-muted-foreground">
            {topic.description}
          </p>
        )}

        {/* Top scholars chip row — inside hero, D-10. id="top-scholars"
            anchors deep-links from the home page spotlight section. */}
        {topScholars && (
          <div id="top-scholars" className="scroll-mt-20">
            <TopScholarsChipRow
              scholars={topScholars}
              scholarCount={scholarCount}
              topicSlug={slug}
            />
          </div>
        )}

        {/* Stats — dashed border under scholars row */}
        {(totalPubsForStats > 0 || subtopicCount > 0) && (
          <div className="mt-4 border-t border-dashed border-border pt-4 text-sm text-muted-foreground">
            {[
              totalPubsForStats > 0
                ? `${totalPubsForStats.toLocaleString()} publications`
                : null,
              subtopicCount > 0 ? `${subtopicCount.toLocaleString()} subtopics` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </section>

      {/* Spotlight (§16) — replaces the prior Recent Highlights surface. */}
      <Spotlight data={spotlightData} />

      {/* Layout B: sticky subtopic rail + CSR publication feed.
          id="publications" anchors deep-links from the home page spotlight
          section. */}
      <section id="publications" className="scroll-mt-20">
        <SubtopicPublicationLayout topicSlug={slug} subtopics={subtopicList} />
      </section>
    </main>
  );
}
