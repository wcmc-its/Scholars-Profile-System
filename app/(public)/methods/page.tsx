import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSupercategoryHubEntries } from "@/lib/api/methods";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { MethodsHubGrid } from "@/components/method/methods-hub-grid";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// 6h fallback TTL; on-demand revalidation triggered by ETL writes.
export const revalidate = 21600;
export const dynamicParams = true;

export const metadata: Metadata = {
  title: "Research Methods at WCM",
  description:
    "Browse the research methods and method families used by scholars across Weill Cornell Medicine.",
  alternates: { canonical: "/methods" },
};

export default async function MethodsHubPage() {
  // METHODS_LENS_PAGES gates the whole `/methods/**` surface; it implies the
  // master lens (loaders short-circuit to empty when the master flag is off).
  if (!isMethodPagesEnabled()) notFound();

  const items = await getSupercategoryHubEntries().catch(() => []);
  // No publicly-visible supercategory (lens off, or all-suppressed/sensitive) →
  // no hub page, no SEO leak.
  if (items.length === 0) notFound();

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>Methods</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <section className="mb-4">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          RESEARCH METHODS
        </div>
        <h1 className="page-title mt-2 text-3xl font-bold leading-tight tracking-tight">
          Research methods at WCM
        </h1>
        <p className="mt-3 max-w-prose text-base text-muted-foreground">
          The instruments, assays, datasets, and computational methods Weill
          Cornell Medicine researchers use, grouped into method categories.
        </p>
      </section>

      <MethodsHubGrid items={items} />
    </main>
  );
}
