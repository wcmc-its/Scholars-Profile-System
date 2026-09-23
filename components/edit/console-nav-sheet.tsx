"use client";

/**
 * Below `xl` the console tabs don't fit the top bar next to the brand and the
 * account menu, so they collapse into one button naming where you are; it opens
 * a sheet listing every visible tab, grouped under the same headings as the
 * desktop dropdowns. Plain links only — the Matcha hover card and the group
 * hover menus are desktop affordances a phone can't use anyway.
 */
import * as React from "react";
import Link from "next/link";
import { Menu } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type ConsoleNavSection = {
  /** Group heading; `null` for the top-level tabs. */
  label: string | null;
  items: Array<{ id: string; href: string; label: string; count?: number; active: boolean }>;
};

export function ConsoleNavSheet({
  sections,
  currentLabel,
}: {
  sections: ConsoleNavSection[];
  currentLabel: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-md border border-white/25 px-3 text-sm text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none min-[960px]:hidden"
        data-testid="console-nav-sheet-trigger"
      >
        <Menu className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{currentLabel}</span>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="bg-apollo-page gap-0 overflow-y-auto p-0 min-[960px]:hidden"
      >
        <SheetHeader className="border-apollo-border border-b">
          <SheetTitle>Console</SheetTitle>
        </SheetHeader>
        {/* Every item is a <Link>: a tap navigates and closes the sheet. */}
        {/* Hierarchy: top-level destinations are full-size; a labelled group gets
            a heading and its items sit indented behind a hairline guide, one
            size down, with a rule between groups. */}
        <nav
          aria-label="Console"
          className="divide-apollo-border flex flex-col divide-y px-3"
          onClick={() => setOpen(false)}
        >
          {sections.map((s) => (
            <div key={s.label ?? `top-${s.items[0].id}`} className="flex flex-col py-3">
              {s.label && (
                <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-[.08em] text-[#5c574d] uppercase">
                  {s.label}
                </p>
              )}
              <div className={s.label ? "border-apollo-border ml-3 flex flex-col border-l pl-2" : "flex flex-col"}>
                {s.items.map((it) => (
                  <Link
                    key={it.id}
                    href={it.href}
                    aria-current={it.active ? "page" : undefined}
                    className={`flex items-center justify-between gap-2 rounded-md px-3 text-[#1f1b19] ${
                      s.label ? "min-h-10 text-sm" : "min-h-11 text-[15px] font-medium"
                    } ${
                      it.active
                        ? "bg-apollo-surface-2 font-semibold shadow-[inset_3px_0_0_var(--apollo-maroon)]"
                        : "hover:bg-apollo-surface-2"
                    }`}
                  >
                    {it.label}
                    {it.count !== undefined && it.count > 0 && (
                      <span className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold text-white">
                        {it.count}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
