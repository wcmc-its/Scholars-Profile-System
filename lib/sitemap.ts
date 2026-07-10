/**
 * Sitemap-index split (#124, B25) — shared model + serialization.
 *
 * The sitemaps protocol caps a single sitemap file at **50,000 URLs / 50 MB
 * uncompressed** (sitemaps.org, honored by Google/Bing). To stay under the cap
 * as the corpus grows, the site serves a sitemap *index* at `/sitemap.xml`
 * (`app/sitemap.xml/route.ts`) that points at child sitemaps at
 * `/sitemap/[id].xml` (`app/sitemap/[shard]/route.ts`), each holding at most
 * `URLS_PER_SITEMAP` URLs.
 *
 * Both routes are plain Route Handlers — *not* the Next.js `sitemap.ts` metadata
 * convention. The metadata convention with `generateSitemaps()` serves children
 * at `/sitemap/[id].xml` but does NOT emit an index at `/sitemap.xml` (which
 * robots.txt and Search Console point at), and in `next dev` it shadows a
 * sibling `/sitemap.xml` handler — so the index would render differently in dev
 * vs prod. Hand-rolling both handlers keeps `/sitemap.xml` the index everywhere
 * and gives one source of truth (`buildSitemapEntries`) for the shard count.
 */
import { prisma } from "@/lib/db";
import { canonicalProfilePath } from "@/lib/profile-url";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import {
  getSupercategoryHubEntries,
  getFamiliesForSupercategory,
} from "@/lib/api/methods";
import { siteBaseUrl } from "@/lib/site-url";

/**
 * Maximum URLs per child sitemap. Half the 50,000-URL protocol cap, which also
 * keeps each file well under the 50 MB byte cap (≈250 bytes/`<url>` → ≈6 MB at
 * 25k entries) and below #124's 40k-URL / 40 MB split trigger. Lowering it only
 * produces more (smaller) shards; it never risks the cap.
 */
export const URLS_PER_SITEMAP = 25_000;

/**
 * Number of child sitemaps required to hold `total` URLs. Always ≥ 1 so the
 * index is well-formed even when the corpus is small or temporarily empty
 * (e.g. a DB-less CI build) — a single, possibly empty, child sitemap.
 */
export function sitemapChunkCount(total: number): number {
  return Math.max(1, Math.ceil(total / URLS_PER_SITEMAP));
}

export interface SitemapEntry {
  url: string;
  lastModified: Date;
  changeFrequency: "weekly" | "monthly";
  priority: number;
}

// Canonical site origin now lives in the zero-dep leaf `@/lib/site-url` (#1514,
// runtime `SITE_URL`-aware). Re-exported so existing `@/lib/sitemap` importers
// (app/sitemap.xml/route.ts, tests) keep resolving it here.
export { siteBaseUrl };

/**
 * Build the full, ordered list of sitemap entries (static + scholars + topics +
 * departments + centers). Order is stable — each query carries an explicit
 * `orderBy` and the sections concatenate in a fixed sequence — so a given URL
 * always lands in the same child shard when sliced by `URLS_PER_SITEMAP`.
 *
 * In build environments without a DB (CI on a fresh checkout) the dynamic
 * queries fail soft and only the static entries are emitted; ISR repopulates
 * the full set on first production hit. Mirrors app/(public)/scholars/[slug].
 */
