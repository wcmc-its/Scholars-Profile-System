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
 * Page header (Meyer Cancer Center mockup, 2026-09-30): ONE block inside the
 * content container, above the rail + detail body — a small muted breadcrumb,
 * the page `<h1>` (a unit's name, the scholar's identity block, or "Your
 * profile") with the "View reports" / "Preview profile" actions on the right,
 * and a meta line: a slate-tint role pill ("Editing as administrator" …) then
 * "Changes are logged to your account · Change history". It replaces the old
 * bordered breadcrumb row, the separate actions row, the hideRail "‹ Back"
 * row and the full-width Superuser/Proxy/UnitAdmin banners.
 *
 * `hideRail` drops BOTH the rail column and the phone `<select>` for one
 * dedicated attribute — content that wants the whole width (the Cancer
 * Center Members table, with its own filter bar + disease grid) rather than
 * sharing it with a 9-item nav the page can't use anyway. The way back to the
 * rest of the attribute set is then a third breadcrumb crumb naming the
 * entity (`backHref`).
 */
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronLeftIcon, Shield } from "lucide-react";

import { AttributeRail, type RailItem } from "@/components/edit/attribute-rail";
import { RailSheet } from "@/components/edit/rail-sheet";
import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { Button } from "@/components/ui/button";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

/** A unit editor's kind — the breadcrumb's second crumb + its `/edit/units?kind=` filter. */
export type EditShellUnitKind = "department" | "division" | "center" | "core";

const UNIT_KIND_PLURAL: Record<EditShellUnitKind, string> = {
  department: "Departments",
  division: "Divisions",
  center: "Centers",
  core: "Cores",
};

/** One breadcrumb segment: a link when `href` is set, plain muted text
 *  otherwise. `truncate` + `min-w-0` so a long unit name ellipsizes on a phone
 *  instead of pushing the page sideways. */
type Crumb = { label: string; href?: string; testId?: string };

