import { notFound } from "next/navigation";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { getFamilyCached } from "./get-family";

/**
 * #2963 — real 404 for an unknown/suppressed family (or pages flag off).
 * `loading.tsx` in this folder wraps the page in a Suspense boundary, so a
 * `notFound()` thrown from the page lands after the fallback has streamed with
 * `200` (soft 404, `noindex` only). This layout renders OUTSIDE that boundary,
 * so its `notFound()` still sets the HTTP status.
 */
export default async function FamilyScholarsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ supercategory: string; family: string }>;
}) {
  if (!isMethodPagesEnabled()) notFound();
  const { supercategory, family } = await params;
  if (!(await getFamilyCached(supercategory, family))) notFound();
  return children;
}
