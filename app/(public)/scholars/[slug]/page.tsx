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

// Dynamic render — see ProfileView / #640. CloudFront caches the public
// response by path at the edge.
export const dynamic = "force-dynamic";

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
