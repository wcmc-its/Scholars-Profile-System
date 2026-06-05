/**
 * OverviewSourceDrawer — the "Sources" trigger row + the slide-out drawer that
 * holds the source picker (#742 v3.1 §3). The trigger reads as a sentence about
 * what will ground the bio ("5 publications · 6 awards"); clicking it opens a
 * right-hand sheet with the pickable checklists ({@link OverviewIncludePicker}).
 *
 * Owns only the open/closed state and the count summary; the selection itself
 * lives in the Generator tab (lifted to the card parent), so the choice persists
 * across drawer open/close and rides along into the next Generate. **Done just
 * closes** — nothing regenerates (v3.1 §3.4).
 */
"use client";

import * as React from "react";
import { Layers, SlidersHorizontal } from "lucide-react";

import { OverviewIncludePicker } from "@/components/edit/overview-include-picker";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import { OVERVIEW_SELECTION_MAX_ITEMS, type OverviewSelection } from "@/lib/edit/overview-params";

type OverviewSourceDrawerProps = {
  /** The candidate lists; `null` until the source-options fetch resolves. */
  options: OverviewSourceOptions | null;
  selection: OverviewSelection;
  onSelectionChange: (next: OverviewSelection) => void;
  disabled?: boolean;
};

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/** The trigger's one-line summary of the current selection. */
function summarize(selection: OverviewSelection, showTools: boolean): string {
  const parts = [
    plural(selection.pmids.length, "publication"),
    plural(selection.grantIds.length, "award"),
  ];
  if (showTools) parts.push(plural(selection.toolNames.length, "method"));
  return parts.join(" · ");
}

export function OverviewSourceDrawer({
  options,
  selection,
  onSelectionChange,
  disabled = false,
}: OverviewSourceDrawerProps) {
  const [open, setOpen] = React.useState(false);

  const loaded = options !== null;
  const showTools = (options?.tools.length ?? 0) > 0;
  const itemsSelected = selection.pmids.length + selection.grantIds.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !loaded}
        className="border-apollo-border bg-apollo-surface hover:bg-apollo-surface-2 flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-60"
        data-testid="overview-sources-trigger"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Layers className="text-apollo-maroon size-[18px] shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Sources</span>
            <span className="text-muted-foreground block text-[13px]">
              {loaded ? summarize(selection, showTools) : "Loading your sources…"}
            </span>
          </span>
        </span>
        <span className="text-apollo-maroon flex shrink-0 items-center gap-1.5 text-sm font-medium">
          <SlidersHorizontal className="size-[15px]" aria-hidden="true" />
          Edit
        </span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:max-w-md" data-testid="overview-source-drawer">
          <SheetHeader className="flex-row items-center justify-between pr-12">
            <SheetTitle>Sources for your bio</SheetTitle>
            <span
              className="bg-apollo-maroon/10 text-apollo-maroon rounded-md px-2.5 py-1 text-xs font-medium"
              data-testid="overview-sources-counter"
            >
              {itemsSelected} / {OVERVIEW_SELECTION_MAX_ITEMS} selected
            </span>
          </SheetHeader>
          <SheetDescription className="sr-only">
            Pick which publications, funding awards, and methods ground your generated bio.
          </SheetDescription>

          <div className="flex-1 overflow-y-auto p-4">
            {options && (
              <OverviewIncludePicker
                options={options}
                selection={selection}
                onChange={onSelectionChange}
                disabled={disabled}
              />
            )}
          </div>

          <SheetFooter className="flex-row items-center justify-between">
            <span className="text-muted-foreground max-w-[270px] text-xs">
              Up to {OVERVIEW_SELECTION_MAX_ITEMS} papers + awards{showTools ? ", 10 methods" : ""}.
              A focused set produces a sharper bio.
            </span>
            <Button
              type="button"
              variant="apollo"
              onClick={() => setOpen(false)}
              data-testid="overview-sources-done"
            >
              Done
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
