import type { Metadata } from "next";
import { LATEST, SNAPSHOTS } from "@/lib/benchmark";
import { renderBenchmark } from "../render";

// Past snapshots stay viewable at a stable URL. The latest one lives at
// /about/research-areas; its dated URL is redirected in next.config.ts.
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return SNAPSHOTS.filter((s) => s.date !== LATEST.date).map((s) => ({ snapshot: s.date }));
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
  return renderBenchmark(snapshot);
}
