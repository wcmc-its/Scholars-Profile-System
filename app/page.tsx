/**
 * Home page composition (Phase 2).
 *
 * Hero + Spotlights (SPOTLIGHT-03) + Browse all research areas (HOME-03) +
 * Browse by method. Sparse-state hide policy per D-12: Spotlights hides under
 * its floor, Browse never hides.
 *
 * ISR per ADR-008: 6h fallback TTL; on-demand revalidation will fire after
 * each ETL completion via /api/revalidate?path=/ (Plan 09).
 *
 * Streaming: the shell (header + hero + search) is data-free and paints
 * immediately (TTFB ~70ms); each data-backed region is an async server
 * component behind its own <Suspense>, so a slow/cold render of one surface no
 * longer blocks first paint. The loaders are cached + stale-while-revalidate
 * (lib/api/home.ts) and pre-warmed at boot (lib/warmup.ts), so in steady state
 * the sections resolve before the shell flushes and no fallback is shown.
 */
import Link from "next/link";
import { cache, Suspense } from "react";
import {
  getSpotlights,
  getBrowseAllResearchAreas,
  getHomeStats,
  getHomeMethodCategories,
} from "@/lib/api/home";
import { SpotlightSection } from "@/components/home/spotlight-section";
import { selectSpotlightsForRender } from "@/lib/spotlight-sampling";
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import { BrowseAllResearchAreasGrid } from "@/components/home/browse-all-research-areas-grid";
import { BrowseByMethodSection } from "@/components/home/browse-by-method-section";
import { MethodBeaconLink } from "@/components/home/method-beacon-link";
import { TrySuggestionsChips } from "@/components/home/try-suggestions-chips";
import { SearchAutocomplete } from "@/components/search/autocomplete";
import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";

// #1503 interim — 2h fallback TTL (was 6h). Prod runs 2–6 app tasks with no
// shared cacheHandler, so `revalidatePath("/")` busts only one task's ISR store
// and CloudFront can refill the edge from a still-stale task. Shortening the TTL
// bounds that cross-task staleness window until the shared S3 cacheHandler lands
// (docs/1503-shared-cachehandler-spec.md). Regeneration is background (SWR).
export const revalidate = 7200; // 2 hours
export const dynamicParams = true;

// methodCategories drives BOTH the hero "N method families" stat (in HomeStats)
// and the Browse-by-method section, which now stream as independent Suspense
// boundaries. Memoize per request so the (uncached) taxonomy query runs once,
// not twice. React cache() is request-scoped, so — unlike a cross-request
// cache — it does not extend the #800/#801 overlay-visibility staleness.
const getMethodCategoriesOnce = cache(getHomeMethodCategories);

