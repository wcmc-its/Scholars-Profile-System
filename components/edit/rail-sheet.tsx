/**
 * The mobile stand-in for the ATTRIBUTES rail (replaces `rail-select.tsx`).
 * The `<select>` it replaces flattened the rail into option text, dropping the
 * "Yours to edit" / "From WCM systems" split, the tier accents, the parent–child
 * nesting and the read-only notes — the collapsed state said nothing about where
 * you were. Instead: a one-line bar naming the active attribute's GROUP, the
 * attribute, and its position in the set; opening it slides in the actual
 * `AttributeRail` (same markup as desktop, so nothing is paraphrased).
 *
 * Still `md:hidden` — the desktop rail is unchanged, and the editor stays at the
 * top of the page on phones (the original reason for the select, finding 4.5).
 */
"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

import { AttributeRail, type RailItem } from "@/components/edit/attribute-rail";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export function RailSheet({
  items,
  active,
  basePath,
  subRail,
}: {
  items: ReadonlyArray<RailItem>;
  active: string;
  basePath: string;
  /** Same block the desktop rail column renders below the rail (e.g. a
   *  department's sibling divisions) — on phones it lived nowhere. */
  subRail?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const activeItem = items.find((i) => i.key === active) ?? items[0];
  const group = activeItem?.group;
  // "Yours to edit" is the only owned group; anything else is reference.
  const owned = (activeItem?.kind ?? (activeItem?.readonly ? "readonly" : "owned")) === "owned";
  const position = items.findIndex((i) => i.key === activeItem?.key) + 1;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        data-testid="rail-sheet-trigger"
        className={cn(
          "bg-apollo-surface border-apollo-border-strong focus-visible:ring-apollo-ring",
          "flex min-h-14 w-full items-center justify-between gap-3 rounded-md border border-l-[3px] px-3 py-2 text-left",
          "focus-visible:ring-2 focus-visible:outline-none md:hidden",
          owned ? "border-l-apollo-maroon" : "border-l-apollo-slate",
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          {group && (
            <span
              className={cn(
                "flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase",
                owned ? "text-apollo-maroon" : "text-apollo-slate",
              )}
            >
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  owned ? "bg-apollo-maroon" : "bg-apollo-slate",
                )}
                aria-hidden
              />
              {group}
            </span>
          )}
          <span className="truncate text-[15px] font-semibold">{activeItem?.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {position} / {items.length}
          </span>
          <span className="text-apollo-maroon text-xs font-semibold">Change</span>
          <ChevronRight className="text-apollo-maroon size-4" aria-hidden />
        </span>
      </SheetTrigger>

      <SheetContent side="left" className="bg-apollo-page gap-0 p-0 md:hidden">
        <SheetHeader className="border-apollo-border">
          <SheetTitle>Profile attributes</SheetTitle>
        </SheetHeader>
        {/* The rail's items are <Link>s — a click navigates and dismisses. */}
        <div
          className="flex flex-col gap-3 overflow-y-auto p-3"
          onClick={() => setOpen(false)}
        >
          <AttributeRail items={items} active={active} basePath={basePath} />
          {subRail}
        </div>
      </SheetContent>
    </Sheet>
  );
}
