import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { LATEST, SNAPSHOTS } from "@/lib/benchmark";
import { renderBenchmark } from "../render";

// Past snapshots stay viewable at a stable URL. The latest one lives at
// /about/research-areas, so its dated URL redirects there.
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return SNAPSHOTS.map((s) => ({ snapshot: s.date }));
}

type Props = { params: Promise<{ snapshot: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { snapshot } = await params;
  return {
    title: `Research areas compared (${snapshot} snapshot)`,
    alternates: { canonical: "/about/research-areas" },
  };
}

export default async function ResearchAreasSnapshotPage({ params }: Props) {
  const { snapshot } = await params;
  if (snapshot === LATEST.date) permanentRedirect("/about/research-areas");
  return renderBenchmark(snapshot);
}
