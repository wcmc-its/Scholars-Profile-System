/**
 * The in-app Usage dashboard view model: reads the six usage metrics from the
 * `daily_usage` Athena rollup over a caller-chosen window (lib/api/usage-range:
 * last 7 / 30 / 90 days, since launch, or a custom range) and shapes them for
 * `/edit/usage`. `daily_usage` is durable (the analytics bucket has no expiry
 * rule), so any window back to the first rollup can be read. Global (site-wide) aggregates only — no PII, no
 * per-unit scoping (decision 2026-07-03).
 *
 * The Athena queries are wrapped in `unstable_cache` (daily revalidate), keyed
 * per window (`since` + `until`), so each range caches on its own: the rollup
 * only changes nightly, so a per-request Athena round-trip would be pure
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

/** Default rolling window (the page's "Last 30 days"). */
export const USAGE_WINDOW_DAYS = 30;
/** Cache TTL — the rollup is nightly, so half a day is plenty fresh. */
const USAGE_CACHE_TTL_SECONDS = 43_200;

export type DayViews = { day: string; views: number };
export type ProfileViews = { slug: string; views: number };
export type TermCount = { term: string; searches: number };
export type NamedCount = { label: string; hits: number };

export type UsageSummary = {
  windowDays: number;
  /** Inclusive window bounds (YYYY-MM-DD); empty when shaped without a window. */
  since: string;
  until: string;
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

/** The window a summary covers. */
export type UsageWindow = { since: string; until: string; days: number };

/** Pure shaper: the six raw result sets -> the dashboard view model. */
export function shapeUsageRows(rows: UsageRows, window?: UsageWindow): UsageSummary {
  const pageviewsByDay = rows.pageviewsByDay.map((r) => ({ day: r.dt ?? "", views: n(r.views) }));
  return {
    windowDays: window?.days ?? USAGE_WINDOW_DAYS,
    since: window?.since ?? "",
    until: window?.until ?? "",
    totalPageviews: pageviewsByDay.reduce((sum, r) => sum + r.views, 0),
    pageviewsByDay,
    topProfiles: rows.topProfiles.map((r) => ({ slug: r.slug ?? "", views: n(r.views) })),
    searchTerms: rows.searchTerms.map((r) => ({ term: r.term ?? "", searches: n(r.searches) })),
    referrers: rows.referrers.map((r) => ({ label: r.referrer ?? "", hits: n(r.hits) })),
    geo: rows.geo.map((r) => ({ label: r.region ?? "", hits: n(r.hits) })),
    device: rows.device.map((r) => ({ label: r.device ?? "", hits: n(r.hits) })),
  };
}

async function loadUsageSummaryUncached(window: UsageWindow): Promise<UsageSummary> {
  const q = buildUsageQueries(window.since, window.until);
  const [pageviewsByDay, topProfiles, searchTerms, referrers, geo, device] = await Promise.all([
    runUsageQuery(q.pageviewsByDay),
    runUsageQuery(q.topProfiles),
    runUsageQuery(q.searchTerms),
    runUsageQuery(q.referrers),
    runUsageQuery(q.geo),
    runUsageQuery(q.device),
  ]);
  return shapeUsageRows(
    { pageviewsByDay, topProfiles, searchTerms, referrers, geo, device },
    window,
  );
}

/**
 * Cached loader for the page, one cache entry per window: the key carries the
 * window's `since` and `until`, so "Last 7 days" and "Since launch" never share
 * an entry and a custom range gets its own. Daily revalidate, so each window's
 * six-query Athena round-trip runs at most ~twice a day per app instance. A
 * thrown Athena error propagates (never cached) so the page can fail soft. The
 * dates are validated to strict YYYY-MM-DD by buildUsageQueries before any SQL.
 */
export function loadUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  return unstable_cache(
    () => loadUsageSummaryUncached(window),
    ["usage-summary", "v2", window.since, window.until],
    { revalidate: USAGE_CACHE_TTL_SECONDS, tags: ["usage-summary"] },
  )();
}
