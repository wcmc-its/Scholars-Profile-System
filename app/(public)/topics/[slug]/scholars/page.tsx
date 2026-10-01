import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getDistinctScholarCountForTopic,
  getSubtopicsForTopic,
  getTopicScholars,
  type TopicAllScholarRole,
} from "@/lib/api/topics";
import { isScholarListExportEnabled } from "@/lib/export/scholar-export-flags";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { ScholarListExportButton } from "@/components/scholar-export/scholar-list-export-button";
import { TopicAllScholars } from "@/components/topic/topic-all-scholars";
import { getTopicCached } from "./get-topic";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Comprehensive scholar list for a topic — spec §13 "All scholars in this
 * area · N" surface, reached from the topic page's "+ N more scholars →"
 * affordance. Browse-style enumerative list with a subarea picker, role chips,
 * name filter, A–Z letter bar, and shareable URL state. ISR with 6h fallback,
 * mirrors the parent topic page revalidation cadence.
 */
export const revalidate = 21600;
export const dynamicParams = true;

// No `doctoral_students` (sibling of #2270): the loader carves the #536 hidden
// identity classes, so `?role=doctoral_students` now falls back to "all".
const VALID_ROLES: ReadonlyArray<TopicAllScholarRole> = ["all", "faculty", "postdocs"];

const MAX_QUERY_LEN = 80;

function parseRole(raw: string | undefined): TopicAllScholarRole {
  if (raw && (VALID_ROLES as readonly string[]).includes(raw)) {
    return raw as TopicAllScholarRole;
  }
  return "all";
}

function parseQuery(raw: string | undefined): string {
  if (!raw) return "";
  return raw.slice(0, MAX_QUERY_LEN).trim();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const topic = await getTopicCached(slug).catch(() => null);
  if (!topic) return { title: "Topic not found" };
  return {
    title: `Scholars in ${topic.label} — Scholars at WCM`,
    description: `Browse all WCM scholars publishing in ${topic.label}.`,
    alternates: { canonical: `/topics/${slug}/scholars` },
  };
}

export default async function TopicScholarsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  const topic = await getTopicCached(slug);
  if (!topic) notFound();

  const role = parseRole(typeof sp.role === "string" ? sp.role : undefined);
  const q = parseQuery(typeof sp.q === "string" ? sp.q : undefined);
  const letter = typeof sp.letter === "string" ? sp.letter.slice(0, 1) : undefined;

  const [subtopics, total] = await Promise.all([
    getSubtopicsForTopic(slug).then((r) => r ?? []),
    getDistinctScholarCountForTopic(slug),
  ]);
  // An unknown ?sub= is ignored rather than filtering to nothing.
  const sub = typeof sp.sub === "string" && subtopics.some((s) => s.id === sp.sub) ? sp.sub : null;

  const result = await getTopicScholars(slug, { role, q, letter, subtopic: sub ?? undefined });
  if (!result) notFound();

  // SPEC §B.3 HARD cap: the export covers the WHOLE cohort, so offer it only
  // when that cohort is <= 50. The server refuses > 50 regardless.
  const exportEligible = isScholarListExportEnabled() && total <= SCHOLAR_EXPORT_CAP;

  return (
    <main className="mx-auto max-w-[1160px] px-6 pt-7 pb-18 sm:px-10">
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
            <BreadcrumbLink href={`/topics/${slug}`}>{topic.label}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>Scholars</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="mt-5 flex flex-col gap-2.5">
        <div className="text-xs font-medium tracking-[.1em] text-[var(--color-accent-slate)] uppercase">
          Research area
        </div>
        <h1 className="font-serif text-[32px] leading-[1.1] font-normal sm:text-[40px]">
          Scholars in {topic.label}
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <p className="text-muted-foreground text-[15px] leading-normal text-pretty">
            <span className="text-foreground font-semibold">{total.toLocaleString()}</span> scholar
            {total === 1 ? "" : "s"} with at least one publication in this area, sorted
            alphabetically.
          </p>
          {exportEligible ? (
            <ScholarListExportButton scope="topic" params={{ slug }} count={total} />
          ) : null}
        </div>
      </header>

      <TopicAllScholars
        topicSlug={slug}
        topicLabel={topic.label}
        result={result}
        subtopics={subtopics}
        selectedRole={role}
        selectedSub={sub}
        query={q}
      />
    </main>
  );
}
