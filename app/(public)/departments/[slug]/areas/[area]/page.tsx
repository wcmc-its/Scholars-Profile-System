/**
 * /departments/[slug]/areas/[area] — the department page with its Publications
 * tab filtered to one research area: the destination of the hero research-area
 * preview's "See all N →". A path segment rather than `?area=`, because the
 * CloudFront cache policy for /departments/* forwards only an allow-list of
 * query params (cdk/lib/edge-stack.ts) and would strip `area`.
 *
 * The area must be a real `Topic.id` (unknown → 404), which also bounds the
 * number of ISR pages; the view is noindex (the unfiltered tab is canonical
 * content), but its links are followed.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DepartmentPage } from "@/components/department/department-page";
import { getDepartment } from "@/lib/api/departments";
import { getTopic } from "@/lib/api/topics";

export const revalidate = 21600;
export const dynamicParams = true;

type Params = Promise<{ slug: string; area: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, area } = await params;
  const [dept, topic] = await Promise.all([
    getDepartment(slug).catch(() => null),
    getTopic(area).catch(() => null),
  ]);
  if (!dept || !topic) return { title: "Not found" };
  return {
    title: `${topic.label} — ${dept.dept.name} publications`,
    robots: { index: false, follow: true },
  };
}

export default async function DepartmentAreaRoute({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, area } = await params;
  const topic = await getTopic(area);
  if (!topic) notFound();
  const sp = await searchParams;
  const pageRaw = (Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1";
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const sortRaw = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  return (
    <DepartmentPage
      deptSlug={slug}
      page={page}
      tab="publications"
      sort={sortRaw ?? null}
      area={{ id: topic.id, label: topic.label }}
    />
  );
}
