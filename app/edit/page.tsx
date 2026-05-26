/**
 * `/edit` — the scholar's self-edit surface (#356 Phase 6 C8, UI-SPEC §
 * `/edit` — the self-edit surface).
 *
 * Server Component. Loads the page context with the suppression filter OFF
 * via `loadEditContext`, then hands it to the EditPage shell. An unauthenticated
 * request never reaches this handler — `middleware.ts` matches `/edit*` and
 * redirects to the SAML login endpoint with `?return=…`. The page-level
 * `getSession()` check is defense-in-depth.
 */
import { redirect, notFound } from "next/navigation";

import { EditPage } from "@/components/edit/edit-page";
import { getSession } from "@/lib/auth/session-server";
import { loadEditContext } from "@/lib/api/edit-context";
import { db } from "@/lib/db";

// /edit reads suppression-OFF + writes via /api/edit/*; the page must never
// be cached (CloudFront also marks it CachingDisabled per cloudfront-cache-spec.md).
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit my profile",
  // Prevent crawlers from indexing the SSO-gated surface.
  robots: { index: false, follow: false },
};

export default async function EditSelfPage({
  searchParams,
}: {
  searchParams?: Promise<{ attr?: string }>;
}) {
  const session = await getSession();
  if (!session) {
    // Belt-and-braces: middleware also covers this with a 302 → login.
    redirect("/api/auth/saml/login?return=/edit");
  }
  const ctx = await loadEditContext(session.cwid, db.read);
  if (!ctx) {
    // A signed-in user whose scholar row was hard-archived (deletedAt set)
    // has nothing to edit. This is rare — the ED ETL would have to have
    // deleted them after SSO authenticated them.
    notFound();
  }
  const { attr } = (await searchParams) ?? {};
  return <EditPage ctx={ctx} mode="self" attr={attr} />;
}
