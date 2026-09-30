"use client";

/**
 * The phone filter sheet shared by the Profiles roster, report 8 and
 * `/edit/orcid-coverage`: below `lg` a "Filters" / "Filters (n)" trigger slides
 * the page's filter rail in from the left; the desktop rail (`hidden lg:block`
 * on the page) is untouched. `children` is the rail itself, so a server-rendered
 * `AutoSubmitForm` rail passes straight through. Radix mounts the content only
 * while open, but the hidden desktop copy is always in the DOM, so the caller
 * gives the sheet copy its own DOM ids (`idSuffix` on the report rails).
 */
import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export function FiltersSheet({
  activeCount,
  testId,
  children,
}: {
  /** Active filter selections; 0 shows a bare "Filters". */
  activeCount: number;
  /** The trigger's `data-testid`. */
  testId: string;
  children: ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger
        className="border-apollo-border-strong bg-apollo-surface inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm lg:hidden"
        data-testid={testId}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {activeCount ? `Filters (${activeCount})` : "Filters"}
      </SheetTrigger>
      <SheetContent side="left" className="bg-apollo-page gap-0 overflow-y-auto p-0 lg:hidden">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
        <div className="p-3">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
