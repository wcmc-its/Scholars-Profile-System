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
import { MatchaTab } from "@/components/edit/matcha-tab";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";
import { isNewsQueueEnabled } from "@/lib/edit/news-queue";

export type AdminSubnavActive =
  | "profiles"
  | "units"
  | "slug-requests"
  | "honors-queue"
  | "news-queue"
  | "slugs"
  | "administrators"
  | "methods"
  | "data-quality"
  | "activity"
  | "usage"
  | "cores"
  | "find-researchers"
  | "matcha"
  /** The viewer's own self-edit surface (`/edit`) — no list tab is active;
   *  profile actions live in the right-end account menu. */
  | "self";

export function AdminSubnav({
  active,
  pendingSlugRequests,
  pendingHonors,
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
  /**
   * #1762 — count of honors awaiting approval. `null` hides the tab: the flag is
   * off, or this viewer is neither a superuser nor an `honors_curator`.
   *
   * 🔴 REQUIRED, and deliberately NOT optional-with-a-default, mirroring
   * `pendingSlugRequests`. An optional prop compiles clean at all 12 callers and
   * silently defaults to `null` — so the tab renders on the honors page alone and
   * nowhere else, i.e. only for someone who already knows the URL. That is
   * exactly #1767's bug ("an honors surface nobody could find"), and exactly
   * #1760's rail-order bug: the compiler-enforced maps were right, the
   * unenforced arrays typechecked clean and never rendered. Required is what
   * makes the compiler the test.
   */
  pendingHonors: number | null;
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
        {/* The role-gated tab set now runs to ~13 items and no longer fits the
            bar on a laptop. Scroll the tab strip horizontally instead of letting
            it overflow / shove the account chip off-screen. `min-w-0` lets this
            flex child shrink below its content width so `overflow-x-auto` engages
            (without it the row just pushes past the container). Radix
            popovers/menus inside a tab portal to the body, so they are NOT clipped
            by this scroller. The account chip stays pinned outside it. */}
        <div className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto">
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
        {/* #1762 — honors awaiting approval. Wired here, not only reachable by
            URL: #1767's first bug was an honors surface nobody could find.

            Gated on `pendingHonors !== null` ALONE — deliberately without
            `superuserSurfaces`, unlike the slug tab above. This queue has a
            non-superuser tier (`honors_curator`, the Research Dean's office),
            and `superuserSurfaces` is false for them, so ANDing it would hide the
            tab from the very people the role exists to serve. The caller already
            resolved `(isSuperuser || isHonorsCurator) && isHonorQueueEnabled()`
            to decide between a count and `null`, so the count IS the gate — a
            second one here could only ever disagree with it. The slug tab keeps
            `superuserSurfaces` because it genuinely is superuser-only. */}
        {/* #1762 round 4: NO count badge — the curator asked to drop the pending
            count from the tab. `pendingHonors` still gates visibility (null hides
            the tab), it just no longer renders a pill. */}
        {pendingHonors !== null && (
          <AdminTab
            href="/edit/honors-queue"
            id="honors-queue"
            label="Honors"
            active={active === "honors-queue"}
          />
        )}
        {/* News approval queue — the comms surface that confirms prose name-match
            mentions before they publish. Same server-read-flag pattern as the
            Matcha/Cores tabs below (no prop threads through every console page):
            `NEWS_APPROVAL_QUEUE` gates the flag, and `superuserSurfaces || profilesTab`
            is exactly the audience the page authorizes (superuser OR comms_steward —
            a comms_steward passes `profilesTab`, a superuser `superuserSurfaces`). No
            badge, mirroring the Honors tab. */}
        {(superuserSurfaces || profilesTab) && isNewsQueueEnabled() && (
          <AdminTab
            href="/edit/news-queue"
            id="news-queue"
            label="News"
            active={active === "news-queue"}
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
        {/* CTL sponsor match (`/edit/matcha`) — same audience as the
            Funding matcher above; hidden while SPONSOR_MATCH is off (server-read
            env check here, so no new prop threads through every console page).
            Rendered via the CLIENT `MatchaTab` because it carries a HoverCard —
            see the header of `matcha-tab.tsx` for why that composition must not
            live in this server component. */}
        {(superuserSurfaces || viewerIsDeveloper) && isMatchaEnabled() && (
          <MatchaTab active={active === "matcha"} />
        )}
        </div>
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
  const tab = active ? (
    <span
      className="border-apollo-maroon inline-block border-b-2 py-3 text-sm font-medium"
      aria-current="page"
      data-testid={`admin-tab-${id}`}
    >
      {inner}
    </span>
  ) : (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-3 text-sm"
      data-testid={`admin-tab-${id}`}
    >
      {inner}
    </Link>
  );
  return tab;
}
