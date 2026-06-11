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
import { ProxyLanding } from "@/components/edit/proxy-landing";
import { getSession } from "@/lib/auth/session-server";
import { getEffectiveCwid } from "@/lib/auth/effective-identity";
import { isSuperuser } from "@/lib/auth/superuser";
import { loadEditContext } from "@/lib/api/edit-context";
import { db } from "@/lib/db";
import { scholarsServedByProxy, type ProxyListLookup } from "@/lib/edit/proxy-authz";
import {
  listUnitAdminEditorsForScholar,
  type UnitAdminEditorsLookup,
} from "@/lib/edit/unit-scholar-authz";
import { isCoiGapHintEnabled } from "@/lib/edit/coi-gap-hint";
import { isManualHighlightsEnabled } from "@/lib/edit/manual-highlights";
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

  // Genuine-self gate for the publication-derived COI-gap candidates
  // (`SELF_EDIT_COI_GAP_HINT`). These are surfaced ONLY when the viewer is the
  // real scholar — never a superuser impersonating them via "View as" (#637).
  // When impersonating, `getEffectiveCwid` returns the target T while the real
  // signed-in CWID is the superuser, so `editCwid !== session.cwid` ⇒ NOT
  // genuine self ⇒ candidates suppressed. `loadEditContext` only loads them when
  // `includeCoiGap` is true, so a false here means they are never even read.
  const genuineSelf = editCwid === session.cwid;
  const includeCoiGap = isCoiGapHintEnabled() && genuineSelf;
  // #836 — on THIS (self) surface the manual-Highlights editor loads only for a
  // genuine self viewer with the flag on — never under a "View as" overlay. A
  // superuser curating another scholar's Highlights does so on the superuser
  // surface (`/edit/scholar/[cwid]`), which loads it for self OR superuser; this
  // `/edit` route is only ever the scholar themselves (or an impersonation we
  // deliberately exclude here).
  const includeHighlights = isManualHighlightsEnabled() && genuineSelf;
  const ctx = await loadEditContext(editCwid, db.read, new Date(), undefined, {
    includeCoiGap,
    includeHighlights,
  });
  if (!ctx) {
    // A signed-in user with no Scholar row may still be a scholar-assigned proxy
    // editor (#779) — pure administrative staff (Beth Chunn) editing on a
    // scholar's behalf. Route them to whom they serve: one grant → straight to
    // that scholar; several → a chooser (D5 department-admin fan-out). Keyed on
    // the effective cwid (their own identity — a proxy never impersonates). A
    // non-proxy (incl. a hard-archived scholar) still 404s.
    const served = await scholarsServedByProxy(editCwid, db.read as unknown as ProxyListLookup);
    if (served.length === 1) {
      redirect(`/edit/scholar/${encodeURIComponent(served[0])}`);
    }
    if (served.length > 1) {
      const scholars = await db.read.scholar.findMany({
        where: { cwid: { in: served }, deletedAt: null },
        select: { cwid: true, preferredName: true },
        orderBy: { preferredName: "asc" },
      });
      if (scholars.length === 1) {
        redirect(`/edit/scholar/${encodeURIComponent(scholars[0].cwid)}`);
      }
      if (scholars.length > 1) {
        return <ProxyLanding scholars={scholars} />;
      }
    }
    notFound();
  }
  const { attr } = (await searchParams) ?? {};

  // The "Profile URL" request card (#497 PR-3) is flag-gated. When on, seed it
  // with the scholar's latest request so the card opens in the right state
  // (Pending / Rejected / Just-approved) without a client round-trip. Sync (env)
  // so it's read before the parallel fan-out below, which it gates.
  const slugRequestEnabled = isSlugRequestEnabled();

  // Canonicalize a present-but-invalid `?attr` (T1.13): redirect to the bare
  // `/edit` rather than silently rendering the default panel behind a stale URL.
  // Absent/valid `attr` falls through; the redirect target carries no `?attr`,
  // so the re-load sees `attr === undefined` and never loops.
  const validAttrs: readonly string[] = visibleAttrKeys(
    "self",
    slugRequestEnabled,
    ctx.unmatchedPubmedCoi.length > 0,
    ctx.highlights !== null,
  );
  if (attr !== undefined && !validAttrs.includes(attr)) {
    redirect("/edit");
  }

  // #845 — these reads are all keyed solely on `editCwid` (and the sync
  // `slugRequestEnabled` env flag); none depends on the others or on `ctx`. The
  // page is `force-dynamic`, so every `?attr=` tab click re-runs the whole
  // server render — fan them out concurrently so the tab switch waits on one
  // round-trip latency, not the sum. Comments stay on each read below.
  const [
    // A superuser editing their own profile gets a cross-link to the admin
    // Profiles roster in the editor sub-nav. Fail-closed (no link) on any
    // directory hiccup, like every other superuser gate. Reads the EFFECTIVE
    // identity so the admin link hides while down-scoped to a plain scholar (#637).
    canBrowseProfiles,
    // The "Profile URL" request card (#497 PR-3) is flag-gated. When on, seed it
    // with the scholar's latest request so the card opens in the right state.
    latestSlugRequest,
    // Org units this scholar may also curate (#753). One indexed `unit_admin`
    // lookup keyed by cwid; empty for the vast majority, so the Home-panel section
    // self-hides. Flattened (departments → divisions → centers) for the summary.
    units,
    // #779 — the scholar manages their own proxy editors. Keyed on the EFFECTIVE
    // editing identity (their own profile); the grant/revoke route blocks while
    // impersonating, so the panel actions are inert under a "View as" overlay.
    proxyEditorRows,
    // Amendment 4 P3 — the read-only "Org-unit administrators" group: who can edit
    // this scholar's profile because they administer a unit the scholar belongs to.
    // Keyed on the effective editing identity (their own profile); a display
    // listing only — never an authorization decision.
    unitAdminEditorRows,
  ] = await Promise.all([
    isSuperuser(editCwid).catch(() => false),
    slugRequestEnabled ? loadLatestSlugRequest(editCwid, db.read) : Promise.resolve(null),
    loadManageableUnits(editCwid, db.read),
    db.read.scholarProxy.findMany({
      where: { scholarCwid: editCwid },
      select: { proxyCwid: true, grantedBy: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    listUnitAdminEditorsForScholar(editCwid, db.read as unknown as UnitAdminEditorsLookup),
  ]);

  const manageableUnits = [...units.departments, ...units.divisions, ...units.centers];
  const proxyEditors = proxyEditorRows.map((r) => ({
    proxyCwid: r.proxyCwid,
    grantedBy: r.grantedBy,
    grantedAt: r.createdAt,
  }));
  const unitAdminEditors = unitAdminEditorRows.map((u) => ({
    adminCwid: u.adminCwid,
    conferringUnitKind: u.conferringUnitKind,
    conferringUnitName: u.conferringUnitName,
  }));

  return (
    <EditPage
      ctx={ctx}
      mode="self"
      attr={attr}
      slugRequestEnabled={slugRequestEnabled}
      latestSlugRequest={latestSlugRequest}
      canBrowseProfiles={canBrowseProfiles}
      manageableUnits={manageableUnits}
      proxyEditors={proxyEditors}
      unitAdminEditors={unitAdminEditors}
    />
  );
}
