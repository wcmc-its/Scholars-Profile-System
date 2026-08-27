/**
 * The Apollo master-detail shell (#160 UI follow-up, `self-edit-launch-spec.md`
 * § Layout). The editor chrome only: a black top bar with a real account menu,
 * a sub-nav / breadcrumb, and a two-region body (the ATTRIBUTES rail + the
 * detail panel). We MIRROR the Apollo Management Console design language (a real
 * WCM tool we can't integrate); the public Scholars site keeps its Cornell-red
 * header — these are deliberately distinct surfaces. #7d1c1c is the intentional
 * editor maroon (`globals.css` `--apollo-maroon`).
 *
 * Vision-round shell work: the top-right is now a real account/exit menu (was
 * inert aria-hidden text — finding 4.4), a self orientation line frames what is
 * editable vs sourced, a skip link + named `<main>` land a11y basics, and the
 * full vertical rail collapses to a `<select>` below `md` so the editor is not
 * buried under nine links on phones (finding 4.5).
 *
 * `hideRail` drops BOTH the rail column and the phone `<select>` for one
 * dedicated attribute — content that wants the whole width (the Cancer
 * Center Members table, with its own filter bar + disease grid) rather than
 * sharing it with a 9-item nav the page can't use anyway. In its place, a
 * "← Back" link (`backHref`) is the only way back to the rest of the
 * attribute set — this is a one-attribute escape hatch, not a rail
 * replacement, so it's deliberately just a link, not a breadcrumb.
 */
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronLeftIcon } from "lucide-react";

import { AttributeRail, type RailItem } from "@/components/edit/attribute-rail";
import { RailSheet } from "@/components/edit/rail-sheet";
import { ProxyBanner } from "@/components/edit/proxy-banner";
import { SuperuserBanner } from "@/components/edit/superuser-banner";
import { UnitAdminBanner } from "@/components/edit/unit-admin-banner";
import { ConsoleTopBar } from "@/components/edit/console-top-bar";

/** A navigable "{label} / {current}" breadcrumb — shared by the "Profiles"
 *  crumb (superuser-on-a-profile, unit-admin-with-a-grant) and the "Org
 *  units" crumb (superuser-on-a-unit-with-a-grant), so the two structural
 *  breadcrumbs render identically rather than drifting apart. */
function BreadcrumbCrumb({
  href,
  label,
  current,
  testId,
}: {
  href: string;
  label: string;
  current: string;
  testId: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 py-3 text-sm">
      <Link
        href={href}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        data-testid={testId}
      >
        <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
        {label}
      </Link>
      <span className="text-muted-foreground" aria-hidden>
        /
      </span>
      <span className="font-medium" aria-current="page">
        {current}
      </span>
    </nav>
  );
}

/** A flat, non-navigable "{current}" breadcrumb — the fallback shape for a
 *  unit editor whose viewer doesn't hold a units-tab grant, a proxy editor
 *  (no roster to return to at all), and a unit admin whose grant doesn't
 *  admit `profilesNavVisible`. */
function FlatBreadcrumb({ current, testId }: { current: string; testId?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 py-3 text-sm">
      <span className="font-medium" aria-current="page" data-testid={testId}>
        {current}
      </span>
    </nav>
  );
}

