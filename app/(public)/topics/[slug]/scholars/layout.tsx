import { notFound } from "next/navigation";
import { getTopicCached } from "./get-topic";

/**
 * #2963 — real 404 for an unknown topic. `loading.tsx` in this folder wraps the
 * page in a Suspense boundary, so a `notFound()` thrown from the page lands after
 * the fallback has streamed with `200` (soft 404, `noindex` only). This layout
 * renders OUTSIDE that boundary, so its `notFound()` still sets the HTTP status.
 */
export default async function TopicScholarsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!(await getTopicCached(slug))) notFound();
  return children;
}
