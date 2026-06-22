"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Building2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  EyeIcon,
  FlaskConicalIcon,
  type LucideIcon,
  UserSearchIcon,
  UsersIcon,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useImpersonationProbe } from "@/components/site/use-impersonation-probe";
import { ImpersonationSwitcher } from "@/components/site/impersonation-switcher";
import type { ConsoleLink } from "@/lib/auth/console-links";
import { profilePath } from "@/lib/profile-url";

/**
 * Signed-in account menu rendered in the site header (UI-SPEC § Signing in
 * and reaching `/edit`) and — when the unified account-dropdown flag is on
 * (account-dropdown-nav handoff, Workstream A) — in the `/edit` `AdminSubnav`
 * strip via `context="console"`. A `Popover` opened by a context-styled trigger:
 *
 *   - With a scholar row (the common case): View my profile · Edit my profile ·
 *     Separator · console rows · Separator · Sign out. (Classic order — Edit
 *     before View — when the flag is off.)
 *   - In the console: the same, but the superuser roster row is replaced by a
 *     "Back to Scholars" link (→ `/`); the other destinations stay.
 *   - Without a scholar row (a staff superuser without their own scholar
 *     profile — D5.3): the console section + Sign out only.
 *
 * **Console entry points (role-aware-navigation-entry-points-spec.md).** The
 * `/api/auth/session` probe reports `consoleLinks` — the ordered `/edit` console
 * destinations the viewer is entitled to, computed server-side
 * (`lib/auth/console-links.ts`). They render as a row each in the "Manage"
 * section, **independent of whether the viewer has a scholar row** — so a
 * `comms_steward` or unit Owner/Curator who is not a superuser (and may have no
 * profile of their own, e.g. dwd2001) finally has a clickable path into the
 * console. Replaces the prior superuser-only "Manage profiles" entry.
 *
 * **"View as" entry (#637, impersonation-spec.md §8).** When the probe reports
 * `canImpersonate` (the real CWID is a superuser, R1) a "View as…" row is added;
 * it swaps the popover's contents to the `ImpersonationSwitcher` panel (an
 * in-place sub-view, not a nested popover). A non-superuser — or a dark
 * deployment — never sees the row, since the probe returns
 * `canImpersonate: false` when the feature flag is off.
 *
 * Sign out is a POST `<form>` (not a `<Link>`) — the /api/auth/logout route
 * accepts only POST, so a tricked GET cannot end a session. The Popover
 * primitive provides arrow / Esc keyboarding and focus-return-to-trigger.
 */

const ROW_CLASS =
  "block rounded-sm px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none transition-colors";

/** Leading icon per console destination, keyed by `ConsoleLink["id"]`. */
const CONSOLE_LINK_ICON: Record<ConsoleLink["id"], LucideIcon> = {
  "manage-profiles": UsersIcon,
  methods: FlaskConicalIcon,
  units: Building2Icon,
  "find-researchers": UserSearchIcon,
};

export type AccountMenuProps = {
  /**
   * The signed-in scholar's slug + preferred display name, or `null` when no
   * `Scholar` row exists for the session's cwid (a staff superuser case).
   * Optional: the console mount (`context="console"`) omits it and falls back to
   * the `/api/auth/session` probe's `scholar`, since `AdminSubnav` (a server
   * component) has no scholar object to thread in.
   */
  scholar?: { slug: string; preferredName: string } | null;
  /**
   * Show the "View my profile" row. Default true. The public header and the
   * unified console mount both show it (profile actions live in the dropdown).
   */
  showViewProfile?: boolean;
  /**
   * Where the menu is mounted (account-dropdown-nav handoff, Workstream A):
   *   - `"public"` (default) — the site header. The context row is the
   *     superuser "Admin console" roster link (rendered as a normal console row).
   *   - `"console"` — the `/edit` `AdminSubnav` strip (only when the unified-nav
   *     flag is on). The context row becomes "Back to Scholars" (→ `/`), the
   *     roster row is dropped (the Profiles tab already covers it), and the
   *     trigger is styled for the light strip rather than the maroon header.
   */
  context?: "public" | "console";
};