export type EditShellProps = {
  mode: "self" | "superuser" | "proxy" | "unit-admin";
  /** The entity display name (scholar preferred name, or a unit name). Kept as
   *  `scholarName` for call-site stability — it is the top-bar + banner label. */
  scholarName: string;
  /** Attribute rail items + the active key + the base path for the links. */
  railItems: ReadonlyArray<RailItem>;
  activeAttr: string;
  basePath: string;
  /** Optional per-group descriptions for the attribute rail, keyed by group label
   *  (forwarded to `AttributeRail`). Omit ⇒ header-only groups (the default for
   *  the unit / sibling-division rails). */
  railGroupMeta?: Record<string, { description?: string }>;
  /** "Preview Profile" target (the public profile by slug). */
  previewHref?: string;
  /** "View change history" target — the scholar's `/edit/scholar/[cwid]/history`
   *  audit page (#955). Internal, so it opens in the same tab. Shown for every
   *  edit mode (history visibility == edit access). Omit ⇒ no link. */
  historyHref?: string;
  /** "View reports" target — a center's Reports console (`/edit/reports`).
   *  Internal, same tab. Center editor only; omit ⇒ no link. Replaces the old
   *  rail-mounted `CenterReportsRailLink` (Reports IA redesign, 2026-08-14). */
  reportsHref?: string;
  /**
   * The signed-in (actor) scholar's identity. UNUSED by `ConsoleTopBar` as of
   * the dwd2001 nav fix — the top bar now mounts the self-fetching
   * `AccountMenu context="console"` directly (same as `AdminSubnav`), which
   * derives the scholar + display name from the `/api/auth/session` probe
   * instead of a threaded prop. Kept on the type only because one caller
   * (`edit-page.tsx`) still passes it; cleaning up that call site is outside
   * this ticket's scope.
   */
  account?: { slug: string; preferredName: string } | null;
  /** Self mode only: the viewer has the right to edit ≥1 profile that isn't
   *  their own (`session.isSuperuser`) — adds the "All profiles" cross-link.
   *  Superseded by `consoleNav` when that is supplied. No longer read in
   *  superuser mode (see `isProfileEntity`) — "Profiles" still has nowhere
   *  useful to go FROM a unit page (it names scholars, not units), but a unit
   *  page now gets its OWN structural crumb back to its own roster — see
   *  `orgUnitsNavVisible` below, which replaced the permanently-flat label
   *  this comment used to describe (dwd2001 bug #7). */
  canBrowseProfiles?: boolean;
  /** Superuser mode only: true when `scholarName` names an actual scholar
   *  profile (the default — every caller before cores-as-org-units P3 was
   *  scholar-shaped) rather than a unit. The "Profiles / {name}" breadcrumb
   *  is navigable only when this is true; set false for a unit editor
   *  (department/division/center/core), where the crumb becomes "Org units /
   *  {name}" instead (see `orgUnitsNavVisible`) — "Profiles" specifically
   *  only ever makes sense as a way back from an individual profile, never
   *  from a unit's own editor. */
  isProfileEntity?: boolean;
  /** Unit editor pages only (`isProfileEntity=false`): whether the viewer
   *  satisfies the units-tab predicate (`TAB_PREDICATES.units` —
   *  superuser, comms_steward, or a `manageableUnitCount>0` grant on ANY
   *  unit, `lib/edit/console-tabs.server.ts`), gating a navigable
   *  "Org units / {name}" breadcrumb (→ `/edit/units`) in place of the flat
   *  unit-name label a unit editor rendered before (dwd2001 bug #7 — a
   *  detail page with no way back except the browser's own Back button).
   *  Callers compute this server-side via `loadConsoleTabs` and pass a plain
   *  boolean; default `false` keeps the flat label for any caller that
   *  hasn't computed it (and for the rare viewer the predicate genuinely
   *  fails for, e.g. a role that reaches a unit page without a real grant). */
  orgUnitsNavVisible?: boolean;
  /** Unit-admin mode only: whether the viewer (the org-unit administrator
   *  editing this scholar on a unit's behalf) satisfies the profiles-tab
   *  predicate (`TAB_PREDICATES.profiles` — true whenever
   *  `manageableUnitCount>0`, which a unit admin always has). Gates the same
   *  navigable "Profiles / {name}" crumb superuser mode always gets — a unit
   *  admin has a real roster to return to (their own units' scholars), so
   *  they get the same structural crumb, not the permanent dead end proxy
   *  mode has (dwd2001 bug #7). Default `false` keeps the flat label. */
  profilesNavVisible?: boolean;
  /** Self mode only: a pre-built console tab strip (the shared `AdminSubnav`)
   *  rendered IN PLACE OF the minimal "My Profile / All profiles" strip. The
   *  `/edit` page supplies it for a superuser or comms_steward so the full
   *  role-gated option set shows on the self-edit surface, not just after
   *  drilling into the roster (role-aware-navigation-entry-points-spec.md).
   *  Omitted for a plain scholar — the minimal strip renders instead. The node
   *  carries its own bottom border + container, replacing the whole sub-nav block. */
  consoleNav?: React.ReactNode;
  /** Optional block rendered inside the rail column, below the attribute rail
   *  (e.g. a department's sibling-divisions list). Omitted ⇒ no visible change
   *  for the existing /edit/scholar callers. */
  subRail?: React.ReactNode;
  /** Drops the rail column (desktop) and the `<select>` swap (phone) entirely,
   *  giving the detail panel the full width — a "← Back" link (`backHref`)
   *  takes its place. For one attribute that needs the room, not a general
   *  layout switch; default false leaves every existing caller unchanged. */
  hideRail?: boolean;
  /** Where `hideRail`'s "← Back" link goes — normally `basePath` (the same
   *  unit, default attribute, rail restored). No-op when `hideRail` is false. */
  backHref?: string;
  /** Unit-admin mode only (Amendment 4): the unit through which the viewer
   *  administers this scholar, naming the "via {unit} administrator" banner. */
  unitAdmin?: { unitKind: "department" | "division" | "center"; unitName: string };
  /**
   * `cv_generator` role (#2482): the superuser banner reads "viewing … this
   * role is read-only" instead of "editing … as an administrator" — true on
   * every panel this role reaches, including the one exception below, since
   * downloading a CV doesn't change the profile either. Default false leaves
   * every existing caller unchanged.
   */
  readOnly?: boolean;
  /**
   * Whether the panel content is native `inert` (unfocusable/unclickable,
   * still fully visible) — the actual write-prevention mechanism. Defaults to
   * `readOnly`. Pass `false` while `readOnly` is `true` for the ONE cv_generator
   * exception (the "cv" attr's "Download CV" button, which never writes
   * anything and is the role's named purpose) so that one panel stays
   * interactive while the banner still tells the truth about the role.
   */
  contentInert?: boolean;
  children: React.ReactNode;
};

