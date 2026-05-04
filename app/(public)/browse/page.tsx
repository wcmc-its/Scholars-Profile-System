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
import { AZDirectory } from "@/components/browse/az-directory";

/**
 * Browse hub — BROWSE-01.
 *
 * ISR with on-demand revalidation. The /api/revalidate webhook (Plan 02
 * extension) fires `revalidatePath("/browse")` after each daily ETL
 * completes; in addition, the time-based revalidate of 3600s caps drift
 * for any path not covered by the webhook.
 *
 * Page composes five Server / Client Components consuming a single
 * getBrowseData() call. Centers section is always an empty-state placeholder
 * because no Center model exists in the schema (RESEARCH.md Pitfall 4).
 */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Browse Scholars — Scholars at WCM",
  description:
    "Explore WCM faculty by department, research area, or alphabetically.",
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
            <BreadcrumbPage>Browse</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <BrowseHero />
      <BrowseAnchorStrip />
      <DepartmentsGrid departments={data.departments} />
      <CentersGrid />
      <AZDirectory buckets={data.azBuckets} />
    </main>
  );
}
