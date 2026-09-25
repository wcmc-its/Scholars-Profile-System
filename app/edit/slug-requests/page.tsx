/**
 * `/edit/slug-requests` — the old address of the superuser Profile-URL
 * approval queue (#497 PR-3c). The queue now lives at the top of Profile URLs
 * (`/edit/slugs`, design canvas "Profile URLs", 2026-09-25), beside the
 * registry it writes into; this route keeps old links and the console's
 * "URL requests" entry working by redirecting there.
 *
 * Still flag-gated behind `SELF_EDIT_SLUG_REQUEST` (off ⇒ 404, mirroring the
 * endpoints), and still sends a signed-out visitor to SAML login first.
 * Authorization is `/edit/slugs`' own superuser re-check. `force-dynamic` +
 * `noindex`, like the other `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Profile URLs — Scholars Console",
  robots: { index: false, follow: false },
};

export default async function SlugRequestsPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/slug-requests");
  }
  // The queue surface doesn't exist until ops enable the feature.
  if (!isSlugRequestEnabled()) {
    notFound();
  }
  redirect("/edit/slugs");
}
