/**
 * /topics/[slug] — placeholder route per CONTEXT.md D-10.
 *
 * Phase 2 ships ONLY the hero (topic name as H1) + Top scholars chip row
 * (RANKING-03) + Recent highlights (RANKING-02). Phase 3 will expand the
 * route to the full Topic detail Layout B with subtopic rail, publication
 * feed, and sort dropdown.
 *
 * Rendering strategy: ISR with 6h fallback TTL. On-demand revalidation fires
 * after each ETL completion via /api/revalidate?path=/topics/{slug} (Plan 09).
 *
 * Schema shape (D-02 candidate (e)): topic.id IS the slug. Lookup uses
 * findUnique on the primary key, not findFirst on a non-existent slug column.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import {
  getTopScholarsForTopic,
  getRecentHighlightsForTopic,
} from "@/lib/api/topics";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { RecentHighlights } from "@/components/topic/recent-highlights";

// 6h fallback TTL; on-demand revalidation triggered by ETL writes (Plan 09).
export const revalidate = 21600;
export const dynamicParams = true;

async function getTopic(slug: string) {
  return prisma.topic.findUnique({ where: { id: slug } });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const topic = await getTopic(slug).catch(() => null);
  if (!topic) return { title: "Topic not found" };
  return {
    title: `${topic.label} — Scholars at WCM`,
    description: `Top scholars and recent publications in ${topic.label} at Weill Cornell Medicine.`,
  };
}

export default async function TopicPlaceholderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // 1. Resolve topic (404 on unknown slug). Sparse data on a real topic
  //    still renders the page (just the hero).
  const topic = await getTopic(slug);
  if (!topic) notFound();

  // 2. Fetch the two algorithmic surfaces in parallel. Both can null-out
  //    independently; one returning null does NOT trigger 404.
  const [topScholars, recentHighlights] = await Promise.all([
    getTopScholarsForTopic(slug).catch(() => null),
    getRecentHighlightsForTopic(slug).catch(() => null),
  ]);

  // TODO(Phase 3): expand to full Topic detail Layout B per design spec
  // v1.7.1 — subtopic rail, publication feed, sort dropdown. See
  // CONTEXT.md D-10 for the Phase 2 / Phase 3 boundary.
  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <header>
        <h1 className="font-serif text-4xl font-semibold leading-tight">
          {topic.label}
        </h1>
        {topic.description ? (
          <p className="mt-3 max-w-prose text-base text-muted-foreground">
            {topic.description}
          </p>
        ) : null}
      </header>
      {topScholars ? <TopScholarsChipRow scholars={topScholars} /> : null}
      {recentHighlights ? (
        <RecentHighlights papers={recentHighlights} />
      ) : null}
    </main>
  );
}
