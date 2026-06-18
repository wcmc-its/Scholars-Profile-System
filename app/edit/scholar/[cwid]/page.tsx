/**
 * `/edit/scholar/[cwid]` — the scholar admin surface (#356 Phase 7 C6,
 * UI-SPEC § `/edit/scholar/[cwid]`).
 *
 * Server Component. Authorization runs via the shared five-gate resolver
 * `resolveScholarEditAccess` — self → proxy (#779) → unit-admin (Amendment 4) →
 * comms_steward / superuser, otherwise the visible 403 page (UI-SPEC § States
 * row 2). The `/history` sibling reuses the same resolver so the two never
 * drift. The `edit_authz_denied` line lands first via `requireSuperuserGet` so
 * mid-session deauthorisation (SPEC edge case 15) is logged.
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
import { db } from "@/lib/db";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { resolveScholarEditAccess } from "@/lib/edit/scholar-edit-access";
import {
  listUnitAdminEditorsForScholar,
  type UnitAdminEditorsLookup,
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

  // Authorization — the shared five-gate scholar-editor rule (self / proxy /
  // unit-admin / comms_steward / superuser → else a logged 403), resolved once
  // by `resolveScholarEditAccess` and reused verbatim by the `/history` sibling
  // so the two never drift. The bare route (no `pathSuffix`) drives the login
  // `?return=` and the `edit_authz_denied` log path. The identity, impersonation
  // (#637 / IS-1), proxy (#779), and Amendment-4 unit-admin reasoning all live
  // in the resolver's doc comment.
  const access = await resolveScholarEditAccess(targetCwid);
  if (access.kind === "redirect") {
    redirect(access.to);
  }
  if (access.kind === "forbidden") {
    return <ForbiddenEditPage targetCwid={targetCwid} />;
  }
  const { session, isSelf, isProxy, isUnitAdmin, unit } = access;

  // Resolve the conferring unit's display name for the "via {unit} administrator"
  // banner — present only in unit-admin mode (`unit` is non-null exactly then).
  // #1104 — the unit can now be a center (behind UNIT_ADMIN_CENTER_PROXY),
  // resolved just like a department / division.
  let unitAdminBanner:
    | { unitKind: "department" | "division" | "center"; unitName: string }
    | null = null;
  if (unit) {
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
