import {
  URLS_PER_SITEMAP,
  buildSitemapEntries,
  parseShardId,
  renderUrlset,
  sitemapChunkCount,
} from "@/lib/sitemap";

/**
 * Child sitemap at `/sitemap/[shard]` — e.g. `/sitemap/0.xml` (#124, B25).
 * Serves the `URLS_PER_SITEMAP`-sized slice of the corpus for shard `id`,
 * referenced from the index at `/sitemap.xml`. The `.xml` suffix is required
 * (see `parseShardId`); other segments 404.
 */

// ISR — matches the index's revalidation window (app/sitemap.xml/route.ts).
export const revalidate = 86400;

// Prerender the current shards at build (and ISR-refresh them), so a crawler
// fetch is served from cache instead of hitting the DB every request. Shards
// that appear later (corpus growth) are generated on demand, then cached.
export async function generateStaticParams(): Promise<Array<{ shard: string }>> {
  const entries = await buildSitemapEntries();
  const shards = sitemapChunkCount(entries.length);
  return Array.from({ length: shards }, (_, id) => ({ shard: `${id}.xml` }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shard: string }> },
): Promise<Response> {
  const { shard } = await params;
  const id = parseShardId(shard);
  if (id === null) {
    return new Response("Not found", { status: 404 });
  }

  const entries = await buildSitemapEntries();
  const start = id * URLS_PER_SITEMAP;
  const slice = entries.slice(start, start + URLS_PER_SITEMAP);

  return new Response(renderUrlset(slice), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
