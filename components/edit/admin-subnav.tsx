/**
 * The shared admin sub-nav across ALL `/edit` console surfaces (#497 PR-3c,
 * `slug-personalization-ui-spec.md` § 3.1; unified onto the self-edit surface in
 * `role-aware-navigation-entry-points-spec.md`). The maroon-underlined tab strip
 * under the black Apollo bar, linking the Profiles roster (`/edit/scholars`), the
 * Profile-URL request queue (`/edit/slug-requests`), the URL registry,
 * Administrators, Method Families, and the Funding matcher
 * (`/edit/find-researchers`). A pending-count pill sits on the "URL requests"
 * tab; "My Profile" anchors the right end.
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
import { ChevronLeftIcon } from "lucide-react";

import { AccountMenu } from "@/components/site/account-menu";
import { isAccountConsoleNavRestructureEnabled } from "@/lib/auth/account-console-nav";

export type AdminSubnavActive =
  | "profiles"
  | "units"
  | "slug-requests"
  | "slugs"
  | "administrators"
  | "methods"
  | "data-quality"
  | "find-researchers"
  /** The viewer's own self-edit surface (`/edit`), shown as the active right-end
   *  tab when a superuser / comms_steward is on their own profile. */
  | "self";

export function AdminSubnav({
  active,
  pendingSlugRequests,
  administratorsTab,
  methodsTab,
  dataQualityTab,
  findResearchersTab,
  selfEditHref,
  superuserSurfaces = true,
  profilesTab = false,
  unitsTab = false,
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
  /** `null`/omitted hides the "Funding matcher" tab (GrantRecs reverse-matcher,
   *  `/edit/find-researchers`). A number shows it (passed `0` — no badge),
   *  mirroring `methodsTab`. Gated on `isSuperuser || isDeveloper` by the caller,
   *  so it shows for both audiences independently of `superuserSurfaces`. */
  findResearchersTab?: number | null;
  /** Link back to the viewer's own self-edit surface (`/edit`), right-aligned.
   *  `null`/omitted when the viewer has no profile of their own (a staff
   *  superuser), so the link never lands on a 404. Ignored when `active="self"`
   *  — the viewer is already there, so "My Profile" renders as the active tab. */
  selfEditHref?: string | null;
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
}) {
  // When the unified account-dropdown flag is on, the account chip/dropdown
  // replaces the right-end "My Profile" tab — profile actions move entirely into
  // the menu (account-dropdown-nav handoff, Workstream A). The menu derives its
  // scholar + rows from the `/api/auth/session` probe, so no scholar object needs
  // threading through every console page that renders this strip.
  const accountNavEnabled = isAccountConsoleNavRestructureEnabled();
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
        {/* GrantRecs reverse-matcher. Shown to superusers AND development-role
            members (caller gates on `isSuperuser || isDeveloper`), so it does
            NOT ride `superuserSurfaces` — its only entry point is now this bar. */}
        {findResearchersTab !== null && findResearchersTab !== undefined && (
          <AdminTab
            href="/edit/find-researchers"
            id="find-researchers"
            label={accountNavEnabled ? "Funding matcher" : "Find researchers"}
            active={active === "find-researchers"}
          />
        )}
        {accountNavEnabled ? (
          <AccountMenu context="console" />
        ) : active === "self" ? (
          <span
            className="border-apollo-maroon ml-auto inline-block border-b-2 py-3 text-sm font-medium"
            aria-current="page"
            data-testid="admin-subnav-self-edit"
          >
            My Profile
          </span>
        ) : selfEditHref ? (
          <Link
            href={selfEditHref}
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 py-3 text-sm"
            data-testid="admin-subnav-self-edit"
          >
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            My profile
          </Link>
        ) : null}
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
