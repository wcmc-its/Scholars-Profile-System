/**
 * /centers/[slug]/areas/[area] — the center page with its Publications tab
 * filtered to one research area (the hero preview's "See all"). Path segment,
 * not `?area=` — see the department twin
 * (app/(public)/departments/[slug]/areas/[area]/page.tsx).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CenterPage } from "@/components/center/center-page";
import { getCenter } from "@/lib/api/centers";
import { getTopic } from "@/lib/api/topics";

export const revalidate = 21600;
export const dynamicParams = true;

type Params = Promise<{ slug: string; area: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, area } = await params;
  const [center, topic] = await Promise.all([
    getCenter(slug).catch(() => null),
    getTopic(area).catch(() => null),
  ]);
  if (!center || !topic) return { title: "Not found" };
  return {
    title: `${topic.label} — ${center.name} publications`,
    robots: { index: false, follow: true },
  };
}

export default async function CenterAreaRoute({
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
    <CenterPage
      centerSlug={slug}
      page={page}
      tab="publications"
      sort={sortRaw ?? null}
      area={{ id: topic.id, label: topic.label }}
    />
  );
}
