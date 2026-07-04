/**
 * The shared admin sub-nav across ALL `/edit` console surfaces (#497 PR-3c,
 * `slug-personalization-ui-spec.md` § 3.1; unified onto the self-edit surface in
 * `role-aware-navigation-entry-points-spec.md`). The maroon-underlined tab strip
 * under the black Apollo bar, linking the Profiles roster (`/edit/scholars`), the
 * Profile-URL request queue (`/edit/slug-requests`), the URL registry,
 * Administrators, Method Families, and the Funding matcher
 * (`/edit/find-researchers`). A pending-count pill sits on the "URL requests"
 * tab; the account chip/dropdown anchors the right end (account-dropdown-nav
 * handoff, Workstream A — its `ACCOUNT_CONSOLE_NAV_RESTRUCTURE` flag was
 * retired in #1440).
 *
 * Originally only the superuser list pages rendered this. It now also renders on
 * the `/edit` self-edit surface for a superuser or comms_steward (via
 * `active="self"`), so the full role-gated option set is visible from anywhere in
 * the console — not just after drilling into the roster. A plain scholar's
 * self-edit page keeps its minimal "My Profile" strip and never mounts this.
 *
 * `pendingSlugRequests === null` hides the URL-requests tab entirely — the
 * slug-request feature is flag-gated (`SELF_EDIT_SLUG_REQUEST`), so a surface
 * that doesn't exist isn't advertised.
 */
import Link from "next/link";

import { AccountMenu } from "@/components/site/account-menu";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";

export type AdminSubnavActive =
  | "profiles"
  | "units"
  | "slug-requests"
  | "slugs"
  | "administrators"
  | "methods"
  | "data-quality"
  | "activity"
  | "usage"
  | "cores"
  | "find-researchers"
  /** The viewer's own self-edit surface (`/edit`) — no list tab is active;
   *  profile actions live in the right-end account menu. */
  | "self";

