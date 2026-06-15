/**
 * OverviewSourceDrawer — the "Sources" trigger row + the slide-out drawer that
 * holds the source picker (#742 v3.1 §3 / #875 §5). The trigger reads as a
 * sentence about what will ground the bio ("5 publications · 6 awards");
 * clicking it opens a right-hand sheet with the pickable checklists
 * ({@link OverviewIncludePicker}).
 *
 * #875 §5 — the drawer is now **buffered**. It holds a LOCAL copy of the
 * selection while open; **Done commits** it to the parent (calls
 * `onSelectionChange`); **Cancel / X / Escape / click-outside DISCARD** (close
 * without committing). This is a behavior change from the prior live-lifted
 * selection — the parent selection only updates on Done. The in-drawer live
 * budget counter reads the LOCAL buffer.
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
import {
  OVERVIEW_SELECTION_MAX_ITEMS,
  OVERVIEW_SELECTION_MAX_TOOLS,
  type OverviewSelection,
} from "@/lib/edit/overview-params";

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

/** The trigger's one-line summary of the current (committed) selection. */
function summarize(selection: OverviewSelection, showTools: boolean): string {
  const parts = [
    plural(selection.pmids.length, "publication"),
    plural(selection.grantIds.length, "award"),
  ];
  if (showTools) parts.push(plural(selection.toolNames.length, "method"));
  return parts.join(" · ");
}

/** The combined live budget counter (§5): "14 of 25 papers + awards · 9 of 10
 *  methods", the methods band shown only when tools exist. */
function budgetLabel(selection: OverviewSelection, showTools: boolean): string {
  const items = selection.pmids.length + selection.grantIds.length;
  let label = `${items} of ${OVERVIEW_SELECTION_MAX_ITEMS} papers + awards`;
  if (showTools) {
    label += ` · ${selection.toolNames.length} of ${OVERVIEW_SELECTION_MAX_TOOLS} methods`;
  }
  return label;
}

export function OverviewSourceDrawer({
  options,
  selection,
  onSelectionChange,
  disabled = false,
}: OverviewSourceDrawerProps) {
  const [open, setOpen] = React.useState(false);
  // The buffered local copy edited while the drawer is open; seeded from the
  // committed selection each time the drawer opens, committed only on Done.
  const [draft, setDraft] = React.useState<OverviewSelection>(selection);

  const loaded = options !== null;
  const showTools = (options?.tools.length ?? 0) > 0;

  function openDrawer() {
    setDraft(selection); // seed the buffer from the committed selection
    setOpen(true);
  }

  function commit() {
    onSelectionChange(draft);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
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

      {/* `onOpenChange(false)` fires from X / Escape / click-outside — all of
          which DISCARD (just close, the buffer is dropped). Only Done commits. */}
      <Sheet open={open} onOpenChange={(next) => setOpen(next)}>
        <SheetContent side="right" className="sm:max-w-md" data-testid="overview-source-drawer">
          <SheetHeader className="flex-row items-center justify-between pr-12">
            <SheetTitle>Sources for your overview</SheetTitle>
            <span
              className="bg-apollo-maroon/10 text-apollo-maroon rounded-md px-2.5 py-1 text-xs font-medium"
              data-testid="overview-sources-counter"
            >
              {budgetLabel(draft, showTools)}
            </span>
          </SheetHeader>
          <SheetDescription className="sr-only">
            Pick which publications, funding awards, and methods ground your generated overview.
          </SheetDescription>

          <div className="flex-1 overflow-y-auto p-4">
            {options && (
              <OverviewIncludePicker
                options={options}
                selection={draft}
                onChange={setDraft}
                disabled={disabled}
              />
            )}
          </div>

          <SheetFooter className="flex-row items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              data-testid="overview-sources-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="apollo"
              onClick={commit}
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
