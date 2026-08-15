/**
 * `/edit/methods` — the global Method-Family visibility surface for the
 * `comms_steward` role (`comms-steward-methods-visibility-spec.md` §4/§8).
 *
 * A SIBLING global route (parallel to `/edit/administrators`, #728), NOT a
 * per-scholar tab: method families span scholars, so this never touches the
 * per-profile `EditMode` union. The whole surface is dark unless the operator
 * has enabled it AND the viewer holds the role.
 *
 * Guard (§4/§9):
 *   - `COMMS_STEWARD_ENABLED` off          ⇒ `notFound()` (404 — never reveal it)
 *   - no session                           ⇒ SAML login redirect
 *   - not (`isCommsSteward || isSuperuser`) ⇒ `notFound()` (404, NOT 403 — the
 *     surface must be indistinguishable from a missing one for a non-steward)
 *
 * The live `METHODS_LENS_SENSITIVE_GATE` state is read here (server-only flag)
 * and passed to the client so the §2 inert-sensitive warning shows the steward
 * the TRUE public-visibility consequence of the Sensitive tier — a Sensitive
 * family still renders publicly while that gate is off.
 *
 * Authorization is re-checked on every GET, never cached; the route is the scope
 * boundary, not the UI. `force-dynamic` + `noindex`, mirroring the other
 * `/edit/*` pages.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { MethodFamiliesRoster } from "@/components/edit/method-families-roster";
import { buildFamilyRoster } from "@/lib/api/methods-families";
import { isCommsStewardEnabled } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { isMethodsLensSensitiveGateOn } from "@/lib/profile/methods-lens-flags";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Method families — Scholars Profile Console",
  robots: { index: false, follow: false },
};

export default async function MethodFamiliesPage() {
  // (a) master kill switch — the whole surface 404s when off (§9). Checked first
  // so an unauthenticated hit to a dark surface never round-trips through SAML.
  if (!isCommsStewardEnabled()) notFound();

  // Resolve the EFFECTIVE identity (mirrors the sibling console pages
  // `/edit/scholars` + `/edit/administrators`), so a "View as" overlay scopes
  // this surface to the impersonated viewer. Without this the page authorized +
  // rendered its tabs from the REAL superuser, so a superuser viewing as a
  // steward saw superuser tabs that the target can't open
  // (role-aware-navigation-entry-points-spec.md §2a / comms-steward-profile-
  // editing-spec.md). Writes from this surface are still attributed to the real
  // actor in the API routes (R3) — unchanged.
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/methods");
  }

  // (b) comms_steward OR superuser (§3 superset). A non-steward gets 404 (NOT
  // 403) here — the surface must not betray its own existence (§4).
  if (!session.isCommsSteward && !session.isSuperuser) notFound();

  const families = await buildFamilyRoster(db.read);

  // The live sensitivity-gate state (§2): when off, a Sensitive family still
  // renders publicly. Surfaced prominently so a steward is never misled.
  const sensitivityGateOn = isMethodsLensSensitiveGateOn();

  // §4 — the surface folds into the shared `/edit` console via `ConsoleShell`
  // (migrated off a hand-rolled bar + directly-invoked `AdminSubnav` alongside
  // the `loadConsoleTabs` migration, docs/edit-console-ia-spec.md Part B §2 —
  // this file's own per-page administratorsTab/methodsTab/dataQualityTab/
  // profilesTab/unitsTab computation was doing by hand exactly what
  // `ConsoleShell` now derives from `session`; also closes the Apollo v2 audit's
  // B3/B7 finding, docs/audits/apollo-v2-surface-audit-2026-08-14.md — the
  // hand-rolled chrome had already drifted from the shared bar's badge size and
  // was missing `sticky` + the skip-to-content link).
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="methods"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <h1 className="mb-1 text-xl font-semibold">Method families</h1>
      <p className="text-muted-foreground mb-6 max-w-3xl text-sm">
        Control the visibility tier of each method family and review the ones flagged as
        potentially sensitive. The review queue surfaces flagged families first; setting a tier
        takes effect immediately — no rebuild. Nothing here hides a publication; it only changes
        how a method family is shown on public profiles.
      </p>
      <MethodFamiliesRoster families={families} sensitivityGateOn={sensitivityGateOn} />
    </ConsoleShell>
  );
}