export function EditShell({
  mode,
  scholarName,
  railItems,
  activeAttr,
  basePath,
  railGroupMeta,
  previewHref,
  historyHref,
  reportsHref,
  account: _account,
  canBrowseProfiles = false,
  isProfileEntity = true,
  orgUnitsNavVisible = false,
  profilesNavVisible = false,
  consoleNav,
  subRail,
  hideRail = false,
  backHref,
  unitAdmin,
  readOnly = false,
  contentInert = readOnly,
  children,
}: EditShellProps) {
  const isSuperuser = mode === "superuser";
  const isProxy = mode === "proxy";
  const isUnitAdmin = mode === "unit-admin";
  return (
    <div className="bg-apollo-page min-h-screen" data-slot="edit-shell" data-mode={mode}>
      {/* Skip link — first focusable element, jumps past the rail to the editor. */}
      <a
        href="#edit-detail"
        className="bg-apollo-maroon text-apollo-maroon-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to editor
      </a>

      {/* Top bar (black) — the shared Apollo chrome with a real account/exit menu
          (self-fetching `AccountMenu context="console"`; see `_account` above). */}
      <ConsoleTopBar />

      {/* Sub-nav — maroon underline on the active tab. A superuser editing a
          scholar gets a "Profiles / <name>" breadcrumb back to the roster; a
          unit editor gets an "Org units / <name>" breadcrumb back to its own
          roster when the viewer's units-tab grant admits them
          (`orgUnitsNavVisible`); a unit admin editing a scholar gets the same
          "Profiles / <name>" crumb superuser mode does when their
          profiles-tab grant admits them (`profilesNavVisible`) — a real
          proxy editor never gets a navigable crumb, since a proxy grant names
          no roster at all. A superuser on their own /edit gets an "All
          profiles" link across — or, when `consoleNav` is supplied (superuser
          / comms_steward self-edit), the full shared admin tab strip in its
          place. */}
      {mode === "self" && consoleNav ? (
        consoleNav
      ) : (
      <div className="border-border border-b">
        <div className="mx-auto flex max-w-[var(--max-content)] items-center gap-2 px-6">
          {isSuperuser && isProfileEntity ? (
            <BreadcrumbCrumb
              href="/edit/scholars"
              label="Profiles"
              current={scholarName}
              testId="edit-subnav-profiles"
            />
          ) : isSuperuser ? (
            // A unit editor (department/division/center/core) — "Profiles"
            // still has nowhere useful to go from here, but the unit itself
            // has a real roster to go back to (`/edit/units`) whenever the
            // viewer's own units-tab grant admits them; when it doesn't (a
            // role that somehow reaches a unit page with no real grant),
            // fall back to the same flat, non-navigable label as proxy mode.
            orgUnitsNavVisible ? (
              <BreadcrumbCrumb
                href="/edit/units"
                label="Org units"
                current={scholarName}
                testId="edit-subnav-units"
              />
            ) : (
              <FlatBreadcrumb current={scholarName} />
            )
          ) : isUnitAdmin && profilesNavVisible ? (
            // A unit admin edits a scholar on behalf of a unit they actually
            // manage — the same roster ("Profiles") a superuser returns to,
            // gated on their own profiles-tab grant rather than assumed.
            <BreadcrumbCrumb
              href="/edit/scholars"
              label="Profiles"
              current={scholarName}
              testId="edit-subnav-profiles"
            />
          ) : isProxy || isUnitAdmin ? (
            // A proxy grant names no roster at all, and a unit admin whose
            // grant doesn't admit `profilesNavVisible` falls back the same
            // way — a flat label naming the scholar being edited, not a
            // navigable breadcrumb.
            <FlatBreadcrumb
              current={scholarName}
              testId={isUnitAdmin ? "edit-subnav-unit-admin" : "edit-subnav-proxy"}
            />
          ) : (
            <div className="flex items-center gap-6">
              <span
                className="border-apollo-maroon inline-block border-b-2 py-3 text-sm font-medium"
                aria-current="page"
              >
                My Profile
              </span>
              {canBrowseProfiles && (
                <Link
                  href="/edit/scholars"
                  className="text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-3 text-sm"
                  data-testid="edit-subnav-profiles"
                >
                  All profiles
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Body — rail + detail. The rail column is desktop-only; on phones a
          compact <select> at the top of the detail column replaces it.
          `hideRail` drops that first track altogether (both the desktop rail
          and the phone <select>) so the detail panel is the only column. */}
      <div
        className={`mx-auto grid max-w-[var(--max-content)] grid-cols-1 gap-6 px-6 py-8 ${
          hideRail ? "" : "md:grid-cols-[auto_1fr]"
        }`}
      >
        {!hideRail && (
          <div className="hidden w-64 flex-col gap-3 md:flex">
            <AttributeRail
              items={railItems}
              active={activeAttr}
              basePath={basePath}
              groupMeta={railGroupMeta}
            />
            {subRail}
          </div>
        )}

        <main id="edit-detail" tabIndex={-1} aria-labelledby="panel-heading" className="min-w-0 scroll-mt-4">
          {hideRail ? (
            <>
              {backHref && (
                <Link
                  href={backHref}
                  className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1 text-sm"
                  data-testid="edit-rail-back"
                >
                  <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
                  Back
                </Link>
              )}
              {/* hideRail drops the rail COLUMN (the attribute switcher), not
                  subRail's own cross-nav (sibling divisions / a center's Reports
                  link) — it still needs somewhere to live, so it renders here
                  instead of silently disappearing with the rest of the rail. */}
              {subRail && <div className="mb-4">{subRail}</div>}
            </>
          ) : (
            <RailSheet
              items={railItems}
              active={activeAttr}
              basePath={basePath}
              subRail={subRail}
            />
          )}

          {/* Secondary links row (mockup parity, slate text — order matches the
              `1b` mockup: reports, then preview). "View change history"
              (internal audit page, #955), then, for a center, "View reports"
              (internal, Reports IA redesign 2026-08-14 — replaces the old
              rail-mounted link so it survives the roster/Members page, which
              hides the rail), then "Preview Profile" (the public profile,
              external ↗). Shown alongside the account menu's "View my
              profile". */}
          {(historyHref || reportsHref || previewHref) && (
            <div className="mb-4 flex items-center justify-end gap-4">
              {historyHref && (
                <Link
                  href={historyHref}
                  className="text-apollo-slate inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                  data-testid="edit-history-link"
                >
                  View change history
                </Link>
              )}
              {reportsHref && (
                <Link
                  href={reportsHref}
                  className="text-apollo-slate inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                  data-testid="edit-reports-link"
                >
                  View reports
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
              {previewHref && (
                <Link
                  href={previewHref}
                  className="text-apollo-slate inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Preview Profile
                  <ArrowUpRight className="size-4" aria-hidden />
                </Link>
              )}
            </div>
          )}

          {isSuperuser && <SuperuserBanner targetLabel={scholarName} readOnly={readOnly} />}
          {isProxy && <ProxyBanner targetLabel={scholarName} />}
          {isUnitAdmin && unitAdmin && (
            <UnitAdminBanner
              targetLabel={scholarName}
              unitKind={unitAdmin.unitKind}
              unitName={unitAdmin.unitName}
            />
          )}

          {/* `cv_generator` (#2482): native `inert` makes every control below
              unfocusable/unclickable while staying fully visible — "see
              everything, act on nothing" without threading a read-only variant
              through every card's own mode prop. `contentInert` (not `readOnly`
              — see its doc comment) is what the caller flips off for the one
              CV-export exception. */}
          <div className="apollo-card" inert={contentInert || undefined}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
