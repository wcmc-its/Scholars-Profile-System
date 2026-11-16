/**
 * The in-app Usage dashboard view model: reads the usage metrics from the
 * `daily_usage` Athena rollup over a caller-chosen window (lib/api/usage-range:
 * last 7 / 30 / 90 days, since launch, or a custom range) and shapes them for
 * `/edit/usage`. `daily_usage` is durable (the analytics bucket has no expiry
 * rule), so any window back to the first rollup can be read. Global (site-wide) aggregates only — no PII, no
 * per-unit scoping (decision 2026-07-03).
 *
 * The Athena queries are wrapped in `unstable_cache` (daily revalidate), keyed
 * per window (`since` + `until`), so each range caches on its own: the rollup
 * only changes nightly, so a per-request Athena round-trip would be pure
 * waste. On a cache miss the nine queries run in parallel (~1-2s); every other
 * view is served from cache. Any Athena failure throws out of the uncached
 * loader (never cached) and the page renders an "unavailable" notice.
 *
 * shapeUsageRows is pure (raw rows -> view model) so it unit-tests without the
 * SDK — the usage-queries.ts / athena-client.ts split.
 */
import { unstable_cache } from "next/cache";

import { runUsageQuery, type AthenaRow } from "@/lib/analytics/athena-client";
import { buildUsageQueries } from "@/lib/analytics/usage-queries";
import { type HourBucket, type HourlyTraffic, easternHour } from "@/lib/api/usage-hourly";

/** Default rolling window (the page's "Last 30 days"). */
export const USAGE_WINDOW_DAYS = 30;
/** Cache TTL — the rollup is nightly, so half a day is plenty fresh. */
const USAGE_CACHE_TTL_SECONDS = 43_200;

export type DayViews = { day: string; views: number };
export type ProfileViews = { slug: string; views: number };
export type TermCount = { term: string; searches: number };
export type NamedCount = { label: string; hits: number };
/** Range search totals from SEARCH_STATS_START on: typed vs suggestion clicks (served searches only). */
export type SearchVolume = { typed: number; suggested: number };

export type UsageSummary = {
  windowDays: number;
  /** Inclusive window bounds (YYYY-MM-DD); empty when shaped without a window. */
  since: string;
  until: string;
  totalPageviews: number;
  pageviewsByDay: DayViews[];
  topProfiles: ProfileViews[];
  /** Terms people typed (no `src=` tag), from SEARCH_STATS_START on. */
  searchTerms: TermCount[];
  /** Suggestion clicks (home chips, typeahead concept picks), from SEARCH_STATS_START on. */
  suggestedSearchTerms: TermCount[];
  searchVolume: SearchVolume;
  referrers: NamedCount[];
  geo: NamedCount[];
  device: NamedCount[];
  /** Page requests per hour (Eastern) by traffic class; empty before the hourly rollup began. */
  hourly: HourlyTraffic;
};

/** The raw result sets, keyed like {@link buildUsageQueries}. */
export type UsageRows = {
  pageviewsByDay: AthenaRow[];
  topProfiles: AthenaRow[];
  searchTerms: AthenaRow[];
  suggestedSearchTerms: AthenaRow[];
  searchTotals: AthenaRow[];
  referrers: AthenaRow[];
  geo: AthenaRow[];
  device: AthenaRow[];
  hourly: AthenaRow[];
};

