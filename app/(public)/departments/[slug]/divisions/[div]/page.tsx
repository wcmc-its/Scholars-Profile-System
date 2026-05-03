import type { Metadata } from "next";
import { DepartmentPage } from "@/components/department/department-page";
import { getDepartment } from "@/lib/api/departments";

export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; div: string }>;
}): Promise<Metadata> {
  const { slug, div } = await params;
  const dept = await getDepartment(slug).catch(() => null);
  if (!dept) return { title: "Department not found" };
  const division = dept.divisions.find((d) => d.slug === div);
  if (!division) return { title: "Division not found" };
  return {
    title: `${division.name} — ${dept.dept.name} — Scholars at WCM`,
    description: `Scholars in the ${division.name} division of the ${dept.dept.name} at Weill Cornell Medicine.`,
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
  const pageRaw =
    (Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1";
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  // Critical per D-11: do NOT call redirect() here. Render same DepartmentPage with initialDivision set.
  // notFound() for unknown div slug is handled inside DepartmentPage.
  return <DepartmentPage deptSlug={slug} initialDivision={div} page={page} />;
}
