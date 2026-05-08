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
  getSpotlights,
  getBrowseAllResearchAreas,
  getHomeStats,
} from "@/lib/api/home";
import { SpotlightSection } from "@/components/home/spotlight-section";
import { BrowseAllResearchAreasGrid } from "@/components/home/browse-all-research-areas-grid";
import { TrySuggestionsChips } from "@/components/home/try-suggestions-chips";
import { SearchAutocomplete } from "@/components/search/autocomplete";
import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import Link from "next/link";

export const revalidate = 21600; // 6 hours
export const dynamicParams = true;

export default async function HomePage() {
  // Three independent fetches; .catch defense-in-depth so a transient DB blip
  // on one surface does not 5xx the whole page. Phase 9 SPOTLIGHT-04: the new
  // spotlight section replaces both Selected research and Recent contributions
  // (the latter is suppressed; existing files are kept until Plan 09-07
  // cleanup removes them).
  const [spotlights, browse, stats] = await Promise.all([
    getSpotlights().catch(() => null),
    getBrowseAllResearchAreas().catch(() => [] as Awaited<ReturnType<typeof getBrowseAllResearchAreas>>),
    getHomeStats().catch(() => null),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-border border-b bg-gradient-to-b from-white to-zinc-50 px-6 py-16">
          <div className="mx-auto max-w-[760px] text-center">
            <h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
              Scholars at Weill Cornell Medicine
            </h1>
            <p className="text-muted-foreground mt-4 text-base">
              Discover the research, expertise, and people shaping medicine at WCM.
            </p>
            <div className="mt-8">
              <SearchAutocomplete variant="hero" />
              <TrySuggestionsChips count={6} />
            </div>
          </div>
        </section>

        {stats ? (
          <div className="border-border border-b">
            <div className="mx-auto flex max-w-[1100px] flex-wrap justify-center gap-8 px-6 py-5 text-sm text-zinc-500">
              <Link
                href="/search?type=people"
                aria-label={`Browse ${stats.scholarCount.toLocaleString()} scholars`}
                className="no-underline hover:underline underline-offset-4 decoration-1"
              >
                <strong className="text-zinc-700">{stats.scholarCount.toLocaleString()}</strong> scholars
              </Link>
              <Link
                href="/search?type=publications"
                aria-label={`Browse ${stats.publicationCount.toLocaleString()} publications`}
                className="no-underline hover:underline underline-offset-4 decoration-1"
              >
                <strong className="text-zinc-700">{stats.publicationCount.toLocaleString()}</strong> publications
              </Link>
              <a
                href="#browse-all-research-areas"
                aria-label={`Browse ${stats.researchAreaCount} research areas`}
                className="no-underline hover:underline underline-offset-4 decoration-1"
              >
                <strong className="text-zinc-700">{stats.researchAreaCount}</strong> research areas
              </a>
            </div>
          </div>
        ) : null}

        <div className="mx-auto max-w-[1100px] px-6 py-12">
          {spotlights ? <SpotlightSection items={spotlights} /> : null}
          <div id="browse-all-research-areas" className="scroll-mt-16">
            <BrowseAllResearchAreasGrid items={browse ?? []} />
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