export function AdminSubnav({
  active,
  pendingSlugRequests,
  administratorsTab,
  methodsTab,
  dataQualityTab,
  superuserSurfaces = true,
  profilesTab = false,
  unitsTab = false,
  usageTab = false,
  viewerIsDeveloper = false,
}: {
  active: AdminSubnavActive;
  pendingSlugRequests: number | null;
  /** `null` hides the "Administrators" tab — the feature is flag-gated
   *  (`SELF_EDIT_ADMINISTRATORS_TAB`), mirroring the `pendingSlugRequests`
   *  hide pattern. A number shows the tab (Phase B passes `0` — no badge). */
  administratorsTab?: number | null;
  /** `null`/omitted hides the "Method Families" tab — the comms_steward surface
   *  is flag-gated + role-gated (`isMethodsTabVisible`). A number shows it
   *  (passed `0` — no badge), mirroring `administratorsTab`. */
  methodsTab?: number | null;
  /** `null`/omitted hides the "Data quality" tab — the dashboard is flag- +
   *  role-gated (`isDataQualityTabVisible`; the `/edit/units` page additionally
   *  shows it to a unit Owner/Curator with grants). A number shows it (passed
   *  `0` — no badge), mirroring `methodsTab`. */
  dataQualityTab?: number | null;
  /** Whether to show the superuser list surfaces (URL requests / Slug registry /
   *  Administrators — and Profiles, unless `profilesTab` separately enables it).
   *  Default `true`. A comms_steward who is NOT a superuser passes `false` so
   *  those superuser-only surfaces stay hidden. */
  superuserSurfaces?: boolean;
  /** Show the "Profiles" tab independently of `superuserSurfaces`. A
   *  comms_steward is a global profile editor (comms-steward-profile-editing-
   *  spec.md §4d), so they get Profiles (+ Method Families) without the other
   *  superuser surfaces. A superuser already gets Profiles via `superuserSurfaces`. */
  profilesTab?: boolean;
  /** Show the "Units" tab (the `/edit/units` finder). A comms_steward edits any
   *  existing org unit's content (§3b), and a superuser jumps to any unit too. */
  unitsTab?: boolean;
  /** Show the "Usage" tab (`/edit/usage`, the global usage dashboard) to a
   *  non-superuser unit admin (owner/curator). Superusers already get it via
   *  `superuserSurfaces`; this is the escape hatch so a unit admin who can view
   *  usage (`canViewUsage`) sees the tab too. Default `false`. */
  usageTab?: boolean;
  /** Show the "Funding matcher" tab to a pure development-role viewer who is NOT
   *  a superuser. Superusers already get it via `superuserSurfaces`; this is the
   *  dev-role escape hatch on `/edit/find-researchers` (their only console page).
   *  Default `false`. */
  viewerIsDeveloper?: boolean;
}) {
  return (
    <div className="border-border border-b" data-slot="admin-subnav">
      <div className="mx-auto flex max-w-[var(--max-content)] items-center gap-6 px-6">
        {(superuserSurfaces || profilesTab) && (
          <AdminTab href="/edit/scholars" id="profiles" label="Profiles" active={active === "profiles"} />
        )}
        {unitsTab && (
          <AdminTab href="/edit/units" id="units" label="Org units" active={active === "units"} />
        )}
        {superuserSurfaces && pendingSlugRequests !== null && (
          <AdminTab
            href="/edit/slug-requests"
            id="slug-requests"
            label="URL requests"
            active={active === "slug-requests"}
            count={pendingSlugRequests}
          />
        )}
        {/* Always visible to superusers — the slug namespace (active / historical
            / override / reserved) exists regardless of the slug-request flag. */}
        {superuserSurfaces && (
          <AdminTab
            href="/edit/slugs"
            id="slugs"
            label="URL registry"
            active={active === "slugs"}
          />
        )}
        {superuserSurfaces && administratorsTab !== null && administratorsTab !== undefined && (
          <AdminTab
            href="/edit/administrators"
            id="administrators"
            label="Administrators"
            active={active === "administrators"}
          />
        )}
        {methodsTab !== null && methodsTab !== undefined && (
          <AdminTab
            href="/edit/methods"
            id="methods"
            label="Method families"
            active={active === "methods"}
          />
        )}
        {dataQualityTab !== null && dataQualityTab !== undefined && (
          <AdminTab
            href="/edit/data-quality"
            id="data-quality"
            label="Data quality"
            active={active === "data-quality"}
          />
        )}
        {/* Fleet-wide edit-activity oversight (`/edit/activity`). Superuser-only
            — rides `superuserSurfaces`, so a comms_steward / unit owner (who
            cannot open the page) never sees the tab. No separate flag: the
            superuser gate on the page IS the control. */}
        {superuserSurfaces && (
          <AdminTab
            href="/edit/activity"
            id="activity"
            label="Activity"
            active={active === "activity"}
          />
        )}
        {/* Global usage dashboard (`/edit/usage`). Wider audience than the other
            superuser tabs: a superuser (via `superuserSurfaces`) OR any unit
            admin (via `usageTab`, set when `canViewUsage` passes). Aggregates
            only, so no per-unit scoping. */}
        {(superuserSurfaces || usageTab) && (
          <AdminTab href="/edit/usage" id="usage" label="Usage" active={active === "usage"} />
        )}
        {/* Cores review-queue index (`/edit/core`). Superuser-facing — rides
            `superuserSurfaces` like the other superuser tabs — and gated on the
            same `CORE_PAGES` flag as the public core surfaces, so it stays dark
            in any env where cores aren't live yet (staging-on / prod-off). */}
        {superuserSurfaces && isCorePagesEnabled() && (
          <AdminTab href="/edit/core" id="cores" label="Cores" active={active === "cores"} />
        )}
        {/* GrantRecs reverse-matcher — its only entry point is now this bar.
            Rides `superuserSurfaces` (every superuser console page passes it) so
            superusers see it on every console surface; `viewerIsDeveloper` is the
            escape hatch that also shows it to a pure development-role viewer on
            its own page. Hidden for a comms_steward (neither superuser nor dev). */}
        {(superuserSurfaces || viewerIsDeveloper) && (
          <AdminTab
            href="/edit/find-researchers"
            id="find-researchers"
            label="Funding matcher"
            active={active === "find-researchers"}
          />
        )}
        {/* The account chip/dropdown anchors the right end — profile actions live
            entirely in the menu, which derives its scholar + rows from the
            `/api/auth/session` probe, so no scholar object needs threading
            through every console page that renders this strip. */}
        <AccountMenu context="console" />
      </div>
    </div>
  );
}

function AdminTab({
  href,
  id,
  label,
  active,
  count,
}: {
  href: string;
  id: AdminSubnavActive;
  label: string;
  active: boolean;
  count?: number;
}) {
  const inner = (
    <span className="inline-flex items-center gap-2">
      {label}
      {count !== undefined && count > 0 && (
        <span
          className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold text-white"
          data-testid="admin-subnav-pending-count"
        >
          {count}
        </span>
      )}
    </span>
  );
  if (active) {
    return (
      <span
        className="border-apollo-maroon inline-block border-b-2 py-3 text-sm font-medium"
        aria-current="page"
        data-testid={`admin-tab-${id}`}
      >
        {inner}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-3 text-sm"
      data-testid={`admin-tab-${id}`}
    >
      {inner}
    </Link>
  );
}
