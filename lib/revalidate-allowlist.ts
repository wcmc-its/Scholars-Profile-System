/**
 * Shared revalidation path allow-list (#356, `self-edit-spec.md` § Write-path
 * behavior).
 *
 * Two callers revalidate pages: the `/api/revalidate` webhook (ETL completion,
 * over HTTP) and the self-edit write path (`lib/edit/revalidation.ts`,
 * in-process). The write path calls `revalidatePath()` directly, bypassing the
 * HTTP handler — so it bypasses that handler's allow-list check too. Both
 * therefore validate every path against this one constant, so an off-list path
 * from a write-path bug is caught exactly as the HTTP handler catches it.
 */

// Slug shape: alphanumeric start and end, hyphens only interior. No dots, no
// slashes, no whitespace. Anchored — prevents prefix-match attacks. Matches the
// `/scholars/[slug]` and `/topics/[slug]` dynamic segments.
const SLUG_RE_SOURCE = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";

/** Exact paths eligible for revalidation. */
export const ALLOWED_EXACT: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/browse",
  "/sitemap.xml",
]);

/** Dynamic-path patterns eligible for revalidation. */
export const ALLOWED_PATTERNS: readonly RegExp[] = [
  new RegExp(`^/scholars/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/topics/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/departments/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/departments/${SLUG_RE_SOURCE}/divisions/${SLUG_RE_SOURCE}$`),
  // Center retire / curation revalidates `/centers/{slug}` (#540 Phase 5).
  new RegExp(`^/centers/${SLUG_RE_SOURCE}$`),
];

/** Whether `path` may be revalidated — an exact match or a recognized pattern. */
export function isAllowedRevalidatePath(path: string): boolean {
  if (ALLOWED_EXACT.has(path)) return true;
  return ALLOWED_PATTERNS.some((re) => re.test(path));
}
