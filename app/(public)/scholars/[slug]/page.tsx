/**
 * Legacy people URL `/scholars/{slug}` (#671 — people canonical URL migration).
 *
 * Canonical (renders the profile) while `PROFILE_CANONICAL !== "root"` — the
 * pre-#671 home of the profile. Once the flag flips to "root" this route
 * becomes a permanent redirector to the canonical root `/{slug}` form. Either
 * way, slug_history 301s and the shared <ProfileView> render are unchanged.
 *
 * Co-pubs sub-pages (`/scholars/{slug}/co-pubs`) stay under this prefix and are
 * unaffected by the canonical flip.
 */
import { notFound, permanentRedirect } from "next/navigation";

import { resolveBySlugOrHistory } from "@/lib/url-resolver";
import { canonicalProfilePath, isRootCanonical } from "@/lib/profile-url";
import { buildProfileMetadata } from "@/lib/profile-metadata";
import { ProfileView } from "@/components/profile/profile-view";

// ISR-cached, on-demand. #640 moved every per-viewer read off the server render
// (auth/owner via <HeaderAuthSlot>/<EditMyProfileButton>, the #866 internal-viewer
// reveal and #891 email are all client islands hitting uncacheable /api/*
// endpoints), so the server response is viewer-independent and safe to cache at
// the edge. In root-canonical mode this route only 301s to /{slug}; otherwise it
// renders the shared <ProfileView>. force-static is load-bearing: Next 15 deopts
// DB-backed routes to dynamic and `revalidate` alone does NOT make this ISR — see
// the root /{slug} route for the full rationale.
export const revalidate = 86400; // 24h — the documented profile ISR TTL
export const dynamicParams = true;
export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // When root is canonical this route only redirects; skip the profile fetch.
  if (isRootCanonical()) return {};
  return buildProfileMetadata(slug);
}

export default async function ScholarsProfileRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const resolved = await resolveBySlugOrHistory(slug);
  if (resolved.type === "not-found") notFound();
  if (resolved.type === "redirect") {
    permanentRedirect(canonicalProfilePath(resolved.targetSlug));
  }
  // Direct hit: `slug` is the current canonical slug.
  if (isRootCanonical()) {
    // This route is no longer canonical — 301 the citation to the root form.
    permanentRedirect(canonicalProfilePath(resolved.slug));
  }
  return <ProfileView slug={resolved.slug} />;
}