/** Parse an Athena numeric cell (always a string) to a finite number, else 0. */
function n(v: string | undefined): number {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function terms(rows: AthenaRow[]): TermCount[] {
  return rows.map((r) => ({ term: r.term ?? "", searches: n(r.searches) }));
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_SLOT = /^(\d{2})\|(human|bot|error)$/;
const HOUR_MS = 3_600_000;

/**
 * The `hourly` rows (dt, slot = '<HH>|<class>' in UTC, hits) -> hour buckets in
 * Eastern time. Every UTC day with any hourly row gets all 24 of its hours (an
 * hour with no row is a real zero: the rollup ran and counted nothing), so a
 * gap in the result means a day the rollup never covered, never a quiet hour.
 * Keyed by the UTC instant, so the two 1 AM hours of a fall-back day stay two
 * buckets. Malformed rows are skipped.
 */
export function shapeHourly(rows: AthenaRow[]): HourlyTraffic {
  const byAt = new Map<number, HourBucket>();
  const days = new Set<string>();
  for (const r of rows) {
    const dt = r.dt ?? "";
    const m = HOUR_SLOT.exec(r.slot ?? "");
    const base = Date.parse(`${dt}T00:00:00Z`);
    if (!ISO_DT.test(dt) || !m || !Number.isFinite(base) || Number(m[1]) > 23) continue;
    if (!days.has(dt)) {
      days.add(dt);
      for (let h = 0; h < 24; h++) {
        const at = base + h * HOUR_MS;
        byAt.set(at, { at, ...easternHour(at), human: 0, bot: 0, error: 0 });
      }
    }
    const bucket = byAt.get(base + Number(m[1]) * HOUR_MS)!;
    bucket[m[2] as "human" | "bot" | "error"] += n(r.hits);
  }
  const sortedDays = [...days].sort();
  return {
    buckets: [...byAt.values()].sort((a, b) => a.at - b.at),
    firstDay: sortedDays[0] ?? null,
    days: sortedDays.length,
  };
}

/** The window a summary covers. */
export type UsageWindow = { since: string; until: string; days: number };

/** Pure shaper: the raw result sets -> the dashboard view model. */
export function shapeUsageRows(rows: UsageRows, window?: UsageWindow): UsageSummary {
  const pageviewsByDay = rows.pageviewsByDay.map((r) => ({ day: r.dt ?? "", views: n(r.views) }));
  const total = (metric: string): number =>
    rows.searchTotals.reduce((sum, r) => (r.metric === metric ? sum + n(r.searches) : sum), 0);
  return {
    windowDays: window?.days ?? USAGE_WINDOW_DAYS,
    since: window?.since ?? "",
    until: window?.until ?? "",
    totalPageviews: pageviewsByDay.reduce((sum, r) => sum + r.views, 0),
    pageviewsByDay,
    topProfiles: rows.topProfiles.map((r) => ({ slug: r.slug ?? "", views: n(r.views) })),
    searchTerms: terms(rows.searchTerms),
    suggestedSearchTerms: terms(rows.suggestedSearchTerms),
    searchVolume: { typed: total("typed"), suggested: total("suggested") },
    referrers: rows.referrers.map((r) => ({ label: r.referrer ?? "", hits: n(r.hits) })),
    geo: rows.geo.map((r) => ({ label: r.region ?? "", hits: n(r.hits) })),
    device: rows.device.map((r) => ({ label: r.device ?? "", hits: n(r.hits) })),
    hourly: shapeHourly(rows.hourly),
  };
}

async function loadUsageSummaryUncached(window: UsageWindow): Promise<UsageSummary> {
  const q = buildUsageQueries(window.since, window.until);
  const [
    pageviewsByDay,
    topProfiles,
    searchTerms,
    suggestedSearchTerms,
    searchTotals,
    referrers,
    geo,
    device,
    hourly,
  ] = await Promise.all([
    runUsageQuery(q.pageviewsByDay),
    runUsageQuery(q.topProfiles),
    runUsageQuery(q.searchTerms),
    runUsageQuery(q.suggestedSearchTerms),
    runUsageQuery(q.searchTotals),
    runUsageQuery(q.referrers),
    runUsageQuery(q.geo),
    runUsageQuery(q.device),
    runUsageQuery(q.hourly),
  ]);
  return shapeUsageRows(
    {
      pageviewsByDay,
      topProfiles,
      searchTerms,
      suggestedSearchTerms,
      searchTotals,
      referrers,
      geo,
      device,
      hourly,
    },
    window,
  );
}

/**
 * Cached loader for the page, one cache entry per window: the key carries the
 * window's `since` and `until`, so "Last 7 days" and "Since launch" never share
 * an entry and a custom range gets its own. Daily revalidate, so each window's
 * nine-query Athena round-trip runs at most ~twice a day per app instance. A
 * thrown Athena error propagates (never cached) so the page can fail soft. The
 * dates are validated to strict YYYY-MM-DD by buildUsageQueries before any SQL.
 */
export function loadUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  return unstable_cache(
    () => loadUsageSummaryUncached(window),
    // v5: + hourly (a cached v4 entry lacks it).
    ["usage-summary", "v6", window.since, window.until],
    { revalidate: USAGE_CACHE_TTL_SECONDS, tags: ["usage-summary"] },
  )();
}
