/**
 * Home page composition (Phase 2).
 *
 * Hero + Recent contributions (RANKING-01) + Selected research (HOME-02) +
 * Browse all research areas (HOME-03). Sparse-state hide policy per D-12:
 * Recent contributions hides when <3 qualify, Selected research hides when
 * <4 qualify, Browse never hides.
 *
 * ISR per ADR-008: 6h fallback TTL; on-demand revalidation will fire after
 * each ETL completion via /api/revalidate?path=/ (Plan 09).
 */
import {
  getRecentContributions,
  getSelectedResearch,
  getBrowseAllResearchAreas,
} from "@/lib/api/home";
import { RecentContributionsGrid } from "@/components/home/recent-contributions-grid";
import { SelectedResearchCarousel } from "@/components/home/selected-research-carousel";
import { BrowseAllResearchAreasGrid } from "@/components/home/browse-all-research-areas-grid";

export const revalidate = 21600; // 6 hours
export const dynamicParams = true;

export default async function HomePage() {
  // Three independent fetches; .catch defense-in-depth so a transient DB blip
  // on one surface does not 5xx the whole page.
  const [recent, selected, browse] = await Promise.all([
    getRecentContributions().catch(() => null),
    getSelectedResearch().catch(() => null),
    getBrowseAllResearchAreas().catch(() => [] as Awaited<
      ReturnType<typeof getBrowseAllResearchAreas>
    >),
  ]);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <section className="text-center">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">
          Scholars at Weill Cornell Medicine
        </h1>
        <p className="text-muted-foreground mt-4 text-base">
          Discover the research, expertise, and people shaping medicine at WCM.
        </p>
      </section>

      {recent ? <RecentContributionsGrid items={recent} /> : null}
      {selected ? <SelectedResearchCarousel items={selected} /> : null}
      <BrowseAllResearchAreasGrid items={browse ?? []} />
    </main>
  );
}
