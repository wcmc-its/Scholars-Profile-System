import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getTopic,
  getTopScholarsForTopic,
  getRecentHighlightsForTopic,
  getSubtopicsForTopic,
  getDistinctScholarCountForTopic,
} from "@/lib/api/topics";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { RecentHighlights } from "@/components/topic/recent-highlights";
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

  const [topScholars, recentHighlights, subtopics, scholarCount] = await Promise.all([
    getTopScholarsForTopic(slug).catch(() => null),
    getRecentHighlightsForTopic(slug).catch(() => null),
    getSubtopicsForTopic(slug).catch(() => null),
    getDistinctScholarCountForTopic(slug).catch(() => 0),
  ]);

  const subtopicList = subtopics ?? [];
  const subtopicCount = subtopicList.length;
  const totalPubsForStats = subtopicList.reduce((sum, s) => sum + s.pubCount, 0);

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
            <BreadcrumbLink href="/browse">Research areas</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>{topic.label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Hero */}
      <section className="mb-8">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          RESEARCH AREA
        </div>
        <h1 className="mt-2 font-serif text-4xl font-semibold leading-tight">
          {topic.label}
        </h1>
        {topic.description && (
          <p className="mt-4 max-w-prose text-base text-muted-foreground">
            {topic.description}
          </p>
        )}
      </section>

      {/* Top scholars chip row (Phase 2 reuse) */}
      {topScholars && <TopScholarsChipRow scholars={topScholars} />}

      {/* View all N scholars affordance — UI-SPEC §7, D-10 */}
      {scholarCount > 0 && (
        <div className="mt-4">
          <a
            href={`/search?topic=${encodeURIComponent(slug)}&tab=people`}
            className="text-base text-[var(--color-accent-slate)] hover:underline"
          >
            View all {scholarCount.toLocaleString()} scholars in this area →
          </a>
        </div>
      )}

      {/* Recent highlights (Phase 2 reuse) */}
      {recentHighlights && <RecentHighlights papers={recentHighlights} />}

      {/* Stats line — UI-SPEC §6.7 */}
      {(totalPubsForStats > 0 || subtopicCount > 0) && (
        <div className="mt-6 border-t border-dashed border-border pt-4 text-sm text-muted-foreground">
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

      {/* Layout B: sticky subtopic rail + CSR publication feed */}
      <SubtopicPublicationLayout topicSlug={slug} subtopics={subtopicList} />
    </main>
  );
}
