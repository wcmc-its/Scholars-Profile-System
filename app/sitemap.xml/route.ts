import {
  buildSitemapEntries,
  renderSitemapIndex,
  siteBaseUrl,
  sitemapChunkCount,
} from "@/lib/sitemap";

/**
 * Sitemap **index** at `/sitemap.xml` (#124, B25). robots.txt and Search Console
 * point crawlers here; it lists the child sitemaps (`/sitemap/[id].xml`), one
 * per `URLS_PER_SITEMAP`-sized shard of the corpus.
 *
 * Shard count is derived from the same `buildSitemapEntries()` the children use,
 * so the index and the children agree on how many shards exist.
 */

// ISR — falls back to 24h revalidation if no on-demand revalidate fires. The
// ETL orchestrator busts this path via /api/revalidate?path=/sitemap.xml after
// each run, refreshing the shard list when the corpus crosses a shard boundary.
export const revalidate = 86400;

export async function GET(): Promise<Response> {
  const entries = await buildSitemapEntries();
  const shards = sitemapChunkCount(entries.length);
  return new Response(renderSitemapIndex(shards, siteBaseUrl()), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
