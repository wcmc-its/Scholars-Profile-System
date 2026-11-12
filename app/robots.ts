import type { MetadataRoute } from "next";
import { siteBaseUrl } from "@/lib/site-url";

// Render at request time so `siteBaseUrl()` reads the per-env runtime `SITE_URL`
// (#1514). Without this, Next statically generates robots.txt at BUILD — where
// `SITE_URL` is unset — baking the prod-origin fallback into every environment
// (staging's robots.txt advertised the prod sitemap). Trivial render, no DB.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = siteBaseUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // CRITICAL (Phase 5 D-20): do NOT add "/_next/" — Googlebot fetches
      // /_next/static/* for JS/CSS to render pages. Blocking it tanks SEO.
      // /search: facet combinations are unbounded, uncacheable URLs, each an
      // OpenSearch query. Crawlers walking them took prod down 2026-11-12.
      // Profiles reach crawlers via the sitemap, not search results.
      disallow: ["/api/", "/admin/", "/search"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
