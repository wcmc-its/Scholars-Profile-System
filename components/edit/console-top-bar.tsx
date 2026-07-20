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
}: {
  /**
   * The signed-in (actor) scholar's identity for the header account menu. Omit
   * / pass `null` on a surface that doesn't have the actor's scholar row — the
   * menu then degrades to a plain Sign out (matching the old EditShell behaviour).
   */
  account?: { slug: string; preferredName: string } | null;
}) {
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
  );
}
