/**
 * `/{slug}/jsonld` — the scholar's Schema.org Person JSON-LD as a standalone,
 * browser-viewable document (served with `application/ld+json`).
 *
 * Same structured data the profile page embeds in its
 * <script type="application/ld+json"> tag, via the shared `buildProfileJsonLd`
 * mapping (lib/api/profile.ts) — one source of truth, so page and endpoint
 * can't diverge. This is the URL a `rel="alternate"` head link (option 2) would
 * point at, and what linked-data consumers can fetch directly.
 *
 * Guards mirror the profile page (RESERVED → looksLikeSlug → load → public
 * gate); anything else 404s. ponytail: resolves the *current* slug only — old
 * slugs from slug_history 404 rather than 301; add history resolution if a
 * consumer needs durable URLs.
 */
import { looksLikeSlug, RESERVED_SLUGS } from "@/lib/slug";
import { getScholarFullProfileBySlug, buildProfileJsonLd } from "@/lib/api/profile";
import { isPubliclyDisplayed } from "@/lib/eligibility";

// Reads the DB; never prerender. CloudFront caches by path at the edge.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  if (RESERVED_SLUGS.has(slug) || !looksLikeSlug(slug)) {
    return new Response("Not found", { status: 404 });
  }

  const profile = await getScholarFullProfileBySlug(slug);
  if (!profile || !isPubliclyDisplayed(profile.roleCategory)) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(JSON.stringify(buildProfileJsonLd(profile), null, 2), {
    headers: {
      "content-type": "application/ld+json; charset=utf-8",
      "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
