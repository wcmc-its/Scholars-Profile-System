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

import { EditPage, visibleAttrKeys } from "@/components/edit/edit-page";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { loadEditContext } from "@/lib/api/edit-context";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { requireSuperuserGet } from "@/lib/edit/authz";
import {
  checkProxyConflictingRole,
  isGrantedProxy,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";
import {
  listUnitAdminEditorsForScholar,
  resolveEditableUnitViaUnitAdmin,
  type UnitAdminEditorsLookup,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";
import { isSlugRequestEnabled, loadLatestSlugRequest } from "@/lib/edit/slug-request";
import { isManualHighlightsEnabled } from "@/lib/edit/manual-highlights";
import { isCoiGapHintEnabled } from "@/lib/edit/coi-gap-hint";
import { isReciterPendingHintEnabled } from "@/lib/edit/reciter-pending-hint";

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

  // RAW session existence check + SAML redirect (invariant 4): the login gate
  // turns on whether a real human is signed in, never the impersonation overlay.
  const raw = await getSession();
  if (!raw) {
    redirect(`/api/auth/saml/login?return=/edit/scholar/${encodeURIComponent(targetCwid)}`);
  }

  // Authorization identity resolves via the effective seam, mirroring the write
  // path (`lib/edit/request.ts`). While impersonating target T, `session.cwid`
  // is T and `session.isSuperuser` re-derives from T — so /edit/scholar/T is
  // self mode and /edit/scholar/U (U≠T) 403s because effective(T) is not a
  // superuser (#637). Non-impersonating: effective == raw, byte-identical.
  const session = await getEffectiveEditSession();
  if (!session) {
    // Defensive — `raw` is already non-null, so this branch is unreachable.
    redirect(`/api/auth/saml/login?return=/edit/scholar/${encodeURIComponent(targetCwid)}`);
  }

  const isSelf = session.cwid === targetCwid;

  // Scholar-assigned proxy editor (#779 / scholar-proxy-spec.md). A granted,
  // conflict-free proxy reaches EXACTLY their granted scholar's edit surface.
  // Keyed on the RAW identity and only when NOT impersonating (`raw.cwid ===
  // session.cwid`) — a #637 "View as" overlay must never confer the proxy path
  // (IS-1). A proxy is NOT a superuser, so it remains subject to the
  // soft-deleted-404 and #536 hidden-class-404 guards below (IS-9).
  let isProxy = false;
  if (!isSelf && !session.isSuperuser && raw.cwid === session.cwid) {
    if (await isGrantedProxy(raw.cwid, targetCwid, db.read as unknown as ProxyLookup)) {
      const conflict = await checkProxyConflictingRole(
        raw.cwid,
        db.read as unknown as ProxyLookup,
        // Reuse the live verdict already resolved for this (non-impersonating)
        // cwid instead of a second LDAPS round-trip.
        async () => session.isSuperuser,
      );
      isProxy = conflict.ok;
    }
  }

  // Org-unit administrator as profile editor (Amendment 4 / scholar-proxy-unit-
  // admin-amendment.md). An owner/curator of a unit the scholar belongs to
  // reaches the scholar's edit surface. Keyed on the RAW identity and only when
  // NOT impersonating (`raw.cwid === session.cwid`) and not already self/proxy —
  // a #637 "View as" overlay must never confer it (IS-1). A unit admin is NOT a
  // superuser, so it remains subject to the soft-deleted-404 and #536
  // hidden-class-404 guards below. The conferring unit's display name feeds the
  // "via {unit} administrator" banner.
  let isUnitAdmin = false;
  let unitAdminBanner:
    | { unitKind: "department" | "division" | "center"; unitName: string }
    | null = null;
  if (!isSelf && !isProxy && !session.isSuperuser && raw.cwid === session.cwid) {
    const unit = await resolveEditableUnitViaUnitAdmin(
      raw.cwid,
      targetCwid,
      db.read as unknown as UnitScholarLookup,
    );
    if (unit) {
      isUnitAdmin = true;
      // #1104 — the conferring unit can now be a center (behind
      // UNIT_ADMIN_CENTER_PROXY); resolve its display name for the banner just
      // as a department / division name is resolved.
      const named =
        unit.kind === "department"
          ? await db.read.department.findUnique({
              where: { code: unit.code },
              select: { name: true },
            })
          : unit.kind === "center"
            ? await db.read.center.findUnique({
                where: { code: unit.code },
                select: { name: true },
              })
            : await db.read.division.findUnique({
                where: { code: unit.code },
                select: { name: true },
              });
      unitAdminBanner = { unitKind: unit.kind, unitName: named?.name ?? unit.code };
    }
  }

  // A comms_steward is a global profile editor (comms-steward-profile-editing-
  // spec.md §4b) — superuser parity on the profile MINUS slug + admin/unit
  // governance, enforced field-by-field at the write routes. So a steward
  // reaches any scholar's edit surface like a superuser does; the editor renders
  // in the restricted `comms_steward` mode below.
  if (!isSelf && !isProxy && !isUnitAdmin && !session.isCommsSteward) {
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

  // #836 — the manual-Highlights editor and the COI-gap advisory load for the
  // scholar themselves OR a (non-impersonating) superuser. A superuser is
  // unrestricted on the edit surface (operator decision); COI-gap was originally
  // a privacy carve-out but is now superuser-visible too, with a UI nag before any
  // action and the dismiss/restore routes re-authorizing genuine-self-or-superuser.
  // Neither is surfaced to a proxy / unit-admin editor, and the loader populates
  // them only when requested + the flag is on, so they stay dark otherwise.
  //
  // A comms_steward edits Highlights at superuser parity (§3b). COI-gap is the
  // ONE carve-out (#986): a steward must NOT see it. The dismiss/feedback/restore
  // routes deny a steward AT THE ROUTE (comms-steward spec §6/§7: "denied at the
  // route, not just hidden in the UI"), so surfacing the interactive card would
  // make every action 403 — a broken surface. Hence Highlights includes a steward
  // (`selfOrSuperuser`), but COI-gap is gated self-or-genuine-superuser only.
  const selfOrSuperuser = isSelf || session.isSuperuser || session.isCommsSteward;
  const includeHighlights = isManualHighlightsEnabled() && selfOrSuperuser;
  const includeCoiGap = isCoiGapHintEnabled() && (isSelf || session.isSuperuser);
  // ReCiter pending-pubs nudge — superuser parity with the COI-gap hint above:
  // surfaced for the scholar themselves OR a (non-impersonating) superuser viewing
  // the target. The data is a LIVE client read against the ReCiter engine, fetched
  // lazily behind `/api/edit/reciter-pending?cwid=<target>` which re-authorizes the
  // supplied cwid; this flag only gates whether the client loader mounts at all.
  const reciterPendingEnabled =
    isReciterPendingHintEnabled() && (isSelf || session.isSuperuser);
  const ctx = await loadEditContext(targetCwid, db.read, new Date(), undefined, {
    includeHighlights,
    includeCoiGap,
  });
  if (!ctx) {
    // The scholar row does not exist (or is soft-deleted). A 404 keeps the
    // route shape predictable — there is no profile to edit.
    notFound();
  }

  // #536 — a hidden identity class (doctoral student) has no public profile, so
  // only a superuser may reach its edit surface. A non-superuser — including the
  // scholar themselves (isSelf) — 404s, matching the public route's posture.
  if (!session.isSuperuser && !isPubliclyDisplayed(ctx.scholar.roleCategory)) {
    notFound();
  }

  const { attr } = (await searchParams) ?? {};

  // When a superuser views their OWN profile this renders mode='self' — surface
  // the flag-gated request card there too (#497 PR-3), seeded with their latest
  // request, so it matches /edit exactly. The superuser direct-set card is
  // unaffected (it has no flag).
  const slugRequestEnabled = isSelf && isSlugRequestEnabled();
  // Superuser is checked before comms_steward so a viewer who is both gets the
  // full superuser surface; a steward-only viewer gets the restricted
  // `comms_steward` mode (superuser rail minus slug + proxy-editors).
  const mode = isSelf
    ? "self"
    : isProxy
      ? "proxy"
      : isUnitAdmin
        ? "unit-admin"
        : session.isSuperuser
          ? "superuser"
          : "comms_steward";

  // Canonicalize a present-but-invalid `?attr` (T1.13): redirect to the bare
  // route rather than render the default panel behind a stale URL. The valid set
  // depends on `mode` (e.g. the COI-gap advisory stays self-only), so derive it here.
  // The redirect target carries no `?attr`, so the re-load never loops.
  const basePath = `/edit/scholar/${targetCwid}`;
  const validAttrs: readonly string[] = visibleAttrKeys(
    mode,
    slugRequestEnabled,
    // The COI-gap attr is valid when there is High-active work OR settled history
    // to revisit (Reviewed) — mirroring the rail-gating rule in EditPage. A
    // Medium-only group does not surface the item, so it is excluded here too.
    ctx.unmatchedPubmedCoi.length > 0 || ctx.unmatchedPubmedCoiReviewed.length > 0,
    ctx.highlights !== null,
  );
  if (attr !== undefined && !validAttrs.includes(attr)) {
    redirect(basePath);
  }

  // #845 — these three reads only depend on `mode` / `slugRequestEnabled` /
  // `session.cwid` / `targetCwid` (all already resolved) and not on each other.
  // The page is `force-dynamic`, so every `?attr=` tab click re-runs the whole
  // server render — fan them out concurrently rather than awaiting one-by-one.
  // The earlier proxy / unit-admin authorization gates stay sequential by design
  // (each depends on the previous gate's verdict). Each read's comment is below.
  const panelEditable = mode !== "proxy" && mode !== "unit-admin";
  const [latestSlugRequest, proxyEditorRows, unitAdminEditorRows] = await Promise.all([
    // Seed the flag-gated "Profile URL" request card (#497 PR-3) with the
    // scholar's latest request, matching /edit (see `slugRequestEnabled` above).
    slugRequestEnabled ? loadLatestSlugRequest(session.cwid, db.read) : Promise.resolve(null),
    // #779 — the "Profile editors" panel: the scholar (self) or a superuser manages
    // the scholar's designees. Neither a proxy (#779) nor a unit admin (Amendment
    // 4) can manage the list, so the panel is absent in those modes (and excluded
    // from the rail).
    panelEditable
      ? db.read.scholarProxy.findMany({
          where: { scholarCwid: targetCwid },
          select: { proxyCwid: true, grantedBy: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve(null),
    // Amendment 4 P3 — the read-only "Org-unit administrators" group inside the
    // Profile editors panel. Gated to the same modes as the proxy list (self /
    // superuser); a proxy or unit admin never sees the panel, so it stays `null`
    // there. This is a display listing — the write paths re-derive authorization
    // via `resolveEditableUnitViaUnitAdmin`, never from this list.
    panelEditable
      ? listUnitAdminEditorsForScholar(targetCwid, db.read as unknown as UnitAdminEditorsLookup)
      : Promise.resolve(null),
  ]);

  const proxyEditors =
    proxyEditorRows === null
      ? null
      : proxyEditorRows.map((r) => ({
          proxyCwid: r.proxyCwid,
          grantedBy: r.grantedBy,
          grantedAt: r.createdAt,
        }));
  const unitAdminEditors =
    unitAdminEditorRows === null
      ? null
      : unitAdminEditorRows.map((u) => ({
          adminCwid: u.adminCwid,
          conferringUnitKind: u.conferringUnitKind,
          conferringUnitName: u.conferringUnitName,
        }));

  return (
    <EditPage
      ctx={ctx}
      mode={mode}
      attr={attr}
      slugRequestEnabled={slugRequestEnabled}
      latestSlugRequest={latestSlugRequest}
      proxyEditors={proxyEditors}
      unitAdminEditors={unitAdminEditors}
      unitAdminBanner={unitAdminBanner}
      reciterPendingEnabled={reciterPendingEnabled}
    />
  );
}
