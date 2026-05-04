import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // CRITICAL (Phase 5 D-20): do NOT add "/_next/" — Googlebot fetches
      // /_next/static/* for JS/CSS to render pages. Blocking it tanks SEO.
      disallow: ["/api/", "/admin/"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
