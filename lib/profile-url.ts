/**
 * People profile URL shape (#671 — first-class object URL scheme, people).
 *
 * The canonical public profile URL is the root `/{slug}` form. The migration
 * off the legacy `/scholars/{slug}` was gated by a `PROFILE_CANONICAL` env
 * flag so the app and the (separately, manually deployed) EdgeStack behaviors
 * could be sequenced, with instant rollback if the edge misbehaved. Both envs
 * cut over on 2026-07-14 and the post-cutover soak is long closed, so the
 * flag has been removed (#671) — `/{slug}` is now the only canonical form.
 *
 * Two helpers, kept separate for the audiences that were split while the flag
 * existed (both are pure now, safe anywhere including client components):
 *
 *   profilePath(slug)          Every on-page profile <Link>/href.
 *
 *   canonicalProfilePath(slug) The authoritative canonical location:
 *                              rel=canonical, OG url, JSON-LD url, sitemap
 *                              loc, and the target of every redirect to a
 *                              profile.
 */

/**
 * The internal link target for a profile: root `/{slug}`.
 */
export function profilePath(slug: string): string {
  return `/${slug}`;
}

/**
 * The authoritative canonical profile path for `slug`. Use for rel=canonical,
 * OpenGraph/JSON-LD urls, the sitemap, and every redirect *to* a profile.
 */
export function canonicalProfilePath(slug: string): string {
  return `/${slug}`;
}
