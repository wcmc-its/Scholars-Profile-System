import { notFound, permanentRedirect } from "next/navigation";
import { resolveByCwidOrAlias } from "@/lib/url-resolver";

/**
 * CWID-keyed entry point for a scholar profile.
 *
 * Resolves the cwid to the scholar's current canonical slug via
 * `resolveByCwidOrAlias` (direct cwid -> cwid_aliases -> not-found) and
 * emits a permanent 301 to `/scholars/{slug}`. Unknown cwids return 404.
 *
 * Consumed by the B14 legacy-URL redirect layer in `middleware.ts`:
 * `/display/cwid-{cwid}`, `/individual/cwid-{cwid}`, and
 * `/profile/cwid-{cwid}` from the old VIVO host all 301 here, and this
 * page chains a second 301 to the current canonical slug. The chained
 * redirect keeps the legacy-URL JSON map small (cwids only -- no slug
 * snapshot to drift) and centralizes slug currency / aliasing in
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
    permanentRedirect(`/scholars/${resolved.targetSlug}`);
  }
  // resolveByCwidOrAlias only ever returns `redirect` or `not-found` --
  // there's no `found` case because cwids are never canonical URL keys.
  notFound();
}