function Breadcrumb({ crumbs }: { crumbs: ReadonlyArray<Crumb> }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[13px]"
      data-slot="edit-breadcrumb"
    >
      {crumbs.map((c, i) => (
        <span key={`${i}-${c.label}`} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {c.href ? (
            <Link
              href={c.href}
              className="hover:text-foreground inline-flex min-w-0 items-center gap-1"
              data-testid={c.testId}
            >
              {i === 0 && <ChevronLeftIcon className="size-3.5 shrink-0" aria-hidden="true" />}
              <span className="truncate">{c.label}</span>
            </Link>
          ) : (
            <span className="truncate" data-testid={c.testId}>
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export type EditShellProps = {
  mode: "self" | "superuser" | "proxy" | "unit-admin";
  /** The entity display name (scholar preferred name, or a unit name). Kept as
   *  `scholarName` for call-site stability — the header `<h1>` (unit editors) and
   *  the avatar's initials source. */
  scholarName: string;
  /** Attribute rail items + the active key + the base path for the links. */
  railItems: ReadonlyArray<RailItem>;
  activeAttr: string;
  basePath: string;
  /** Optional per-group descriptions for the attribute rail, keyed by group label
   *  (forwarded to `AttributeRail`). Omit ⇒ header-only groups (the default for
   *  the unit / sibling-division rails). */
  railGroupMeta?: Record<string, { description?: string }>;
  /** "Preview profile" target (the public profile by slug). */
  previewHref?: string;
  /** "Change history" target — the scholar's `/edit/scholar/[cwid]/history`
   *  audit page (#955). Internal, so it opens in the same tab. Shown for every
   *  edit mode (history visibility == edit access). Omit ⇒ no link. */
  historyHref?: string;
  /** Edit-for-others only (superuser / proxy / unit-admin — never `self`, where
   *  the editor already knows who they are): the identity header above the
   *  notice — 44px headshot (WCM directory, initials fallback), the published name (`formatPublishedName`:
   *  "{scholarName}, {postnominal}", or bare for an enrolled doctoral student),
   *  and "{title} · {institution}" (design round 3, 2026-09-21). Empty parts are
   *  omitted. Ignored in self mode even when supplied. */
  identity?: { cwid: string; name: string; title?: string | null; institution?: string | null };
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
  /** Unit editor pages only (`isProfileEntity=false`): the unit's kind — the
   *  breadcrumb's "{Kind plural}" crumb, linking to `/edit/units?kind={kind}`
   *  when `orgUnitsNavVisible`. Omit ⇒ the "Org units" crumb alone. */
  unitKind?: EditShellUnitKind;
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
   *  giving the detail panel the full width — a third breadcrumb crumb naming
   *  the entity (`backHref`) is the way back. For one attribute that needs the
   *  room, not a general layout switch; default false leaves every existing
   *  caller unchanged. */
  hideRail?: boolean;
  /** Where `hideRail`'s entity-name crumb (`data-testid="edit-rail-back"`)
   *  goes — normally `basePath` (the same unit, default attribute, rail
   *  restored). No-op when `hideRail` is false. */
  backHref?: string;
  /** Unit-admin mode only (Amendment 4): the unit through which the viewer
   *  administers this scholar, naming the "Editing as {unit} administrator" pill. */
  unitAdmin?: { unitKind: "department" | "division" | "center" | "institution"; unitName: string };
  /**
   * `cv_generator` role (#2482): the header's role pill reads "View only" (and
   * drops "Changes are logged…") instead of "Editing as administrator" — true on
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
   * interactive while the pill still tells the truth about the role.
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
  identity,
  account: _account,
  canBrowseProfiles = false,
  isProfileEntity = true,
  orgUnitsNavVisible = false,
  unitKind,
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
  const isSelf = mode === "self";
  const isSuperuser = mode === "superuser";
  const isUnitAdmin = mode === "unit-admin";
  const isUnitEditor = isSuperuser && !isProfileEntity;
  const showIdentity = identity != null && !isSelf && !isUnitEditor;
  const identitySubline = [identity?.title, identity?.institution].filter(Boolean).join(" · ");

  // Breadcrumb. A unit editor: "Org units / {Kind plural}" (links only when
  // the viewer's units-tab grant admits them — `orgUnitsNavVisible`). A
  // scholar edited by someone else: "‹ Profiles", navigable under the same
  // conditions the old "Profiles / {name}" crumb was (a superuser on a
  // profile; a unit admin whose profiles-tab grant admits them); otherwise
  // there is no roster to return to (a proxy grant names none) and the line
  // is omitted. Self mode keeps its tab strip / `consoleNav` instead.
  const crumbs: Crumb[] = [];
  if (isUnitEditor) {
    crumbs.push({
      label: "Org units",
      href: orgUnitsNavVisible ? "/edit/units" : undefined,
      testId: orgUnitsNavVisible ? "edit-subnav-units" : undefined,
    });
    if (unitKind) {
      crumbs.push({
        label: UNIT_KIND_PLURAL[unitKind],
        href: orgUnitsNavVisible ? `/edit/units?kind=${unitKind}` : undefined,
        testId: "edit-subnav-unit-kind",
      });
    }
  } else if ((isSuperuser && isProfileEntity) || (isUnitAdmin && profilesNavVisible)) {
    crumbs.push({ label: "Profiles", href: "/edit/profiles", testId: "edit-subnav-profiles" });
  }
  // `hideRail`'s way back to the rest of the attribute set — the entity itself.
  if (hideRail && backHref) {
    crumbs.push({ label: scholarName, href: backHref, testId: "edit-rail-back" });
  }

  // Role pill + meta line (never in self mode — the editor knows who they are).
  const pillText = isSelf
    ? null
    : readOnly
      ? "View only"
      : mode === "proxy"
        ? "Editing as proxy"
        : isUnitAdmin
          ? `Editing as ${unitAdmin?.unitName ?? "unit"} administrator`
          : "Editing as administrator";
  const metaItems: React.ReactNode[] = [];
  if (!isSelf && !readOnly) {
    metaItems.push(<span key="logged">Changes are logged to your account</span>);
  }
  if (historyHref) {
    metaItems.push(
      <Link
        key="history"
        href={historyHref}
        className="text-apollo-slate hover:underline"
        data-testid="edit-history-link"
      >
        Change history
      </Link>,
    );
  }

  const title = showIdentity ? (
    <div className="flex min-w-0 items-center gap-3" data-testid="edit-identity-header">
      <HeadshotAvatar
        cwid={identity.cwid}
        preferredName={scholarName}
        size="md"
        className="border-apollo-border-strong size-11 shrink-0 border"
      />
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-[600] tracking-[-0.01em] [overflow-wrap:anywhere]">
          {identity.name}
        </h1>
        {identitySubline && (
          <p className="text-muted-foreground mt-0.5 text-[13px]">{identitySubline}</p>
        )}
      </div>
    </div>
  ) : (
    <h1 className="text-[26px] leading-tight font-[600] tracking-[-0.01em] [overflow-wrap:anywhere]">
      {isSelf ? "Your profile" : scholarName}
    </h1>
  );

  return (
    <div className="bg-apollo-page min-h-screen" data-slot="edit-shell" data-mode={mode}>
      {/* Skip link — first focusable element, jumps past the rail to the editor. */}
      <a
        href="#edit-detail"
        className="bg-apollo-maroon text-apollo-maroon-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to editor
      </a>

      {/* Top bar (black) — the shared Apollo chrome with a real account/exit
          menu. `variant="console"` so the brand is NOT an <h1>: the page header
          below owns the page's one <h1>. */}
      <ConsoleTopBar variant="console" showAccountMenu>
        {isSelf ? consoleNav : null}
      </ConsoleTopBar>

      {/* Self mode's minimal tab strip ("My Profile" / "All profiles") —
          navigation, not a breadcrumb, so it stays as it was. Superseded by
          `consoleNav` (rendered in the top bar) when supplied. */}
      {isSelf && !consoleNav && (
        <div className="border-border border-b">
          <div className="mx-auto flex max-w-[var(--max-content)] items-center gap-6 px-6">
            <span
              className="border-apollo-maroon inline-block border-b-2 py-3 text-sm font-medium"
              aria-current="page"
            >
              My Profile
            </span>
            {canBrowseProfiles && (
              <Link
                href="/edit/profiles"
                className="text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-3 text-sm"
                data-testid="edit-subnav-profiles"
              >
                All profiles
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Page header — breadcrumb, title row (h1 left, actions right; the
          actions drop below the title on a phone), meta line. */}
      <div
        className="mx-auto flex max-w-[var(--max-content)] flex-col gap-2.5 px-4 pt-5 sm:px-6"
        data-slot="edit-page-header"
      >
        {crumbs.length > 0 && <Breadcrumb crumbs={crumbs} />}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1.5">
            {title}
            {(pillText || metaItems.length > 0) && (
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                {pillText && (
                  <span
                    className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-notice-text inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-2 text-[12px] font-medium"
                    data-slot="edit-role-pill"
                  >
                    <Shield className="size-3.5 shrink-0" aria-hidden />
                    {pillText}
                  </span>
                )}
                {metaItems.map((item, idx) => (
                  <span key={idx} className="flex items-center gap-x-2">
                    {idx > 0 && <span aria-hidden>·</span>}
                    {item}
                  </span>
                ))}
              </div>
            )}
            {isUnitAdmin && (
              <p className="text-muted-foreground text-[13px]" data-slot="edit-unit-admin-note">
                You can edit the overview and hide misattributed publications; name, title, and
                contact details come from WCM systems, and the profile URL is set by a Scholars
                administrator.
              </p>
            )}
          </div>
          {(reportsHref || previewHref) && (
            <div className="flex shrink-0 items-center gap-2">
              {reportsHref && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={reportsHref} data-testid="edit-reports-link">
                    View reports
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </Button>
              )}
              {previewHref && (
                <Button asChild variant="outline" size="sm">
                  <Link href={previewHref} target="_blank" rel="noreferrer">
                    Preview profile
                    <ArrowUpRight className="size-4" aria-hidden />
                  </Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Body — rail + detail. The rail column is desktop-only; on phones a
          compact <select> at the top of the detail column replaces it.
          `hideRail` drops that first track altogether (both the desktop rail
          and the phone <select>) so the detail panel is the only column. */}
      <div
        className={`mx-auto grid max-w-[var(--max-content)] grid-cols-1 gap-6 px-4 pt-5 pb-8 sm:px-6 ${
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
            // hideRail drops the rail COLUMN (the attribute switcher), not
            // subRail's own cross-nav (sibling divisions / a center's Reports
            // link) — it still needs somewhere to live, so it renders here
            // instead of silently disappearing with the rest of the rail.
            subRail && <div className="mb-4">{subRail}</div>
          ) : (
            <RailSheet
              items={railItems}
              active={activeAttr}
              basePath={basePath}
              subRail={subRail}
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
