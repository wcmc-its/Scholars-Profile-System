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

import { EditPage, visibleAttrKeys } from "@/components/edit/edit-page";
import { getSession } from "@/lib/auth/session-server";
import { getEffectiveCwid } from "@/lib/auth/effective-identity";
import { isSuperuser } from "@/lib/auth/superuser";
import { loadEditContext } from "@/lib/api/edit-context";
import { db } from "@/lib/db";
import { isSlugRequestEnabled, loadLatestSlugRequest } from "@/lib/edit/slug-request";
import { loadManageableUnits } from "@/lib/edit/manageable-units";

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
  // Resolve identity via the effective seam, mirroring the write path
  // (`lib/edit/request.ts`). When not impersonating this returns `session.cwid`
  // byte-identically; while impersonating target T it returns T, so /edit loads
  // T's context and renders the self-edit surface for them (#637).
  const editCwid = getEffectiveCwid(session);
  const ctx = await loadEditContext(editCwid, db.read);
  if (!ctx) {
    // A signed-in user whose scholar row was hard-archived (deletedAt set)
    // has nothing to edit. This is rare — the ED ETL would have to have
    // deleted them after SSO authenticated them.
    notFound();
  }
  const { attr } = (await searchParams) ?? {};

  // A superuser editing their own profile gets a cross-link to the admin
  // Profiles roster in the editor sub-nav. Fail-closed (no link) on any
  // directory hiccup, like every other superuser gate. Reads the EFFECTIVE
  // identity so the admin link hides while down-scoped to a plain scholar (#637).
  const canBrowseProfiles = await isSuperuser(editCwid).catch(() => false);

  // The "Profile URL" request card (#497 PR-3) is flag-gated. When on, seed it
  // with the scholar's latest request so the card opens in the right state
  // (Pending / Rejected / Just-approved) without a client round-trip.
  const slugRequestEnabled = isSlugRequestEnabled();

  // Canonicalize a present-but-invalid `?attr` (T1.13): redirect to the bare
  // `/edit` rather than silently rendering the default panel behind a stale URL.
  // Absent/valid `attr` falls through; the redirect target carries no `?attr`,
  // so the re-load sees `attr === undefined` and never loops.
  const validAttrs: readonly string[] = visibleAttrKeys("self", slugRequestEnabled);
  if (attr !== undefined && !validAttrs.includes(attr)) {
    redirect("/edit");
  }

  const latestSlugRequest = slugRequestEnabled
    ? await loadLatestSlugRequest(editCwid, db.read)
    : null;

  // Org units this scholar may also curate (#753). One indexed `unit_admin`
  // lookup keyed by cwid; empty for the vast majority, so the Home-panel section
  // self-hides. Flattened (departments → divisions → centers) for the summary.
  const units = await loadManageableUnits(editCwid, db.read);
  const manageableUnits = [...units.departments, ...units.divisions, ...units.centers];

  return (
    <EditPage
      ctx={ctx}
      mode="self"
      attr={attr}
      slugRequestEnabled={slugRequestEnabled}
      latestSlugRequest={latestSlugRequest}
      canBrowseProfiles={canBrowseProfiles}
      manageableUnits={manageableUnits}
    />
  );
}
