"use client";

import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

/**
 * Signed-in account menu rendered in the site header (UI-SPEC § Signing in
 * and reaching `/edit`). A `Popover` opened by a header-styled trigger:
 *
 *   - With a scholar row (the common case): Edit my profile · View my
 *     profile · Separator · Sign out.
 *   - Without a scholar row (a staff superuser without their own scholar
 *     profile — D5.3): Sign out only.
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

  return (
    <Popover>
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
        className="w-48 bg-popover p-1"
        data-slot="account-menu-content"
      >
        {scholar ? (
          <>
            <Link href="/edit" className={ROW_CLASS} data-testid="account-menu-edit">
              Edit my profile
            </Link>
            <Link
              href={`/scholars/${scholar.slug}`}
              className={ROW_CLASS}
              data-testid="account-menu-view"
            >
              View my profile
            </Link>
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
      </PopoverContent>
    </Popover>
  );
}
