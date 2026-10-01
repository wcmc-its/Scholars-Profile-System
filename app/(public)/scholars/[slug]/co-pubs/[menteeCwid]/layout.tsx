import { notFound } from "next/navigation";
import { resolvePair } from "./resolve-pair";

/**
 * #2963 — existence gate for /scholars/[slug]/co-pubs/[menteeCwid]. The parent
 * co-pubs layout only knows the mentor slug, so a real mentor with an unknown
 * or unrecorded mentee reached the page, whose `notFound()` lands after the
 * loading.tsx fallback has streamed with a 200 (a soft 404). This layout 404s
 * the pair before the page renders.
 */
export default async function MenteeCoPubsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string; menteeCwid: string }>;
}) {
  const { slug, menteeCwid } = await params;
  if (!(await resolvePair(slug, menteeCwid))) notFound();
  return children;
}
