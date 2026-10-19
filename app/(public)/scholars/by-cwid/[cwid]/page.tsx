import { notFound, permanentRedirect } from "next/navigation";
import { resolveByCwidOrAlias } from "@/lib/url-resolver";
import { canonicalProfilePath } from "@/lib/profile-url";

/**
 * CWID-keyed entry point for a scholar profile.
 *
 * Resolves the cwid to the scholar's current canonical slug via
 * `resolveByCwidOrAlias` (direct cwid -> cwid_aliases -> not-found) and
 * emits a permanent 301 to the canonical profile URL (`/scholars/{slug}` or
 * the root `/{slug}` form per PROFILE_CANONICAL, #671). Unknown cwids 404.
 *
 * Consumed by the B14 legacy-URL redirect layer in `proxy.ts`:
 * `/display/cwid-{cwid}`, `/individual/cwid-{cwid}`, and
 * `/profile/cwid-{cwid}` from the old VIVO host all 301 here for ANY cwid
 * (#1940), and this page chains a permanent redirect to the current canonical
 * slug or 404s. This page is therefore the only "does this legacy CWID still
 * have a profile" check; slug currency / aliasing stays in
 * `lib/url-resolver.ts`.
 */
export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ cwid: string }>;
}): Promise<never> {
  const { cwid } = await params;
  const resolved = await resolveByCwidOrAlias(cwid);
  if (resolved.type === "redirect") {
    permanentRedirect(canonicalProfilePath(resolved.targetSlug));
  }
  // resolveByCwidOrAlias only ever returns `redirect` or `not-found` --
  // there's no `found` case because cwids are never canonical URL keys.
  notFound();
}
