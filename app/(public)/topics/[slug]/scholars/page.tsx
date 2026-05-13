import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getTopic,
  getTopicScholars,
  type TopicAllScholarRole,
} from "@/lib/api/topics";
import { TopicAllScholars } from "@/components/topic/topic-all-scholars";
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
 * affordance. Browse-style enumerative list with role chips, name search,
 * alpha-letter dividers, and shareable URL state. ISR with 6h fallback,
 * mirrors the parent topic page revalidation cadence.
 */
export const revalidate = 21600;
export const dynamicParams = true;

const VALID_ROLES: ReadonlyArray<TopicAllScholarRole> = [
  "all",
  "faculty",
  "postdocs",
  "doctoral_students",
];

const MAX_PAGE = 500;
const MAX_QUERY_LEN = 80;

function parseRole(raw: string | undefined): TopicAllScholarRole {
  if (raw && (VALID_ROLES as readonly string[]).includes(raw)) {
    return raw as TopicAllScholarRole;
  }
  return "all";
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_PAGE);
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
  const topic = await getTopic(slug).catch(() => null);
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

  const topic = await getTopic(slug);
  if (!topic) notFound();

  const role = parseRole(typeof sp.role === "string" ? sp.role : undefined);
  const page = parsePage(typeof sp.page === "string" ? sp.page : undefined);
  const q = parseQuery(typeof sp.q === "string" ? sp.q : undefined);

  const result = await getTopicScholars(slug, { page, role, q });
  if (!result) notFound();

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
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
            <BreadcrumbLink href={`/topics/${slug}`}>{topic.label}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>Scholars</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          RESEARCH AREA
        </div>
        <h1 className="page-title mt-2 text-3xl font-bold leading-tight tracking-tight">
          Scholars in {topic.label}
        </h1>
      </header>

      <TopicAllScholars
        topicSlug={slug}
        result={result}
        selectedRole={role}
        query={q}
        page={page}
      />
    </main>
  );
}
