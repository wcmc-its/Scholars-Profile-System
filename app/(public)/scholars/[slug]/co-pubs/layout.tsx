import { notFound } from "next/navigation";
import { resolveMentor } from "./resolve-mentor";

/**
 * #2963 — existence gate for /scholars/[slug]/co-pubs/**. Each page's
 * loading.tsx wraps it in a Suspense boundary, so a `notFound()` thrown
 * from a page lands after the fallback has streamed with a 200 (a soft 404).
 * A layout renders OUTSIDE that boundary, so an unknown mentor 404s here
 * before anything streams.
 */
export default async function CoPubsLayout({
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
