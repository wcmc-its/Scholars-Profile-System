import type { Metadata } from "next";
import { DivisionPage } from "@/components/division/division-page";
import { getDivision } from "@/lib/api/divisions";

export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; div: string }>;
}): Promise<Metadata> {
  const { slug, div } = await params;
  const detail = await getDivision(slug, div).catch(() => null);
  if (!detail) return { title: "Division not found" };
  return {
    title: `${detail.division.name} — ${detail.parentDept.name} — Scholars at WCM`,
    description: `Scholars in the ${detail.division.name} division of the ${detail.parentDept.name} at Weill Cornell Medicine.`,
    alternates: {
      canonical: `/departments/${slug}/divisions/${div}`,
    },
  };
}

export default async function DivisionRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; div: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, div } = await params;
  const sp = await searchParams;
  const pageRaw = (Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1";
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const tabRaw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab =
    tabRaw === "publications" || tabRaw === "grants" ? tabRaw : "scholars";
  const sortRaw = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  return (
    <DivisionPage
      deptSlug={slug}
      divSlug={div}
      page={page}
      tab={tab}
      sort={sortRaw ?? null}
    />
  );
}
