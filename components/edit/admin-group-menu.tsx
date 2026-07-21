"use client";

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
 * The group label stays a real <Link> to its first visible member, so a click/tap
 * still reaches that surface directly (unchanged); the menu is the fast path to the
 * others. Members render as plain links here — Matcha included, so no nested
 * HoverCard — because the menu is itself the disclosure.
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
  // Mirrors `AdminTab`'s active/inactive tab styling (kept in sync by hand, like
  // MatchaTab) so a group entry sits flush in the bar with the top-level tabs.
  const trigger = active ? (
    <span
      className="border-apollo-maroon inline-block shrink-0 border-b-2 py-3 text-sm font-medium whitespace-nowrap"
      aria-current="page"
      data-testid={testId}
    >
      {label}
    </span>
  ) : (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-block shrink-0 border-b-2 border-transparent py-3 text-sm whitespace-nowrap"
      data-testid={testId}
    >
      {label}
    </Link>
  );
  return (
    <HoverCard openDelay={80} closeDelay={150}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent align="start" className="w-56 p-1.5" data-testid={`admin-group-menu-${groupId}`}>
        <ul className="flex flex-col">
          {members.map((m) => (
            <li key={m.id}>
              <Link
                href={m.href}
                aria-current={m.active ? "page" : undefined}
                data-testid={`admin-tab-${m.id}`}
                className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap ${
                  m.active
                    ? "text-apollo-maroon font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
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
      </HoverCardContent>
    </HoverCard>
  );
}
