import { notFound } from "next/navigation";
import { resolveMentor } from "./resolve-mentor";

/**
 * #2963 — real 404 for an unknown/hidden mentor. `loading.tsx` in this folder
 * wraps the page in a Suspense boundary, so a `notFound()` thrown from the page
 * lands after the fallback has streamed with `200` (soft 404, `noindex` only).
 * This layout renders OUTSIDE that boundary, so its `notFound()` still sets the
 * HTTP status. Covers `[menteeCwid]` too (same mentor gate).
 */
export default async function MentorCoPubsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!(await resolveMentor(slug))) notFound();
  return children;
}
