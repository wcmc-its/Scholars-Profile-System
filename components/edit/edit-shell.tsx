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
 */
import Link from "next/link";
import { ArrowUpRight, ChevronLeftIcon } from "lucide-react";

import { AttributeRail, type RailItem } from "@/components/edit/attribute-rail";
import { RailSelect } from "@/components/edit/rail-select";
import { ProxyBanner } from "@/components/edit/proxy-banner";
import { SuperuserBanner } from "@/components/edit/superuser-banner";
import { UnitAdminBanner } from "@/components/edit/unit-admin-banner";
import { AccountMenu } from "@/components/site/account-menu";

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
  /**
   * The signed-in (actor) scholar's identity for the header account menu. In
   * self mode this is the scholar themselves; omit it for surfaces that don't
   * have the actor's scholar row (the account menu then degrades to Sign out).
   */
  account?: { slug: string; preferredName: string } | null;
  /** Self mode only: the viewer is a superuser, so the sub-nav adds a link
   *  across to the Profiles roster (`/edit/scholars`). Ignored in superuser
   *  mode, where the "Profiles" tab is always a link back to that roster.
   *  Superseded by `consoleNav` when that is supplied. */
  canBrowseProfiles?: boolean;
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
  /** Unit-admin mode only (Amendment 4): the unit through which the viewer
   *  administers this scholar, naming the "via {unit} administrator" banner. */
  unitAdmin?: { unitKind: "department" | "division" | "center"; unitName: string };
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
  account,
  canBrowseProfiles = false,
  consoleNav,
  subRail,
  unitAdmin,
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

      {/* Top bar (black) — Apollo chrome with a real account/exit menu. */}
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span
              className="bg-apollo-maroon text-apollo-maroon-foreground flex size-9 items-center justify-center rounded-md text-xs font-bold tracking-wide"
              aria-hidden
            >
              WCM
            </span>
            <h1 className="text-base font-semibold">Scholars Profile Console</h1>
          </div>
          {account ? (
            <AccountMenu scholar={account} showViewProfile={false} />
          ) : (
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="text-sm text-white/85 transition-colors hover:text-white focus:text-white focus:outline-none"
                data-testid="edit-signout"
              >
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>

      {/* Sub-nav — maroon underline on the active tab. A superuser editing a
          scholar gets a "Profiles / <name>" breadcrumb back to the roster; a
          superuser on their own /edit gets an "All profiles" link across — or,
          when `consoleNav` is supplied (superuser / comms_steward self-edit), the
          full shared admin tab strip in its place. */}
      {mode === "self" && consoleNav ? (
        consoleNav
      ) : (
      <div className="border-border border-b">
        <div className="mx-auto flex max-w-[var(--max-content)] items-center gap-2 px-6">
          {isSuperuser ? (
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 py-3 text-sm">
              <Link
                href="/edit/scholars"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                data-testid="edit-subnav-profiles"
              >
                <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
                Profiles
              </Link>
              <span className="text-muted-foreground" aria-hidden>
                /
              </span>
              <span className="font-medium" aria-current="page">
                {scholarName}
              </span>
            </nav>
          ) : isProxy || isUnitAdmin ? (
            // A proxy / unit admin has no roster to return to — a flat label
            // naming the scholar they are editing, not a navigable breadcrumb.
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 py-3 text-sm">
              <span
                className="font-medium"
                aria-current="page"
                data-testid={isUnitAdmin ? "edit-subnav-unit-admin" : "edit-subnav-proxy"}
              >
                {scholarName}
              </span>
            </nav>
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
          compact <select> at the top of the detail column replaces it. */}
      <div className="mx-auto grid max-w-[var(--max-content)] grid-cols-1 gap-6 px-6 py-8 md:grid-cols-[16rem_1fr]">
        <div className="hidden flex-col gap-3 md:flex">
          <AttributeRail
            items={railItems}
            active={activeAttr}
            basePath={basePath}
            groupMeta={railGroupMeta}
          />
          {subRail}
        </div>

        <main id="edit-detail" tabIndex={-1} aria-labelledby="panel-heading" className="min-w-0 scroll-mt-4">
          <RailSelect items={railItems} active={activeAttr} basePath={basePath} />

          {/* Secondary links row (mockup parity, slate text). "View change
              history" (internal audit page, #955) sits beside "Preview Profile"
              (the public profile, external ↗). Shown alongside the account
              menu's "View my profile". */}
          {(historyHref || previewHref) && (
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

          {isSuperuser && <SuperuserBanner targetLabel={scholarName} />}
          {isProxy && <ProxyBanner targetLabel={scholarName} />}
          {isUnitAdmin && unitAdmin && (
            <UnitAdminBanner
              targetLabel={scholarName}
              unitKind={unitAdmin.unitKind}
              unitName={unitAdmin.unitName}
            />
          )}

          <div className="apollo-card">{children}</div>
        </main>
      </div>
    </div>
  );
}
