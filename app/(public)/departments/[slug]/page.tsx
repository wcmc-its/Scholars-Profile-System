import type { Metadata } from "next";
import { DepartmentPage } from "@/components/department/department-page";
import { getDepartment } from "@/lib/api/departments";

export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const dept = await getDepartment(slug).catch(() => null);
  if (!dept) return { title: "Department not found" };
  return {
    title: `${dept.dept.name}`,
    description: `Faculty, publications, and research from ${dept.dept.name} at Weill Cornell Medicine — ${dept.stats.scholars} scholars.`,
    alternates: { canonical: `/departments/${slug}` },
  };
}

export default async function DepartmentRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const pageRaw =
    (Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1";
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const tabRaw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab =
    tabRaw === "publications" || tabRaw === "grants" ? tabRaw : "scholars";
  const sortRaw = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  return (
    <DepartmentPage
      deptSlug={slug}
      page={page}
      tab={tab}
      sort={sortRaw ?? null}
    />
  );
}
