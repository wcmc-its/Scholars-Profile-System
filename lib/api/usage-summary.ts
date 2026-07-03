/**
 * The in-app Usage dashboard view model: reads the six usage metrics from the
 * `daily_usage` Athena rollup (last {@link USAGE_WINDOW_DAYS} days) and shapes
 * them for `/edit/usage`. Global (site-wide) aggregates only — no PII, no
 * per-unit scoping (decision 2026-07-03).
 *
 * The Athena queries are wrapped in `unstable_cache` (daily revalidate): the
 * rollup only changes nightly, so a per-request Athena round-trip would be pure
 * waste. On a cache miss the six queries run in parallel (~1-2s); every other
 * view is served from cache. Any Athena failure throws out of the uncached
 * loader (never cached) and the page renders an "unavailable" notice.
 *
 * shapeUsageRows is pure (raw rows -> view model) so it unit-tests without the
 * SDK — the usage-queries.ts / athena-client.ts split.
 */
import { unstable_cache } from "next/cache";

import { runUsageQuery, type AthenaRow } from "@/lib/analytics/athena-client";
import { buildUsageQueries } from "@/lib/analytics/usage-queries";

/** Rolling window the dashboard covers. */
export const USAGE_WINDOW_DAYS = 30;
/** Cache TTL — the rollup is nightly, so half a day is plenty fresh. */
const USAGE_CACHE_TTL_SECONDS = 43_200;

export type DayViews = { day: string; views: number };
export type ProfileViews = { cwid: string; views: number };
export type TermCount = { term: string; searches: number };
export type NamedCount = { label: string; hits: number };

export type UsageSummary = {
  windowDays: number;
  totalPageviews: number;
  pageviewsByDay: DayViews[];
  topProfiles: ProfileViews[];
  searchTerms: TermCount[];
  referrers: NamedCount[];
  geo: NamedCount[];
  device: NamedCount[];
};

/** The six raw result sets, keyed like {@link buildUsageQueries}. */
export type UsageRows = {
  pageviewsByDay: AthenaRow[];
  topProfiles: AthenaRow[];
  searchTerms: AthenaRow[];
  referrers: AthenaRow[];
  geo: AthenaRow[];
  device: AthenaRow[];
};

/** Parse an Athena numeric cell (always a string) to a finite number, else 0. */
function n(v: string | undefined): number {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Pure shaper: the six raw result sets -> the dashboard view model. */
export function shapeUsageRows(rows: UsageRows): UsageSummary {
  const pageviewsByDay = rows.pageviewsByDay.map((r) => ({ day: r.dt ?? "", views: n(r.views) }));
  return {
    windowDays: USAGE_WINDOW_DAYS,
    totalPageviews: pageviewsByDay.reduce((sum, r) => sum + r.views, 0),
    pageviewsByDay,
    topProfiles: rows.topProfiles.map((r) => ({ cwid: r.cwid ?? "", views: n(r.views) })),
    searchTerms: rows.searchTerms.map((r) => ({ term: r.term ?? "", searches: n(r.searches) })),
    referrers: rows.referrers.map((r) => ({ label: r.referrer ?? "", hits: n(r.hits) })),
    geo: rows.geo.map((r) => ({ label: r.region ?? "", hits: n(r.hits) })),
    device: rows.device.map((r) => ({ label: r.device ?? "", hits: n(r.hits) })),
  };
}

/** UTC date N days before today, as YYYY-MM-DD. */
function utcDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadUsageSummaryUncached(): Promise<UsageSummary> {
  const q = buildUsageQueries(utcDaysAgo(USAGE_WINDOW_DAYS));
  const [pageviewsByDay, topProfiles, searchTerms, referrers, geo, device] = await Promise.all([
    runUsageQuery(q.pageviewsByDay),
    runUsageQuery(q.topProfiles),
    runUsageQuery(q.searchTerms),
    runUsageQuery(q.referrers),
    runUsageQuery(q.geo),
    runUsageQuery(q.device),
  ]);
  return shapeUsageRows({ pageviewsByDay, topProfiles, searchTerms, referrers, geo, device });
}

/**
 * Cached loader for the page. Daily revalidate so the six-query Athena round-trip
 * runs at most ~twice a day per app instance; a thrown Athena error propagates
 * (never cached) so the page can fail soft.
 */
export const loadUsageSummary = unstable_cache(loadUsageSummaryUncached, ["usage-summary"], {
  revalidate: USAGE_CACHE_TTL_SECONDS,
  tags: ["usage-summary"],
});
