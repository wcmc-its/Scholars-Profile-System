/**
 * Server loaders for the Usage dashboard's traffic sections (sources, referring
 * sites and pages, top and landing pages, AI), read from the `daily_traffic`
 * Athena rollup. The SQL lives in lib/analytics/traffic-queries.ts and the
 * pure shaping in lib/analytics/traffic-view.ts.
 *
 * The overview and each list page are wrapped in `unstable_cache` keyed by
 * every query parameter, with the usage dashboard's half-day TTL (the rollup
 * is nightly). A thrown Athena error propagates out of the uncached loader, so
 * a failure is never cached as an empty result. The Excel export reads every
 * row and is not cached (rare, and too large for a cache entry).
 *
 * A unit-scoped viewer's page lists (`loadScopedPageList`, and the workbook's
 * page sheets via `scopeExportRows`) hold only their own people's profile
 * pages: the rows are read site-wide and filtered here per viewer, so no slug
 * list ever reaches Athena SQL and no per-viewer result is cached.
 */
import { unstable_cache } from "next/cache";

import { runUsageQuery } from "@/lib/analytics/athena-client";
import { resolveUsageRange } from "@/lib/api/usage-range";
import { type ReferrerCategory, isReferrerCategory } from "@/lib/analytics/referrer-category";
import {
  type AiClass,
  type PageKind,
  type ReferrerView,
  TRAFFIC_PAGE_SIZE,
  buildLandingExportQuery,
  buildPageListQuery,
  buildReferrerListQuery,
  buildTrafficOverviewQueries,
  isAiClass,
  isPageKind,
} from "@/lib/analytics/traffic-queries";
import {
  type Row,
  type TrafficListPage,
  type TrafficOverview,
  shapePageList,
  shapeReferrerList,
  shapeTrafficOverview,
} from "@/lib/analytics/traffic-view";

/** The page's `range` / `from` / `to` params -> the window on screen (resolveUsageRange). */
export function rangeFromSearchParams(
  sp: URLSearchParams,
  today = new Date().toISOString().slice(0, 10),
) {
  return resolveUsageRange(
    {
      range: sp.get("range") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
    },
    today,
  );
}

const TRAFFIC_CACHE_TTL_SECONDS = 43_200;
/** Matches traffic-queries' MAX_OFFSET. */
const MAX_LIST_OFFSET = 1_000_000;
const CACHE_VERSION = "v1";

export type TrafficWindow = { since: string; until: string };

async function loadTrafficOverviewUncached(w: TrafficWindow): Promise<TrafficOverview> {
  const q = buildTrafficOverviewQueries(w.since, w.until);
  const [kpi, sourcesDaily, referrerTotals, aiDaily, vendors, firstDt] = await Promise.all([
    runUsageQuery(q.kpi),
    runUsageQuery(q.sourcesDaily),
    runUsageQuery(q.referrerTotals),
    runUsageQuery(q.aiDaily),
    runUsageQuery(q.vendors),
    runUsageQuery(q.firstDt),
  ]);
  return shapeTrafficOverview({ kpi, sourcesDaily, referrerTotals, aiDaily, vendors, firstDt }, w);
}

/** The overview for a window, cached per window. Throws on any Athena error (never cached). */
export function loadTrafficOverview(w: TrafficWindow): Promise<TrafficOverview> {
  return unstable_cache(
    () => loadTrafficOverviewUncached(w),
    ["usage-traffic-overview", CACHE_VERSION, w.since, w.until],
    { revalidate: TRAFFIC_CACHE_TTL_SECONDS, tags: ["usage-traffic"] },
  )();
}

/** One list request, as parsed from the route's query string. */
export type TrafficListRequest =
  | {
      list: "referrers";
      view: ReferrerView;
      categories: ReferrerCategory[];
      q: string;
      offset: number;
    }
  | {
      list: "pages";
      kind: PageKind;
      categories: ReferrerCategory[];
      aiClasses: AiClass[];
      offset: number;
    };

