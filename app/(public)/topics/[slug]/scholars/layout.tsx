import { notFound } from "next/navigation";
import { loadTopic } from "./load-topic";

/**
 * #2963 — existence gate for /topics/[slug]/scholars. The sibling loading.tsx
 * wraps the page in a Suspense boundary, so a `notFound()` thrown from the page
 * lands after the fallback has streamed with a 200 (a soft 404). A layout
 * renders OUTSIDE that boundary, so an unknown topic 404s here before anything
 * streams.
 */
export default async function TopicScholarsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!(await loadTopic(slug))) notFound();
  return children;
}
