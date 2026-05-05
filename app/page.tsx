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
  getHomeStats,
} from "@/lib/api/home";
import { RecentContributionsGrid } from "@/components/home/recent-contributions-grid";
import { SelectedResearchCarousel } from "@/components/home/selected-research-carousel";
import { BrowseAllResearchAreasGrid } from "@/components/home/browse-all-research-areas-grid";
import { HeroSearchForm } from "@/components/home/hero-search-form";
import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";

export const revalidate = 21600; // 6 hours
export const dynamicParams = true;

export default async function HomePage() {
  // Four independent fetches; .catch defense-in-depth so a transient DB blip
  // on one surface does not 5xx the whole page.
  const [recent, selected, browse, stats] = await Promise.all([
    getRecentContributions().catch(() => null),
    getSelectedResearch().catch(() => null),
    getBrowseAllResearchAreas().catch(() => [] as Awaited<ReturnType<typeof getBrowseAllResearchAreas>>),
    getHomeStats().catch(() => null),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader showSearch={false} />
      <main className="flex-1">
        <section className="border-border border-b bg-gradient-to-b from-white to-zinc-50 px-6 py-16">
          <div className="mx-auto max-w-[760px] text-center">
            <h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
              Scholars at Weill Cornell Medicine
            </h1>
            <p className="text-muted-foreground mt-4 text-base">
              Discover the research, expertise, and people shaping medicine at WCM.
            </p>
            <HeroSearchForm />
          </div>
        </section>

        {stats ? (
          <div className="border-border border-b">
            <div className="mx-auto flex max-w-[1100px] flex-wrap justify-center gap-8 px-6 py-5 text-sm text-zinc-500">
              <span><strong className="text-zinc-700">{stats.scholarCount.toLocaleString()}</strong> scholars</span>
              <span><strong className="text-zinc-700">{stats.publicationCount.toLocaleString()}</strong> publications</span>
              <span><strong className="text-zinc-700">{stats.researchAreaCount}</strong> research areas</span>
            </div>
          </div>
        ) : null}

        <div className="mx-auto max-w-[1100px] px-6 py-12">
          {selected ? <SelectedResearchCarousel items={selected} /> : null}
          {recent ? <RecentContributionsGrid items={recent} /> : null}
          <BrowseAllResearchAreasGrid items={browse ?? []} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
