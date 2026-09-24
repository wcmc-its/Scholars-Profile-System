/**
 * /departments/[slug]/divisions/[div]/areas/[area] — the division page with its
 * Publications tab filtered to one research area (the hero preview's "See
 * all"). Path segment, not `?area=` — see the department twin
 * (app/(public)/departments/[slug]/areas/[area]/page.tsx).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DivisionPage } from "@/components/division/division-page";
import { getDivision } from "@/lib/api/divisions";
import { getTopic } from "@/lib/api/topics";

export const revalidate = 21600;
export const dynamicParams = true;

type Params = Promise<{ slug: string; div: string; area: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, div, area } = await params;
  const [detail, topic] = await Promise.all([
    getDivision(slug, div).catch(() => null),
    getTopic(area).catch(() => null),
  ]);
  if (!detail || !topic) return { title: "Not found" };
  return {
    title: `${topic.label} — ${detail.division.name} publications`,
    robots: { index: false, follow: true },
  };
}

export default async function DivisionAreaRoute({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, div, area } = await params;
  const topic = await getTopic(area);
  if (!topic) notFound();
  const sp = await searchParams;
  const pageRaw = (Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1";
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const sortRaw = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  return (
    <DivisionPage
      deptSlug={slug}
      divSlug={div}
      page={page}
      tab="publications"
      sort={sortRaw ?? null}
      area={{ id: topic.id, label: topic.label }}
    />
  );
}