function csv(v: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse and validate the list route's query string. Returns null on anything
 * malformed (an unknown list, view, kind, category or AI class, or a bad
 * offset), so the route can 400 instead of building SQL from it.
 */
export function parseTrafficListRequest(sp: URLSearchParams): TrafficListRequest | null {
  const offsetRaw = sp.get("offset") ?? "0";
  if (!/^\d{1,7}$/.test(offsetRaw)) return null;
  const offset = Number(offsetRaw);
  // The SQL builder rejects offsets past its own bound; 400 here, not a 500 there.
  if (offset > MAX_LIST_OFFSET) return null;
  const cats = csv(sp.get("cats"));
  if (!cats.every(isReferrerCategory)) return null;
  const categories = [...new Set(cats)].sort() as ReferrerCategory[];
  const list = sp.get("list");
  if (list === "referrers") {
    const view = sp.get("view") ?? "site";
    if (view !== "site" && view !== "page") return null;
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    return { list, view, categories, q, offset };
  }
  if (list === "pages") {
    const kind = sp.get("kind") ?? "all";
    if (!isPageKind(kind)) return null;
    const ai = csv(sp.get("ai"));
    if (!ai.every(isAiClass)) return null;
    return { list, kind, categories, aiClasses: [...new Set(ai)].sort() as AiClass[], offset };
  }
  return null;
}

async function loadTrafficListUncached(
  w: TrafficWindow,
  req: TrafficListRequest,
): Promise<TrafficListPage> {
  if (req.list === "referrers") {
    const sql = buildReferrerListQuery({
      ...w,
      view: req.view,
      categories: req.categories,
      q: req.q,
      offset: req.offset,
      limit: TRAFFIC_PAGE_SIZE,
    });
    return shapeReferrerList(await runUsageQuery(sql));
  }
  const sql = buildPageListQuery({
    ...w,
    kind: req.kind,
    categories: req.categories,
    aiClasses: req.aiClasses,
    offset: req.offset,
    limit: TRAFFIC_PAGE_SIZE,
  });
  return shapePageList(await runUsageQuery(sql));
}

/** One page of a list, cached per window + request. Throws on any Athena error (never cached). */
export function loadTrafficList(
  w: TrafficWindow,
  req: TrafficListRequest,
): Promise<TrafficListPage> {
  return unstable_cache(
    () => loadTrafficListUncached(w, req),
    ["usage-traffic-list", CACHE_VERSION, w.since, w.until, JSON.stringify(req)],
    { revalidate: TRAFFIC_CACHE_TTL_SECONDS, tags: ["usage-traffic"] },
  )();
}

/** True when `path` is the profile page of one of `slugs` (lower-cased keys). */
function isScopedProfilePath(path: string, slugs: ReadonlyMap<string, string>): boolean {
  return path.startsWith("/") && slugs.has(path.slice(1).toLowerCase());
}

/**
 * One page of a pages list for a unit-scoped viewer: only the profile pages of
 * `slugs` (the viewer's people). Every profile page for the window + "Arrived
 * from" filter is read once, unpaged, and cached under a key that names no
 * viewer; the unit filter and the paging happen here. A page type other than
 * "all" / "profile" has no unit pages, so it is empty.
 */
export async function loadScopedPageList(
  w: TrafficWindow,
  req: Extract<TrafficListRequest, { list: "pages" }>,
  slugs: ReadonlyMap<string, string>,
): Promise<TrafficListPage> {
  if (req.kind !== "all" && req.kind !== "profile") return { rows: [], total: 0 };
  const all = await unstable_cache(
    async () =>
      shapePageList(
        await runUsageQuery(
          buildPageListQuery({
            ...w,
            kind: "profile",
            categories: req.categories,
            aiClasses: req.aiClasses,
            offset: 0,
            limit: null,
          }),
        ),
      ).rows,
    [
      "usage-traffic-profile-pages",
      CACHE_VERSION,
      w.since,
      w.until,
      JSON.stringify([req.categories, req.aiClasses]),
    ],
    { revalidate: TRAFFIC_CACHE_TTL_SECONDS, tags: ["usage-traffic"] },
  )();
  const rows = all.filter((r) => isScopedProfilePath(r.label, slugs));
  return { rows: rows.slice(req.offset, req.offset + TRAFFIC_PAGE_SIZE), total: rows.length };
}

/** The workbook rows for a unit-scoped viewer: the Top pages and Landing pages
 *  sheets keep only their people's profile pages; the referrer sheets are
 *  site-wide and unchanged. */
export function scopeExportRows(
  rows: TrafficExportRows,
  slugs: ReadonlyMap<string, string>,
): TrafficExportRows {
  const mine = (r: Row) => isScopedProfilePath(r.page ?? "", slugs);
  return { ...rows, topPages: rows.topPages.filter(mine), landing: rows.landing.filter(mine) };
}

/** Every row the workbook lists, unpaged. */
export type TrafficExportRows = {
  referringSites: Row[];
  referringPages: Row[];
  topPages: Row[];
  landing: Row[];
};

/** The workbook's list sheets, read unpaged and uncached. Throws on any Athena error. */
export async function loadTrafficExportRows(w: TrafficWindow): Promise<TrafficExportRows> {
  const all = { categories: [] as ReferrerCategory[], offset: 0, limit: null };
  const [referringSites, referringPages, topPages, landing] = await Promise.all([
    runUsageQuery(buildReferrerListQuery({ ...w, ...all, view: "site" })),
    runUsageQuery(buildReferrerListQuery({ ...w, ...all, view: "page" })),
    runUsageQuery(buildPageListQuery({ ...w, ...all, kind: "all", aiClasses: [] })),
    runUsageQuery(buildLandingExportQuery(w.since, w.until)),
  ]);
  return { referringSites, referringPages, topPages, landing };
}
