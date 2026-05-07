import type { Metadata } from "next";
import { CenterPage } from "@/components/center/center-page";
import { getCenter } from "@/lib/api/centers";

export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const c = await getCenter(slug).catch(() => null);
  if (!c) return { title: "Center not found" };
  return {
    title: c.name,
    description:
      c.description ??
      `Members and research at ${c.name}, Weill Cornell Medicine.`,
    alternates: { canonical: `/centers/${slug}` },
  };
}

export default async function CenterRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const pageRaw = (Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1";
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const tabRaw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: "people" | "publications" =
    tabRaw === "publications" ? "publications" : "people";
  const sortRaw = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  return (
    <CenterPage
      centerSlug={slug}
      page={page}
      tab={tab}
      sort={sortRaw ?? null}
    />
  );
}