export async function buildSitemapEntries(): Promise<SitemapEntry[]> {
  const base = siteBaseUrl();

  let scholars: Array<{ slug: string; updatedAt: Date | null }> = [];
  let topics: Array<{ id: string; refreshedAt: Date | null }> = [];
  let departments: Array<{ slug: string; updatedAt: Date | null }> = [];
  let centers: Array<{ slug: string; updatedAt: Date | null }> = [];
  try {
    [scholars, topics, departments, centers] = await Promise.all([
      prisma.scholar.findMany({
        where: { deletedAt: null, status: "active" },
        select: { slug: true, updatedAt: true },
        orderBy: { slug: "asc" },
      }),
      prisma.topic.findMany({
        select: { id: true, refreshedAt: true },
        orderBy: { id: "asc" },
      }),
      prisma.department.findMany({
        select: { slug: true, updatedAt: true },
        orderBy: { slug: "asc" },
      }),
      prisma.center.findMany({
        select: { slug: true, updatedAt: true },
        orderBy: { slug: "asc" },
      }),
    ]);
  } catch (err) {
    console.warn("[sitemap] Skipping dynamic entries (no DB):", err);
  }

  const now = new Date();

  const staticEntries: SitemapEntry[] = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${base}/browse`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];

  const scholarEntries: SitemapEntry[] = scholars.map((s) => ({
    url: `${base}${canonicalProfilePath(s.slug)}`,
    lastModified: s.updatedAt ?? now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  const topicEntries: SitemapEntry[] = topics.map((t) => ({
    url: `${base}/topics/${t.id}`,
    lastModified: t.refreshedAt ?? now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const deptEntries: SitemapEntry[] = departments.map((d) => ({
    url: `${base}/departments/${d.slug}`,
    lastModified: d.updatedAt ?? now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const centerEntries: SitemapEntry[] = centers.map((c) => ({
    url: `${base}/centers/${c.slug}`,
    lastModified: c.updatedAt ?? now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  // Standalone Method pages (`/methods/**`) — only enumerated when the page
  // surface is enabled (so dark pages aren't advertised to crawlers). Both
  // loaders apply the master lens + #800/#801 overlay gate, so suppressed /
  // sensitive families and all-gated supercategories never appear. Fail-soft:
  // the whole block is skipped on any error (e.g. a DB-less CI build), matching
  // the dynamic-section posture above.
  const methodEntries: SitemapEntry[] = [];
  if (isMethodPagesEnabled()) {
    try {
      const supercategories = await getSupercategoryHubEntries();
      for (const sc of supercategories) {
        methodEntries.push({
          url: `${base}/methods/${sc.slug}`,
          lastModified: now,
          changeFrequency: "monthly",
          priority: 0.5,
        });
        const families = await getFamiliesForSupercategory(sc.id);
        for (const fam of families) {
          methodEntries.push({
            url: `${base}/methods/${sc.slug}/${fam.familySlug}`,
            lastModified: now,
            changeFrequency: "monthly",
            priority: 0.5,
          });
        }
      }
    } catch (err) {
      console.warn("[sitemap] Skipping method entries:", err);
    }
  }

  return [
    ...staticEntries,
    ...scholarEntries,
    ...topicEntries,
    ...deptEntries,
    ...centerEntries,
    ...methodEntries,
  ];
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** Serialize entries as a `<urlset>` (one child sitemap). */
export function renderUrlset(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (e) =>
        `<url>\n` +
        `<loc>${xmlEscape(e.url)}</loc>\n` +
        `<lastmod>${e.lastModified.toISOString()}</lastmod>\n` +
        `<changefreq>${e.changeFrequency}</changefreq>\n` +
        `<priority>${e.priority}</priority>\n` +
        `</url>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}${urls ? "\n" : ""}</urlset>\n`
  );
}

/**
 * Serialize the sitemap index referencing `shardCount` child sitemaps at
 * `${base}/sitemap/{id}.xml`. `<lastmod>` is intentionally omitted at the index
 * level (optional in the protocol); per-URL `<lastmod>` lives in the children.
 */
export function renderSitemapIndex(shardCount: number, base: string): string {
  const items = Array.from(
    { length: shardCount },
    (_, id) => `<sitemap><loc>${xmlEscape(`${base}/sitemap/${id}.xml`)}</loc></sitemap>`,
  ).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${items}${items ? "\n" : ""}</sitemapindex>\n`
  );
}

/**
 * Parse a child-sitemap path segment (e.g. `"0.xml"`) into a shard index. The
 * `.xml` suffix is required so only the canonical child URLs resolve; anything
 * else (`/sitemap/0`, `/sitemap/abc`) returns null → 404.
 */
export function parseShardId(segment: string): number | null {
  const match = /^(\d+)\.xml$/.exec(segment);
  return match ? Number(match[1]) : null;
}