export function AccountMenu({
  scholar,
  showViewProfile = true,
  context = "public",
}: AccountMenuProps) {
  const isConsole = context === "console";
  // In-place sub-view of the popover: the menu rows, or the "View as" switcher.
  const [view, setView] = useState<"menu" | "switcher">("menu");
  const [open, setOpen] = useState(false);
  // The "View as" row only matters once the menu is open, so the public header
  // defers the probe until then — a signed-in header render fires no
  // /api/auth/session request. The console mount probes eagerly: it has no
  // scholar prop, so it needs the probe's `scholar` to label the chip and build
  // the View/Edit links (the /edit surfaces are authenticated, so the extra
  // fetch is cheap).
  const probe = useImpersonationProbe(open || isConsole);
  const canImpersonate = probe?.canImpersonate ?? false;
  // The role-aware console destinations the viewer may open (Manage profiles /
  // Method Families / Units you manage), computed server-side. Empty for a plain
  // scholar or before the probe resolves — the "Manage" section then renders
  // nothing.
  const consoleLinks = probe?.consoleLinks ?? [];
  // The signed-in scholar: the prop (public header) or the probe (console mount).
  const effectiveScholar = scholar ?? probe?.scholar ?? null;
  const label = effectiveScholar?.preferredName ?? "Account";
  // The unified menu (View → Edit order). Always on in the console (it only
  // mounts when the flag is on); driven by the probe on the public header.
  const unified = isConsole || (probe?.accountNavRestructure ?? false);
  // In the console the per-role roster link is replaced by "Back to Scholars",
  // so drop the manage-profiles row; other destinations (e.g. Funding matcher,
  // which has no AdminSubnav tab) stay reachable.
  const consoleRows = isConsole
    ? consoleLinks.filter((link) => link.id !== "manage-profiles")
    : consoleLinks;
  const showConsoleSection = isConsole || consoleLinks.length > 0 || canImpersonate;

  // Reset to the menu whenever the popover closes so it reopens on the rows.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setView("menu");
  }

  const editRow = (
    <Link href="/edit" className={ROW_CLASS} data-testid="account-menu-edit">
      Edit my profile
    </Link>
  );
  const viewRow =
    showViewProfile && effectiveScholar ? (
      <Link
        href={profilePath(effectiveScholar.slug)}
        className={ROW_CLASS}
        data-testid="account-menu-view"
      >
        View my profile
      </Link>
    ) : null;

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        data-slot="account-menu-trigger"
        className={
          isConsole
            ? "text-muted-foreground hover:text-foreground focus:text-foreground ml-auto inline-flex items-center gap-1 py-3 text-sm font-medium transition-colors focus:outline-none"
            : "inline-flex items-center gap-1 text-sm font-medium text-white/85 transition-colors hover:text-white focus:text-white focus:outline-none"
        }
        aria-label="Account menu"
      >
        <span className="max-w-[14ch] truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={view === "switcher" ? "w-[22rem] bg-popover p-2" : "w-48 bg-popover p-1"}
        data-slot="account-menu-content"
      >
        {view === "switcher" ? (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setView("menu")}
              className="inline-flex items-center gap-1 self-start rounded-sm px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
              Back
            </button>
            <ImpersonationSwitcher />
          </div>
        ) : (
          <>
            {effectiveScholar ? (
              <>
                {unified ? (
                  <>
                    {viewRow}
                    {editRow}
                  </>
                ) : (
                  <>
                    {editRow}
                    {viewRow}
                  </>
                )}
                <Separator className="my-1" />
              </>
            ) : null}
            {showConsoleSection ? (
              <>
                {isConsole ? (
                  <Link
                    href="/"
                    className={`${ROW_CLASS} flex w-full items-center gap-2`}
                    data-testid="account-menu-back-to-scholars"
                  >
                    <ChevronLeftIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    Back to Scholars
                  </Link>
                ) : null}
                {consoleRows.map((link) => {
                  const Icon = CONSOLE_LINK_ICON[link.id];
                  return (
                    <Link
                      key={link.id}
                      href={link.href}
                      className={`${ROW_CLASS} flex w-full items-center gap-2`}
                      data-testid={`account-menu-console-${link.id}`}
                    >
                      <Icon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {link.label}
                    </Link>
                  );
                })}
                {canImpersonate ? (
                  <button
                    type="button"
                    onClick={() => setView("switcher")}
                    className={`${ROW_CLASS} flex w-full items-center gap-2 text-left`}
                    data-testid="account-menu-view-as"
                  >
                    <EyeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    View as…
                  </button>
                ) : null}
                <Separator className="my-1" />
              </>
            ) : null}
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className={`${ROW_CLASS} w-full text-left`}
                data-testid="account-menu-signout"
              >
                Sign out
              </button>
            </form>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
