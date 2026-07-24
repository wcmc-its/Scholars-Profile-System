"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MenuIcon } from "lucide-react";

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * The header's small-screen navigation (#1902).
 *
 * The header is a single flex row with no breakpoints, so below ~640px the
 * primary nav was pushed outside the viewport entirely: `Browse`, `About` and
 * the auth slot were unreachable and every public page carried ~169px of
 * horizontal scroll. That is a WCAG 2.2 1.4.10 (Reflow) failure, not just a
 * cosmetic one.
 *
 * The wordmark alone is ~160px, so the three links plus a search field cannot
 * share a 60px bar at phone widths no matter how the gaps are tuned. This
 * collapses the two destination links into a sheet and leaves search reachable
 * as an icon; the auth slot stays inline rather than being buried, since
 * signing in should not require opening a menu.
 *
 * Rendered only below `sm` (the parent hides it at `sm:hidden`); the desktop
 * row is unchanged above that.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open menu"
        className="flex h-9 w-9 items-center justify-center rounded-md text-white/85 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
      >
        <MenuIcon className="h-5 w-5" aria-hidden="true" />
      </SheetTrigger>
      {/* Radix warns unless a Dialog has a description or opts out explicitly.
          Two nav links need no describing text, so opt out rather than add
          filler an assistive-tech user would have to listen to. */}
      <SheetContent side="right" aria-describedby={undefined} className="w-72 p-6">
        <SheetTitle className="text-base font-semibold">Menu</SheetTitle>
        <nav aria-label="Primary" className="mt-4 flex flex-col">
          {[
            { href: "/search", label: "Browse" },
            { href: "/about", label: "About" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              aria-current={pathname === item.href ? "page" : undefined}
              className="border-border border-b py-3 text-[15px] font-medium no-underline last:border-b-0 aria-[current=page]:text-[#7d1c1c]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
