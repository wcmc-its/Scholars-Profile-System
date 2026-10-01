import { notFound } from "next/navigation";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import { loadFamily } from "./load-family";

/**
 * #2963 — existence gate for /methods/[supercategory]/[family]/scholars. The
 * sibling loading.tsx wraps the page in a Suspense boundary, so a `notFound()`
 * thrown from the page lands after the fallback has streamed with a 200 (a soft
 * 404). A layout renders OUTSIDE that boundary, so an unknown (or
 * flag-disabled) family 404s here before anything streams.
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
  if (!(await loadFamily(supercategory, family))) notFound();
  return children;
}
