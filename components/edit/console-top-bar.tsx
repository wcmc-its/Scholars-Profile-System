import { AccountMenu } from "@/components/site/account-menu";

/**
 * The black Apollo console top bar — WCM badge + "Scholars Profile Console"
 * title + an optional account menu. Extracted from `EditShell` so the editor
 * and the (soon) `ConsoleShell` render ONE bar instead of ~14 hand-rolled
 * copies that had already diverged on badge size, account-menu presence and
 * heading element (`docs/2026-07-20-console-shell-migration-plan.md`).
 *
 * The public Scholars site keeps its Cornell-red header — deliberately a
 * distinct surface; this bar is the Apollo Management Console mirror only.
 */
export function ConsoleTopBar({
  account,
  variant = "editor",
}: {
  /**
   * The signed-in (actor) scholar's identity for the header account menu. Omit
   * / pass `null` on a surface that doesn't have the actor's scholar row — the
   * menu then degrades to a plain Sign out (matching the old EditShell behaviour).
   * Ignored when `variant="console"`.
   */
  account?: { slug: string; preferredName: string } | null;
  /**
   * `"editor"` (default, EditShell): the console name is the page `<h1>` and the
   * right end carries the account menu / Sign out.
   *
   * `"console"` (ConsoleShell list/queue pages): the console name is a NON-heading
   * `<span>` — those pages own their own `<h1>` page title, so an `<h1>` here would
   * make two — and the right end is EMPTY, because the account menu lives in the
   * `AdminSubnav` strip below (`AccountMenu context="console"`, self-fetching) so
   * no actor scholar row is threaded through every page.
   */
  variant?: "editor" | "console";
}) {
  const isConsole = variant === "console";
  return (
    <header className="bg-apollo-bar text-white">
      <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <span
            className="bg-apollo-maroon text-apollo-maroon-foreground flex size-9 items-center justify-center rounded-md text-xs font-bold tracking-wide"
            aria-hidden
          >
            WCM
          </span>
          {isConsole ? (
            <span className="text-base font-semibold">Scholars Profile Console</span>
          ) : (
            <h1 className="text-base font-semibold">Scholars Profile Console</h1>
          )}
        </div>
        {isConsole ? null : account ? (
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
  );
}
