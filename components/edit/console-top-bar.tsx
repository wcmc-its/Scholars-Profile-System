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
 * The self-fetching `AccountMenu context="console"` already derives its
 * scholar + display name from the `/api/auth/session` probe, already renders
 * "Back to Scholars", and already covers the no-scholar-row case via
 * `probe.displayName` — so every editor page gets that mount directly instead,
 * and no scholar prop needs threading through `EditShell` any more.
 */
export function ConsoleTopBar({
  variant = "editor",
  showAccountMenu = false,
  children,
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
   * `<h1>` here would make two. The account menu renders when the bar carries
   * the nav (`children`) or `showAccountMenu` is set; otherwise the right end
   * is empty.
   */
  variant?: "editor" | "console";
  /**
   * `variant="console"` only: render the account menu with NO nav in the bar —
   * the read-only audit-history pages (`ScholarHistoryView`,
   * `CenterHistoryView`), which have no `AdminSubnav` anywhere, would otherwise
   * have no sign-out at all. Ignored for `variant="editor"`, which always
   * renders the menu.
   */
  showAccountMenu?: boolean;
  /** The console nav (`AdminSubnav`), rendered in the bar between the brand and
   *  the account menu. Supplying it also puts the account menu in the bar. */
  children?: React.ReactNode;
}) {
  const isConsole = variant === "console";
  const accountMenu = !isConsole || showAccountMenu || children != null;
  return (
    <header className="bg-apollo-bar sticky top-0 z-40 text-white">
      <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center justify-between gap-4 px-4 sm:px-6 xl:gap-8">
        {isConsole ? (
          <span className="shrink-0 text-base font-semibold">
            <Link href="/edit" className={BRAND_LINK_CLASS}>
              <span
                className="bg-apollo-maroon text-apollo-maroon-foreground flex size-9 items-center justify-center rounded-md text-xs font-bold tracking-wide"
                aria-hidden
              >
                WCM
              </span>
              <span className="sr-only sm:not-sr-only">Scholars Profile Console</span>
            </Link>
          </span>
        ) : (
          <h1 className="shrink-0 text-base font-bold">
            <Link href="/edit" className={BRAND_LINK_CLASS}>
              <span
                className="bg-apollo-maroon text-apollo-maroon-foreground flex size-9 items-center justify-center rounded-md text-xs font-bold tracking-wide"
                aria-hidden
              >
                WCM
              </span>
              <span className="sr-only sm:not-sr-only">Scholars Profile Console</span>
            </Link>
          </h1>
        )}
        {children}
        {accountMenu && (
          <div className="shrink-0">
            <AccountMenu context="console" />
          </div>
        )}
      </div>
    </header>
  );
}
