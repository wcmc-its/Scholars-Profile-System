import type { Metadata } from "next";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { getBrowseData } from "@/lib/api/browse";
import { BrowseHero } from "@/components/browse/browse-hero";
import { BrowseAnchorStrip } from "@/components/browse/browse-anchor-strip";
import { DepartmentsGrid } from "@/components/browse/departments-grid";
import { CentersGrid } from "@/components/browse/centers-grid";

/**
 * Departments & Centers hub.
 *
 * ISR with on-demand revalidation. The /api/revalidate webhook fires
 * `revalidatePath("/browse")` after each daily ETL completes; the time-based
 * revalidate of 3600s caps drift for any path not covered by the webhook.
 *
 * URL retained as /browse (no redirect) per docs/browse-vs-search.md. The
 * A–Z directory used to live here; it now renders on /search's empty People
 * tab. Surname-finding belongs with search, not org-structure exploration.
 */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Departments & Centers — Scholars at WCM",
  description:
    "Explore WCM departments, divisions, and centers, and the scholars who lead them.",
  alternates: { canonical: "/browse" },
};

export default async function BrowsePage() {
  const data = await getBrowseData();

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>Departments &amp; Centers</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <BrowseHero />
      <BrowseAnchorStrip />
      <DepartmentsGrid departments={data.departments} />
      <CentersGrid centers={data.centers} />
    </main>
  );
}
