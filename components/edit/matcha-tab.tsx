"use client";

import Link from "next/link";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

/**
 * The Matcha nav tab and its explanatory HoverCard.
 *
 * 🔴 A CLIENT COMPONENT ON PURPOSE. Composing Radix HoverCard (Trigger `asChild` + Content)
 * directly inside the SERVER component `admin-subnav.tsx` threw a Server-Components render error
 * and SILENTLY DROPPED THE WHOLE TAB on staging (2026-07-17) — the tab was in the SSR stream but a
 * render-error digest replaced it, so the nav lost Matcha entirely while the page still 200'd.
 * jsdom does not model RSC, so every unit test passed; only staging showed it. The working
 * HoverCard call sites in this repo (`person-popover`, `research-areas-row`) are ALL client
 * components — this matches them: the asChild composition happens entirely inside a client module,
 * and the server nav only renders this one boundary.
 *
 * The tab markup mirrors `AdminTab` in `admin-subnav.tsx`, kept in sync by hand — cheap for the one
 * tab that carries a hover, and safer than importing string consts across the server/client line.
 */
export function MatchaTab({ active }: { active: boolean }) {
  const tab = active ? (
    <span
      className="border-apollo-maroon inline-block shrink-0 border-b-2 py-3 text-sm font-medium whitespace-nowrap"
      aria-current="page"
      data-testid="admin-tab-matcha"
    >
      Matcha
    </span>
  ) : (
    <Link
      href="/edit/matcha"
      className="text-muted-foreground hover:text-foreground inline-block shrink-0 border-b-2 border-transparent py-3 text-sm whitespace-nowrap"
      data-testid="admin-tab-matcha"
    >
      Matcha
    </Link>
  );
  return (
    <HoverCard>
      <HoverCardTrigger asChild>{tab}</HoverCardTrigger>
      <HoverCardContent className="w-80 p-3.5 text-sm leading-relaxed">
        <strong className="text-foreground font-semibold">Paste the ask. Get the shortlist.</strong>{" "}
        Matcha reads any opportunity description into its underlying topics and methods, weighs each
        one, and ranks scholars by fit across all of them — with the evidence behind every name.
      </HoverCardContent>
    </HoverCard>
  );
}
