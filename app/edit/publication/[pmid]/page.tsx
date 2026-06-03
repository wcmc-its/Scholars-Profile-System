/**
 * `/edit/publication/[pmid]` — the superuser publication-takedown surface
 * (#356 Phase 7 C7, UI-SPEC § `/edit/publication/[pmid]`).
 *
 * Server Component. Three authorization gates run in order:
 *
 *   1. **No session** → SAML-login redirect with `?return=` carrying the
 *      requested URL so the user lands back here after sign-in.
 *   2. **Non-superuser** → the visible 403 page (UI-SPEC § States row 2);
 *      one `edit_authz_denied` log line lands via `requireSuperuserGet`
 *      (reason='not_superuser_get'). Unlike `/edit/scholar/[cwid]` there is
 *      no self path — only a superuser may take a publication down.
 *   3. Superuser → load the takedown context (suppression-OFF) and render
 *      the takedown page shell.
 *
 * `force-dynamic` + `noindex` mirror `/edit`'s posture (no caching, SSO-gated).
 */
import { notFound, redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { PublicationTakedownPage } from "@/components/edit/publication-takedown-page";
import { loadPublicationTakedownContext } from "@/lib/api/publication-takedown-context";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { requireSuperuserGet } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Manage publication",
  robots: { index: false, follow: false },
};

export default async function EditPublicationPage({
  params,
}: {
  params: Promise<{ pmid: string }>;
}) {
  const { pmid } = await params;

  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/publication/${encodeURIComponent(pmid)}`);
  }

  // GET-time superuser re-check — emits one `edit_authz_denied` line with
  // reason="not_superuser_get" when the actor is not a superuser. Shared
  // helper keeps this and /edit/scholar/[cwid] aligned on the log shape.
  const denial = requireSuperuserGet({
    session,
    path: `/edit/publication/${pmid}`,
    targetId: pmid,
  });
  if (denial !== null) {
    return <ForbiddenEditPage />;
  }

  const ctx = await loadPublicationTakedownContext(pmid, db.read);
  if (!ctx) {
    // The publication row does not exist — there is nothing to take down.
    notFound();
  }

  return <PublicationTakedownPage ctx={ctx} />;
}
