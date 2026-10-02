/**
 * Root people URL `/{slug}` (#671 — people canonical URL migration).
 *
 * Canonical: renders the profile in place. The pre-#671 behavior (a
 * permanent-redirect alias to `/scholars/{slug}`, #497 §5.3) applied only
 * while the `PROFILE_CANONICAL` rollback flag was unset/"scholars"; both envs
 * cut over to root on 2026-07-14 and the flag has since been removed (#671)
 * — root is now the only mode.
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
import { canonicalProfilePath } from "@/lib/profile-url";
import { buildProfileMetadata } from "@/lib/profile-metadata";
import { ProfileView } from "@/components/profile/profile-view";

// On-demand ISR, matching the department/center pages. #640 made this
// force-dynamic because the header and global not-found read cookies()/headers();
// both have since moved off the server path (header auth is a client island,
// not-found fixed in #2951), and force-dynamic sent `max-age=0`, so CloudFront
// never cached a profile and every view was an origin render plus Aurora
// (2026-10-01 load test). The profile tree must stay free of request-time APIs,
// and its loaders must throw rather than degrade (getMenteesForMentor `strict`).
// Edits bust the entry via lib/edit/revalidation.ts; 6 h covers the nightly ETL.
export const revalidate = 21600;
export const dynamicParams = true;

// Without generateStaticParams a dynamic segment is never registered for ISR
// (absent from prerender-manifest dynamicRoutes), so `revalidate` alone left
// every view an origin render. An empty list prebuilds nothing; each slug is
// rendered on first request and cached.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // This route only owns profile metadata for a plausible, non-reserved slug;
  // otherwise it only redirects or 404s, so skip the profile fetch.
  if (RESERVED_SLUGS.has(slug) || !looksLikeSlug(slug)) {
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
  // Direct hit: `slug` is the current canonical slug — render in place.
  return <ProfileView slug={resolved.slug} />;
}
