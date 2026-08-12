import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import type { EditSession } from "@/lib/auth/superuser";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";

/**
 * The role-gated `AdminSubnav` props that are derivable from the session + env
 * flags ALONE, computed ONCE here instead of re-derived — and already diverged —
 * on every console page (`docs/2026-07-20-console-shell-migration-plan.md`).
 *
 * The divergence this closes: `superuserSurfaces` was left default-`true` on the
 * superuser-only pages, which is harmless there but leaked the whole superuser
 * strip to a NON-superuser on a shared page — e.g. an `honors_curator` reaching
 * `/edit/honors-queue` (a page that admits them) saw URL registry, Administrators,
 * Activity, Usage… Deriving `superuserSurfaces` from `isSuperuser` fixes that.
 *
 * What is NOT here — it stays a per-page input:
 *  - `active` — which tab is current.
 *  - `pendingSlugRequests` / `pendingHonors` — DB counts (a read per request).
 *  - the unit-admin escape hatches: `usageTab`, and the EXTRA `unitsTab` /
 *    `dataQualityTab` visibility a unit Owner/Curator earns on the pages they can
 *    reach. Those need a grant/scope read the `EditSession` does not carry, so a
 *    page that admits unit admins ORs its own signal on top of this base (e.g.
 *    `unitsTab: base.unitsTab || viewerAdminsAUnit`).
 */
export type ConsoleTabProps = {
  superuserSurfaces: boolean;
  profilesTab: boolean;
  unitsTab: boolean;
  administratorsTab: number | null;
  methodsTab: number | null;
  dataQualityTab: number | null;
  viewerIsDeveloper: boolean;
};

export function deriveConsoleTabs(session: EditSession): ConsoleTabProps {
  return {
    // The superuser list surfaces (URL requests / registry / Administrators /
    // Activity / Cores, and Profiles unless `profilesTab` also enables it).
    superuserSurfaces: session.isSuperuser,
    // A comms_steward is a global profile editor; a superuser already gets
    // Profiles via `superuserSurfaces`.
    profilesTab: session.isCommsSteward,
    // Org units: a superuser or a comms_steward edits any unit's content. A unit
    // Owner/Curator also gets it on the pages they can reach — that page ORs its
    // own unit-admin signal onto this base.
    unitsTab: session.isSuperuser || session.isCommsSteward,
    administratorsTab: session.isSuperuser && isAdministratorsTabEnabled() ? 0 : null,
    methodsTab: isMethodsTabVisible(session) ? 0 : null,
    dataQualityTab: isDataQualityTabVisible(session) ? 0 : null,
    viewerIsDeveloper: session.isDeveloper === true,
  };
}
