"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDownIcon, ChevronLeftIcon, EyeIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useImpersonationProbe } from "@/components/site/use-impersonation-probe";
import { ImpersonationSwitcher } from "@/components/site/impersonation-switcher";
import { profilePath } from "@/lib/profile-url";

/**
 * Signed-in account menu rendered in the site header (UI-SPEC § Signing in
 * and reaching `/edit`). A `Popover` opened by a header-styled trigger:
 *
 *   - With a scholar row (the common case): Edit my profile · View my
 *     profile · Separator · Sign out.
 *   - Without a scholar row (a staff superuser without their own scholar
 *     profile — D5.3): Sign out only.
 *
 * **"View as" entry (#637, impersonation-spec.md §8).** When the
 * `/api/auth/session` probe reports `canImpersonate` (the real CWID is a
 * superuser, R1) a "View as…" row is added; it swaps the popover's contents to
 * the `ImpersonationSwitcher` panel (an in-place sub-view, not a nested
 * popover). A non-superuser — or a dark deployment — never sees the row, since
 * the probe returns `canImpersonate: false` when the feature flag is off.
 *
 * Sign out is a POST `<form>` (not a `<Link>`) — the /api/auth/logout route
 * accepts only POST, so a tricked GET cannot end a session. The Popover
 * primitive provides arrow / Esc keyboarding and focus-return-to-trigger.
 */

const ROW_CLASS =
  "block rounded-sm px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none transition-colors";

export type AccountMenuProps = {
  /**
   * The signed-in scholar's slug + preferred display name, or `null` when no
   * `Scholar` row exists for the session's cwid (a staff superuser case).
   */
  scholar: { slug: string; preferredName: string } | null;
};

export function AccountMenu({ scholar }: AccountMenuProps) {
  const label = scholar?.preferredName ?? "Account";
  // In-place sub-view of the popover: the menu rows, or the "View as" switcher.
  const [view, setView] = useState<"menu" | "switcher">("menu");
  const [open, setOpen] = useState(false);
  // The "View as" row only matters once the menu is open, so the probe is
  // deferred until then — a signed-in header render fires no /api/auth/session
  // request (the cookie-forwarding auth probe is header-auth-slot.tsx's job).
  const probe = useImpersonationProbe(open);
  const canImpersonate = probe?.canImpersonate ?? false;

  // Reset to the menu whenever the popover closes so it reopens on the rows.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setView("menu");
  }

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        data-slot="account-menu-trigger"
        className="inline-flex items-center gap-1 text-sm font-medium text-white/85 transition-colors hover:text-white focus:text-white focus:outline-none"
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
            {scholar ? (
              <>
                <Link href="/edit" className={ROW_CLASS} data-testid="account-menu-edit">
                  Edit my profile
                </Link>
                <Link
                  href={profilePath(scholar.slug)}
                  className={ROW_CLASS}
                  data-testid="account-menu-view"
                >
                  View my profile
                </Link>
                <Separator className="my-1" />
              </>
            ) : null}
            {canImpersonate ? (
              <>
                <button
                  type="button"
                  onClick={() => setView("switcher")}
                  className={`${ROW_CLASS} flex w-full items-center gap-2 text-left`}
                  data-testid="account-menu-view-as"
                >
                  <EyeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  View as…
                </button>
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