export default function HomePage() {
  return (
    <div className="home-page-root flex min-h-screen flex-col">
      {/*
        Skip link — the home page renders its own header/main outside the
        app/(public) layout, so it needs its own copy (WCAG 2.4.1 Bypass
        Blocks, Level A). Mirrors app/(public)/layout.tsx. #575.
      */}
      <a
        href="#main-content"
        className="sr-only rounded focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[100] focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--color-primary-cornell-red)] focus:shadow-md focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--color-accent-slate)]"
      >
        Skip to main content
      </a>
      <SiteHeader revealOnScrollPast="home-hero-search-sentinel" />
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {/* Hero — the title + search are data-free and paint immediately; only
            the stats row streams in (below the chips). Warm red-tint radial wash
            bridges the red header into the hero (home refinements mockup,
            2026-09-24). */}
        <section
          className="border-apollo-border-strong border-b px-6 pt-16 pb-12"
          style={{
            backgroundImage:
              "radial-gradient(ellipse 70% 110% at 50% 0%, var(--apollo-red-tint), var(--apollo-surface-2) 75%)",
          }}
        >
          <div className="mx-auto max-w-[760px] text-center">
            <h1 className="page-title text-4xl leading-[1.1] font-normal tracking-[-0.01em] text-balance sm:text-5xl">
              Scholars at Weill Cornell Medicine
            </h1>
            <p className="text-muted-foreground mt-4 text-base">
              Discover the research, expertise, and scholars shaping medicine at WCM.
            </p>
            <div id="home-hero-search-sentinel" className="mt-8">
              <SearchAutocomplete variant="hero" />
              <TrySuggestionsChips count={4} />
            </div>
            {/* Each data region streams independently behind its own Suspense. */}
            <Suspense fallback={null}>
              <HomeStats />
            </Suspense>
          </div>
        </section>

        <div className="mx-auto max-w-[1100px] px-6 pt-14 pb-20">
          <Suspense fallback={null}>
            <HomeSpotlights />
          </Suspense>
          <div id="browse-all-research-areas" tabIndex={-1} className="scroll-mt-16 outline-none">
            <Suspense fallback={null}>
              <HomeBrowseGrid />
            </Suspense>
          </div>
          <Suspense fallback={null}>
            <HomeMethodsSection />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

// --- Streamed data regions -------------------------------------------------
// Each is `.catch`-guarded (defense-in-depth so a transient DB blip on one
// surface hides only that surface rather than 5xx-ing the page) and returns
// null when its data is absent/sparse, exactly as the previous inline render
// did.

async function HomeStats() {
  const [stats, methodCategories] = await Promise.all([
    getHomeStats().catch(() => null),
    getMethodCategoriesOnce().catch(() => null),
  ]);
  if (!stats) return null;
  const stat = "flex flex-col items-center gap-0.5 text-[13px] text-muted-foreground no-underline hover:underline underline-offset-4 decoration-1";
  const figure = "font-serif text-[30px] leading-[34px] text-apollo-bar";
  return (
    <div className="mt-10 flex flex-wrap justify-center gap-x-12 gap-y-4">
      <Link href="/search" className={stat}>
        <span className={figure}>{stats.scholarCount.toLocaleString()}</span>scholars
      </Link>
      <Link href="/search?type=publications" className={stat}>
        <span className={figure}>{stats.publicationCount.toLocaleString()}</span>publications
      </Link>
      <a
        href="#browse-all-research-areas"
        aria-label={`Browse ${stats.researchAreaCount} research areas`}
        className={stat}
      >
        <span className={figure}>{stats.researchAreaCount}</span>research areas
      </a>
      {methodCategories ? (
        <MethodBeaconLink
          href="#browse-by-method"
          event="home_methods_stat_click"
          aria-label={`Browse ${methodCategories.totalFamilyCount} method families`}
          className={stat}
        >
          <span className={figure}>{methodCategories.totalFamilyCount.toLocaleString()}</span>method families
        </MethodBeaconLink>
      ) : null}
    </div>
  );
}

async function HomeSpotlights() {
  const spotlights = await getSpotlights().catch(() => null);
  if (!spotlights) return null;
  // #1709 — draw the 8 displayed spotlights (and the starting card) HERE, not in
  // a client useEffect. Re-picking after mount threw away this very render and
  // rebuilt the section, which read as the Spotlight being slow to appear. The
  // draw re-rolls on each ISR regeneration; see selectSpotlightsForRender.
  const { display, startIdx } = selectSpotlightsForRender(spotlights);
  // Home lives outside the (public) route group, so the modal provider mounted
  // in app/(public)/layout.tsx is not in scope. Wrap just the spotlight — the
  // only home surface with pub-title triggers — so its representative-paper
  // titles open the shared publication modal (#947). Modal portals to <body>,
  // so scope here is purely about context availability.
  return (
    <PublicationModalProvider>
      <SpotlightSection items={display} startIdx={startIdx} />
    </PublicationModalProvider>
  );
}

async function HomeBrowseGrid() {
  const browse = await getBrowseAllResearchAreas().catch(
    () => [] as Awaited<ReturnType<typeof getBrowseAllResearchAreas>>,
  );
  return <BrowseAllResearchAreasGrid items={browse ?? []} />;
}

async function HomeMethodsSection() {
  const methodCategories = await getMethodCategoriesOnce().catch(() => null);
  if (!methodCategories) return null;
  return (
    <div id="browse-by-method" tabIndex={-1} className="scroll-mt-16 outline-none">
      <BrowseByMethodSection data={methodCategories} />
    </div>
  );
}
