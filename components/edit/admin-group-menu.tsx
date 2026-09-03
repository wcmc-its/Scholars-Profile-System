"use client";

import { useState } from "react";
import Link from "next/link";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

/** One member link inside a group's hover menu. `count` renders a pending pill. */
export type GroupMenuMember = {
  id: string;
  href: string;
  label: string;
  active: boolean;
  count?: number;
};

/**
 * A grouped console-nav entry (Queues / Registries / Insights / Tools). The group
 * label sits in the tier-1 bar and reveals its member links in a HoverCard on hover
 * OR keyboard focus — replacing the old persistent tier-2 sub-bar
 * (`docs/2026-07-20-console-subnav-two-tier-spec.md`, hover-menu revision).
 *
 * 🔴 A CLIENT COMPONENT ON PURPOSE — the same #1783 lesson as `MatchaTab`: composing
 * a Radix HoverCard inside the SERVER `admin-subnav.tsx` threw a Server-Components
 * render error and SILENTLY DROPPED the subtree on staging (a 200 with a render-error
 * digest, invisible to jsdom). The whole HoverCard composition therefore lives inside
 * this one client boundary; the server nav only hands it plain serializable props.
 *
 * The group label stays a real <Link> to its first visible member, so a click
 * still reaches that surface directly (unchanged); the menu is the fast path to the
 * others. Members render as plain links here — Matcha included, so no nested
 * HoverCard — because the menu is itself the disclosure.
 *
 * 🔴 TOUCH IS HAND-WIRED (#2588). Radix HoverCard is mouse-only and actively BREAKS
 * touch: its trigger preventDefaults `touchstart` — which cancels the synthesized
 * click on iOS, so even the group's own <Link> never fires — and wraps open/close in
 * `excludeTouch`. On an iPhone the whole grouped nav was therefore INERT: no menu,
 * and no navigation either. `composeEventHandlers` cannot opt out (it only skips the
 * Radix handler when the default is ALREADY prevented, and there is no un-prevent),
 * so the tap is handled here — see `openOnTouch` below.
 */
export function AdminGroupMenu({
  groupId,
  label,
  href,
  active,
  members,
}: {
  groupId: string;
  label: string;
  /** First visible member's href — the group label's click-through target. */
  href: string;
  /** Whether this group owns the active tab (maroon underline on the entry). */
  active: boolean;
  members: GroupMenuMember[];
}) {
  const testId = `admin-group-${groupId}`;
  // Controlled so the touch path can open the menu; mouse hover and keyboard focus
  // still drive it through Radix's own onOpenChange (see the touch note above).
  const [open, setOpen] = useState(false);
  // `onTouchEnd` is the one trigger event Radix leaves alone. preventDefault stops
  // the tap from becoming a click on the group <Link>, so a tap opens the menu
  // instead of jumping to the first member — the members are all in the menu.
  const openOnTouch = (e: React.TouchEvent) => {
    e.preventDefault();
    setOpen((o) => !o);
  };
  // A trailing chevron marks every group entry as a disclosure, open or not
  // (`Console Nav Menu.dc.html`, option 1a — "anchored card").
  const chevron = (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="opacity-75"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
  // Mirrors `AdminTab`'s active/inactive tab styling (kept in sync by hand, like
  // MatchaTab) so a group entry sits flush in the bar with the top-level tabs.
  const trigger = active ? (
    <span
      className="border-apollo-maroon inline-flex shrink-0 items-center gap-1 border-b-2 py-3 text-sm font-medium whitespace-nowrap"
      aria-current="page"
      data-testid={testId}
      // A bare <span> is not focusable, so the active group alone could not open its
      // menu by keyboard — the one entry whose members have no other route to them.
      tabIndex={0}
    >
      {label}
      {chevron}
    </span>
  ) : (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 border-b-2 border-transparent py-3 text-sm whitespace-nowrap"
      data-testid={testId}
    >
      {label}
      {chevron}
    </Link>
  );
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={80} closeDelay={150}>
      <HoverCardTrigger asChild onTouchEnd={openOnTouch}>
        {trigger}
      </HoverCardTrigger>
      {/* Default popover chrome (border/bg/padding/shadow) is stripped here so the
          notch + card below can draw their own — this is the "anchored card"
          treatment, distinct from the generic `HoverCardContent` MatchaTab uses. */}
      <HoverCardContent
        align="start"
        className="w-[250px] border-none bg-transparent p-0 shadow-none"
        data-testid={`admin-group-menu-${groupId}`}
      >
        <div className="border-apollo-border-strong bg-apollo-surface absolute -top-[5px] left-[22px] h-2.5 w-2.5 rotate-45 border-t border-l" />
        <div className="border-apollo-border-strong bg-apollo-surface relative flex flex-col gap-0.5 rounded-[10px] border p-1.5 shadow-[0_12px_24px_-8px_rgba(34,30,28,.22),0_2px_6px_rgba(34,30,28,.08)]">
          <p className="text-apollo-slate m-0 px-2.5 pt-1.5 pb-1 text-[10px] font-bold tracking-[.1em] uppercase">
            {label}
          </p>
          <ul className="flex flex-col">
            {members.map((m) => (
              <li key={m.id}>
                <Link
                  href={m.href}
                  onClick={() => setOpen(false)}
                  aria-current={m.active ? "page" : undefined}
                  data-testid={`admin-tab-${m.id}`}
                  className={`flex min-h-9 items-center justify-between gap-2.5 rounded-[7px] border-l-2 px-2.5 text-sm whitespace-nowrap ${
                    m.active
                      ? "border-apollo-maroon text-apollo-maroon bg-apollo-rail font-medium"
                      : "text-foreground hover:bg-apollo-rail-hover border-transparent"
                  }`}
                >
                  <span>{m.label}</span>
                  {m.count !== undefined && m.count > 0 ? (
                    <span
                      className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold text-white"
                      data-testid="admin-subnav-pending-count"
                    >
                      {m.count}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
