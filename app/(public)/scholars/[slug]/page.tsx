/**
 * Legacy people URL `/scholars/{slug}` (#671 — people canonical URL migration).
 *
 * Redirect-only: the canonical profile lives at the root `/{slug}` (#671
 * cutover, live in both envs since 2026-07-14; the `PROFILE_CANONICAL`
 * rollback flag has since been removed). Every direct hit and every
 * slug_history redirect lands on `canonicalProfilePath`, which is always the
 * root form.
 *
 * Co-pubs sub-pages (`/scholars/{slug}/co-pubs`) stay under this prefix and are
 * unaffected — they are not part of the canonical-URL migration.
 */
import { notFound, permanentRedirect } from "next/navigation";

import { resolveBySlugOrHistory } from "@/lib/url-resolver";
import { canonicalProfilePath } from "@/lib/profile-url";

// This route never renders a profile — see the file doc comment above — but
// still does a DB lookup (slug / slug_history) per request, so it stays
// force-dynamic rather than getting statically optimized as a fixed redirect.
// Not edge-cached: verified against prod, repeat requests return
// `x-cache: Miss from cloudfront`. See docs/cloudfront-cache-spec.md
// §"Profile pages are not edge-cached".
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  // This route only ever redirects or 404s; it never owns profile metadata.
  return {};
}

export default async function ScholarsProfileRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const resolved = await resolveBySlugOrHistory(slug);
  if (resolved.type === "not-found") notFound();
  const targetSlug = resolved.type === "redirect" ? resolved.targetSlug : resolved.slug;
  permanentRedirect(canonicalProfilePath(targetSlug));
}
