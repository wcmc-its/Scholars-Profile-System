import { notFound } from "next/navigation";
import { ResearchAreasBenchmark } from "@/components/about/research-areas-benchmark";
import { loadBenchmarkLinks, loadSnapshot, SNAPSHOTS } from "@/lib/benchmark";
import { isrBuildFallback } from "@/lib/isr-build-fallback";

/** Shared by /about/research-areas (latest) and /about/research-areas/[snapshot]. */
export async function renderBenchmark(date: string) {
  const snap = await loadSnapshot(date);
  if (!snap) notFound();
  // Live hrefs come from the DB; the build has none, so links render as plain
  // text there and the first runtime request regenerates the page.
  const links = await loadBenchmarkLinks().catch(isrBuildFallback({ areas: {}, units: {} }));
  return <ResearchAreasBenchmark snap={snap} snapshots={SNAPSHOTS} links={links} />;
}
