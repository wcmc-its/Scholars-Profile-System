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

// #985 — force-dynamic: the #800/#801 family-visibility overlay gate is
// per-request, but ISR (revalidate=21600) cached the rendered shell for up to
// 6h, leaving a steward-suppressed/sensitive family publicly reachable (in the
// supercategory rail, family shell, and JSON-LD) until the next revalidate. The
// data layer is already overlay-gated per request; force-dynamic makes the page
// honor it. (Perf-optimal purge-on-edit that restores ISR is the #985 follow-up.)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Methods & tools at WCM",
  description:
    "Browse the research methods, tools, and method families used by scholars across Weill Cornell Medicine.",
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
          METHODS &amp; TOOLS
        </div>
        <h1 className="page-title mt-2 text-3xl font-bold leading-tight tracking-tight">
          Methods &amp; tools
        </h1>
        <p className="mt-3 max-w-prose text-base text-muted-foreground">
          The instruments, assays, datasets, and computational methods &amp; tools
          Weill Cornell Medicine researchers use, grouped into categories.
        </p>
      </section>

      <MethodsHubGrid items={items} />
    </main>
  );
}
