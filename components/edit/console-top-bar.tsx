import Link from "next/link";

import { AccountMenu } from "@/components/site/account-menu";

/** Shared classes for the brand link — badge + wordmark — in both variants. */
const BRAND_LINK_CLASS =
  "flex items-center gap-3 rounded-sm transition-opacity hover:opacity-85 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

/**
 * The black Apollo console top bar — WCM badge + "Scholars Profile Console"
 * title (both a `Link` back to `/edit`) + an account menu. Extracted from
 * `EditShell` so the editor and the (soon) `ConsoleShell` render ONE bar
 * instead of ~14 hand-rolled copies that had already diverged on badge size,
 * account-menu presence and heading element
 * (`docs/2026-07-20-console-shell-migration-plan.md`).
 *
 * The public Scholars site keeps its Cornell-red header — deliberately a
 * distinct surface; this bar is the Apollo Management Console mirror only.
 *
 * **Bug #4 fix (dwd2001).** Every `variant="editor"` page used to thread a
 * `scholar` prop into `AccountMenu` (or, when that prop was omitted — a
 * non-scholar actor like a `comms_steward` — fall back to a bare Sign-out
 * form with NO menu at all, and therefore no "Back to Scholars" link either).
 * The self-fetching `AccountMenu context="console"` (the same mount
 * `AdminSubnav` uses below on `variant="console"` pages) already derives its
 * scholar + display name from the `/api/auth/session` probe, already renders
 * "Back to Scholars", and already covers the no-scholar-row case via
 * `probe.displayName` — so every editor page gets that mount directly instead,
 * and no scholar prop needs threading through `EditShell` any more.
 */
export function ConsoleTopBar({
  variant = "editor",
  showAccountMenu = false,
}: {
  /**
   * `"editor"` (default, EditShell + the handful of bare/reduced-chrome
   * pages like `ProxyLanding`): the console name is the page `<h1>`, and the
   * right end always carries the self-fetching `AccountMenu
   * context="console"` — there's no `AdminSubnav` on these pages to supply
   * it, so the top bar is the only place it can live.
   *
   * `"console"` (`ConsoleShell` list/queue pages): the console name is a
   * NON-heading `<span>` — those pages own their own `<h1>` page title, so an
   * `<h1>` here would make two — and the right end is EMPTY by default,
   * because the account menu lives in the `AdminSubnav` strip below
   * (`AccountMenu context="console"`) so no actor scholar row is threaded
   * through every page. See `showAccountMenu` for the exception.
   */
  variant?: "editor" | "console";
  /**
   * `variant="console"` only: render the account menu here, at the top-bar
   * level, instead of assuming `AdminSubnav` supplies it below. A couple of
   * `variant="console"` surfaces — the read-only scholar/center audit-history
   * pages (`ScholarHistoryView`, `CenterHistoryView`) — render this bar with
   * no `AdminSubnav` anywhere in the tree, so without this they have NO
   * account menu and NO sign-out at all. Every other `variant="console"`
   * caller already gets the menu from `AdminSubnav` and must leave this
   * unset/false — turning it on there would render the menu twice. Ignored
   * for `variant="editor"`, which always renders the menu regardless.
   */
  showAccountMenu?: boolean;
}) {
  const isConsole = variant === "console";
  return (
    <header className="bg-apollo-bar sticky top-0 z-40 text-white">
      <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center justify-between px-6">
        {isConsole ? (
          <span className="text-base font-semibold">
            <Link href="/edit" className={BRAND_LINK_CLASS}>
              <span
                className="bg-apollo-maroon text-apollo-maroon-foreground flex size-9 items-center justify-center rounded-md text-xs font-bold tracking-wide"
                aria-hidden
              >
                WCM
              </span>
              Scholars Profile Console
            </Link>
          </span>
        ) : (
          <h1 className="text-base font-bold">
            <Link href="/edit" className={BRAND_LINK_CLASS}>
              <span
                className="bg-apollo-maroon text-apollo-maroon-foreground flex size-9 items-center justify-center rounded-md text-xs font-bold tracking-wide"
                aria-hidden
              >
                WCM
              </span>
              Scholars Profile Console
            </Link>
          </h1>
        )}
        {isConsole ? (
          showAccountMenu ? (
            <AccountMenu context="console" />
          ) : null
        ) : (
          <AccountMenu context="console" />
        )}
      </div>
    </header>
  );
}
