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

import { RESERVED_SLUGS } from "@/lib/slug";

// Slug shape: alphanumeric start and end, hyphens only interior. No dots, no
// slashes, no whitespace. Anchored — prevents prefix-match attacks. Matches the
// `/scholars/[slug]`, `/departments/[slug]`, `/centers/[slug]`, `/methods/[slug]`
// dynamic segments.
const SLUG_RE_SOURCE = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";

// Topic ids are underscore-delimited slugs (`Topic.id` VarChar(128), e.g.
// "cancer_genomics"), unlike the hyphen convention above — so `/topics/[slug]`
// needs its own source that also permits `_` interior. Still anchored,
// alphanumeric start/end, no dots/slashes/whitespace. Without this the ETL's
// per-topic revalidation POSTs are all rejected 400 by the route (the base-URL
// skip in etl/revalidate masked it until #1473 re-enabled the calls).
const TOPIC_SLUG_RE_SOURCE = "[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?";

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
  new RegExp(`^/topics/${TOPIC_SLUG_RE_SOURCE}$`),
  new RegExp(`^/departments/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/departments/${SLUG_RE_SOURCE}/divisions/${SLUG_RE_SOURCE}$`),
  // Center retire / curation revalidates `/centers/{slug}` (#540 Phase 5).
  new RegExp(`^/centers/${SLUG_RE_SOURCE}$`),
  // #1117 — a program leader/description edit revalidates its dedicated page
  // `/centers/{slug}/programs/{code}` (the code segment is slug-shaped, e.g. `CB`).
  new RegExp(`^/centers/${SLUG_RE_SOURCE}/programs/${SLUG_RE_SOURCE}$`),
  // Standalone cross-scholar Method pages: supercategory `/methods/{slug}` and
  // family `/methods/{slug}/{slug}`. The ETL revalidates these on a tools refresh.
  new RegExp(`^/methods/${SLUG_RE_SOURCE}$`),
  new RegExp(`^/methods/${SLUG_RE_SOURCE}/${SLUG_RE_SOURCE}$`),
];

// #671 — root people-profile form `/{slug}` (PROFILE_CANONICAL = "root").
// A single slug-shaped segment (no `.`/`/`) that is NOT a reserved route word,
// so `/edit`, `/api`, `/search`, `/about`, … stay off-list — mirrors the gate
// the root `(public)/[slug]` route applies.
const ROOT_PROFILE_RE = new RegExp(`^/(${SLUG_RE_SOURCE})$`);

/** Whether `path` may be revalidated — an exact match or a recognized pattern. */
export function isAllowedRevalidatePath(path: string): boolean {
  if (ALLOWED_EXACT.has(path)) return true;
  if (ALLOWED_PATTERNS.some((re) => re.test(path))) return true;
  // #671 — root people profile `/{slug}`, reserved words excluded.
  const rootMatch = ROOT_PROFILE_RE.exec(path);
  return rootMatch !== null && !RESERVED_SLUGS.has(rootMatch[1]);
}
