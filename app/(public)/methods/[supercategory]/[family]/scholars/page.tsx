import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getFamily,
  getMethodScholars,
  type MethodScholarRole,
} from "@/lib/api/methods";
import { supercategoryLabel } from "@/lib/methods/supercategory-labels";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { MethodAllScholars } from "@/components/method/method-all-scholars";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Comprehensive scholar list for a method family — the enumerative
 * "All scholars using this method · N" surface, reached from the family page's
 * "+ N more scholars →" affordance. ISR with 6h fallback, mirrors the family
 * page revalidation cadence.
 */
export const revalidate = 21600;
export const dynamicParams = true;

const VALID_ROLES: ReadonlyArray<MethodScholarRole> = [
  "all",
  "faculty",
  "postdocs",
  "doctoral_students",
];

const MAX_PAGE = 500;
const MAX_QUERY_LEN = 80;

function parseRole(raw: string | undefined): MethodScholarRole {
  if (raw && (VALID_ROLES as readonly string[]).includes(raw)) {
    return raw as MethodScholarRole;
  }
  return "all";
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_PAGE);
}

function parseQuery(raw: string | undefined): string {
  if (!raw) return "";
  return raw.slice(0, MAX_QUERY_LEN).trim();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ supercategory: string; family: string }>;
}): Promise<Metadata> {
  if (!isMethodPagesEnabled()) return { title: "Method not found" };
  const { supercategory, family } = await params;
  const resolved = await getFamily(supercategory, family).catch(() => null);
  if (!resolved) return { title: "Method not found" };
  return {
    title: `Scholars using ${resolved.familyLabel} — Scholars at WCM`,
    description: `Browse all WCM scholars publishing using ${resolved.familyLabel}.`,
    alternates: {
      canonical: `/methods/${resolved.supercategorySlug}/${resolved.familySlug}/scholars`,
    },
  };
}

export default async function FamilyScholarsPage({
  params,
  searchParams,
}: {
  params: Promise<{ supercategory: string; family: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isMethodPagesEnabled()) notFound();
  const { supercategory, family } = await params;
  const sp = await searchParams;

  const resolved = await getFamily(supercategory, family);
  if (!resolved) notFound();

  const role = parseRole(typeof sp.role === "string" ? sp.role : undefined);
  const page = parsePage(typeof sp.page === "string" ? sp.page : undefined);
  const q = parseQuery(typeof sp.q === "string" ? sp.q : undefined);

  const result = await getMethodScholars(resolved.supercategory, resolved.familyLabel, {
    page,
    role,
    q,
  });
  if (!result) notFound();

  const scLabel = supercategoryLabel(resolved.supercategory);
  const basePath = `/methods/${resolved.supercategorySlug}/${resolved.familySlug}/scholars`;

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href="/methods">Methods</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink href={`/methods/${resolved.supercategorySlug}`}>
              {scLabel}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbLink
              href={`/methods/${resolved.supercategorySlug}/${resolved.familySlug}`}
            >
              {resolved.familyLabel}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>›</BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage>Scholars</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-[var(--color-accent-slate)]">
          METHOD
        </div>
        <h1 className="page-title mt-2 text-3xl font-bold leading-tight tracking-tight">
          Scholars using {resolved.familyLabel}
        </h1>
      </header>

      <MethodAllScholars
        basePath={basePath}
        result={result}
        selectedRole={role}
        query={q}
        page={page}
        familyLabel={resolved.familyLabel}
      />
    </main>
  );
}
