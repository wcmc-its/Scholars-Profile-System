/**
 * `/edit/scholar/[cwid]` — the scholar admin surface (#356 Phase 7 C6,
 * UI-SPEC § `/edit/scholar/[cwid]`).
 *
 * Server Component. Three authorization gates run in order:
 *
 *   1. **No session** → SAML-login redirect with `?return=` carrying the
 *      requested URL so the user lands back here after sign-in.
 *   2. **`session.cwid === cwid`** → render exactly `/edit` (mode='self').
 *   3. **`session.isSuperuser`** → render the superuser surface.
 *   4. Otherwise → the visible 403 page (UI-SPEC § States row 2). The
 *      `edit_authz_denied` line lands first via `requireSuperuserGet` so
 *      mid-session deauthorisation (SPEC edge case 15) is logged.
 *
 * The route reads suppression-OFF (via `loadEditContext`), so the GET-time
 * superuser re-check closes the data-exposure window for a user who just
 * lost their `scholars-admins` membership.
 *
 * No caching: `force-dynamic` + `noindex` mirror `/edit`'s posture.
 */
import { notFound, redirect } from "next/navigation";

import { EditPage } from "@/components/edit/edit-page";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { loadEditContext } from "@/lib/api/edit-context";
import { getEditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";
import { isSlugRequestEnabled, loadLatestSlugRequest } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit scholar profile",
  // Prevent crawlers from indexing the SSO-gated surface.
  robots: { index: false, follow: false },
};

export default async function EditScholarPage({
  params,
  searchParams,
}: {
  params: Promise<{ cwid: string }>;
  searchParams?: Promise<{ attr?: string }>;
}) {
  const { cwid: targetCwid } = await params;

  const session = await getEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/scholar/${encodeURIComponent(targetCwid)}`);
  }

  const isSelf = session.cwid === targetCwid;
  if (!isSelf) {
    // GET-time superuser re-check — emits one `edit_authz_denied` line with
    // reason="not_superuser_get" when the actor is not a superuser. The
    // helper guarantees the two routes (this one and /edit/publication/[pmid])
    // don't drift on the denial-log shape.
    const denial = requireSuperuserGet({
      session,
      path: `/edit/scholar/${targetCwid}`,
      targetId: targetCwid,
    });
    if (denial !== null) {
      return <ForbiddenEditPage targetCwid={targetCwid} />;
    }
  }

  const ctx = await loadEditContext(targetCwid, db.read);
  if (!ctx) {
    // The scholar row does not exist (or is soft-deleted). A 404 keeps the
    // route shape predictable — there is no profile to edit.
    notFound();
  }

  const { attr } = (await searchParams) ?? {};

  // When a superuser views their OWN profile this renders mode='self' — surface
  // the flag-gated request card there too (#497 PR-3), seeded with their latest
  // request, so it matches /edit exactly. The superuser direct-set card is
  // unaffected (it has no flag).
  const slugRequestEnabled = isSelf && isSlugRequestEnabled();
  const latestSlugRequest = slugRequestEnabled
    ? await loadLatestSlugRequest(session.cwid, db.read)
    : null;

  return (
    <EditPage
      ctx={ctx}
      mode={isSelf ? "self" : "superuser"}
      attr={attr}
      slugRequestEnabled={slugRequestEnabled}
      latestSlugRequest={latestSlugRequest}
    />
  );
}
