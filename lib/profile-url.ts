/**
 * People profile URL shape (#671 — first-class object URL scheme, people).
 *
 * The canonical public profile URL is migrating from `/scholars/{slug}` to the
 * shorter root `/{slug}`. The flip is gated by `PROFILE_CANONICAL` so the app
 * and the (separately, manually deployed) EdgeStack behaviors can be sequenced,
 * with instant rollback if the edge misbehaves:
 *
 *   PROFILE_CANONICAL = "scholars" (default) -> canonical stays /scholars/{slug}
 *   PROFILE_CANONICAL = "root"               -> canonical becomes /{slug}
 *
 * Two helpers, deliberately split by audience:
 *
 *   profilePath(slug)          PURE, no env read. Always the end-state root form
 *                              `/{slug}`. Safe in client components. Used for
 *                              every on-page profile <Link>/href. Under the
 *                              flag-off window these links 301 once via the
 *                              root-alias route — invisible, pre-launch only.
 *
 *   canonicalProfilePath(slug) SERVER-only (reads PROFILE_CANONICAL). The
 *                              authoritative canonical location: rel=canonical,
 *                              OG url, JSON-LD url, sitemap loc, and the target
 *                              of every redirect to a profile. Do NOT import
 *                              this into a client component.
 *
 * When the flag is "root" the two converge on `/{slug}`; the flag and this
 * module are removed after the post-cutover soak (the redirector + SlugHistory
 * stay forever).
 */

const SCHOLARS_PREFIX = "/scholars";

/**
 * The end-state internal link target for a profile: root `/{slug}`.
 * Pure — no environment read — so it is safe in client components.
 */
export function profilePath(slug: string): string {
  return `/${slug}`;
}

/**
 * True when the root `/{slug}` form is the canonical profile URL. Server-only:
 * reads `PROFILE_CANONICAL`, which is not exposed to the browser bundle.
 */
export function isRootCanonical(): boolean {
  return process.env.PROFILE_CANONICAL === "root";
}

/**
 * The authoritative canonical profile path for `slug`, honoring
 * `PROFILE_CANONICAL`. Use for rel=canonical, OpenGraph/JSON-LD urls, the
 * sitemap, and every redirect *to* a profile. Server-only.
 */
export function canonicalProfilePath(slug: string): string {
  return isRootCanonical() ? `/${slug}` : `${SCHOLARS_PREFIX}/${slug}`;
}
