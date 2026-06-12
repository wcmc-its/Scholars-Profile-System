/**
 * Root people URL `/{slug}` (#671 — people canonical URL migration).
 *
 * Canonical (renders the profile in place) when `PROFILE_CANONICAL === "root"`.
 * Otherwise (the default) this is a permanent-redirect alias to the legacy
 * canonical `/scholars/{slug}` form — the pre-#671 behavior (#497 §5.3).
 *
 * Lives inside the `(public)` route group so it inherits the site chrome
 * (header / footer / PublicationModalProvider). Next resolves explicit
 * `(public)/*` segments (about, browse, centers, departments, scholars, search,
 * topics) and the other top-level routes (api, edit, og, sitemap, …) before
 * this catch-all, so only *unknown* single segments reach here; the
 * RESERVED_SLUGS / looksLikeSlug guards are belt-and-suspenders behind that
 * precedence and keep route words and garbage out of the DB.
 *
 * Resolution (RESERVED → looksLikeSlug → resolveBySlugOrHistory) is shared with
 * the `/scholars/[slug]` route — the single source of slug + slug_history truth.
 */
import { notFound, permanentRedirect } from "next/navigation";

import { looksLikeSlug, RESERVED_SLUGS } from "@/lib/slug";
import { resolveBySlugOrHistory } from "@/lib/url-resolver";
import { canonicalProfilePath, isRootCanonical } from "@/lib/profile-url";
import { buildProfileMetadata } from "@/lib/profile-metadata";
import { ProfileView } from "@/components/profile/profile-view";

// ISR-cached, on-demand. #640 deliberately moved every per-viewer read off the
// server render — auth/owner checks (<HeaderAuthSlot>, <EditMyProfileButton>),
// the #866 internal-viewer reveal and #891 email are all client islands that hit
// uncacheable /api/* endpoints — so this server render is identical for every
// viewer and safe to cache at the edge. (The prior force-dynamic + "static/ISR is
// untenable" note predated that migration; #641 reached for force-dynamic to stop
// the DYNAMIC_SERVER_USAGE 500s the client-island move had already fixed.)
// revalidate=86400 emits a cacheable response (CloudFront serves the public HTML
// by path); dynamicParams generates any slug on demand (no generateStaticParams,
// no build-time prerender, no build-time DB access).
export const revalidate = 86400; // 24h — the documented profile ISR TTL
export const dynamicParams = true;
// Load-bearing: Next 15 otherwise deopts this DB-backed route to dynamic (ƒ) and
// `revalidate` alone does NOT make it ISR. `force-static` asserts the render is
// viewer-independent (every per-viewer read is a client island — #640), so Next
// generates each slug ON DEMAND (no generateStaticParams ⇒ no build-time DB) into
// the ISR cache and CloudFront serves it by path. Bonus: it hard-fails the build
// if anyone later adds a server-side cookies()/headers() read, guarding against a
// per-viewer value leaking into the shared edge cache.
export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // This route owns the profile metadata only when root is canonical; otherwise
  // it only redirects or 404s, so skip the profile fetch.
  if (!isRootCanonical() || RESERVED_SLUGS.has(slug) || !looksLikeSlug(slug)) {
    return {};
  }
  return buildProfileMetadata(slug);
}

export default async function RootProfileRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // 1. A reserved route word is never a scholar slug.
  if (RESERVED_SLUGS.has(slug)) notFound();
  // 2. Cheap structural reject before any DB work.
  if (!looksLikeSlug(slug)) notFound();
  // 3. Resolve against live slugs + slug_history.
  const resolved = await resolveBySlugOrHistory(slug);
  if (resolved.type === "not-found") notFound();
  if (resolved.type === "redirect") {
    permanentRedirect(canonicalProfilePath(resolved.targetSlug));
  }
  // Direct hit: `slug` is the current canonical slug.
  if (!isRootCanonical()) {
    // Root is an alias for now — 301 to the canonical /scholars form.
    permanentRedirect(canonicalProfilePath(resolved.slug));
  }
  return <ProfileView slug={resolved.slug} />;
}
