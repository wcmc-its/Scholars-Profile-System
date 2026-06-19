/**
 * OverviewSourceDrawer — the "Sources" trigger row + the slide-out drawer that
 * holds the three-state source picker (#742 §2 / Phase 2). The trigger reads as a
 * sentence about what will ground the bio ("5 publications · 6 awards"); clicking
 * it opens a right-hand sheet with {@link OverviewIncludePicker}.
 *
 * #875 §5 — the drawer is **buffered**. It holds a LOCAL copy of the deltas while
 * open; **Done commits** them to the parent (`onCommit`, which persists +
 * re-resolves the generation selection); **Cancel / X / Escape / click-outside
 * DISCARD**. The header status line and the picker read the LOCAL draft.
 *
 * The selection is now stored as DELTAS against the recommended auto-set, not a
 * checkbox snapshot (§2.5): the status line counts *divergences*
 * ("Using your recommended set · 1 pinned · 2 hidden"), never "9 of 25". **Reset
 * to recommended** drops every pin / veto / toggle back to the pure auto-set.
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
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  summarizeOverviewDeltas,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";
import { resolveOverviewSelection } from "@/lib/edit/overview-resolve";

type OverviewSourceDrawerProps = {
  /** The candidate lists; `null` until the source-options fetch resolves. */
  options: OverviewSourceOptions | null;
  /** The committed durable deltas (pins / vetoes / position toggles). */
  deltas: OverviewSelectionDeltas;
  /** Commit the edited deltas (the parent persists + re-resolves the selection). */
  onCommit: (next: OverviewSelectionDeltas) => void;
  disabled?: boolean;
};

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/** The trigger's one-line summary of what the committed deltas resolve to. */
function summarize(
  options: OverviewSourceOptions,
  deltas: OverviewSelectionDeltas,
  showTools: boolean,
): string {
  const sel = resolveOverviewSelection(options, deltas);
  const parts = [plural(sel.pmids.length, "publication"), plural(sel.grantIds.length, "award")];
  if (showTools) parts.push(plural(sel.toolNames.length, "method"));
  return parts.join(" · ");
}

/** The §2.5 status line — divergences from the auto-set, never a budget count. */
function statusLine(deltas: OverviewSelectionDeltas): string {
  const { pinned, hidden } = summarizeOverviewDeltas(deltas);
  const bits: string[] = [];
  if (pinned) bits.push(`${pinned} pinned`);
  if (hidden) bits.push(`${hidden} hidden`);
  return `Using your recommended set${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

export function OverviewSourceDrawer({
  options,
  deltas,
  onCommit,
  disabled = false,
}: OverviewSourceDrawerProps) {
  const [open, setOpen] = React.useState(false);
  // The buffered local copy edited while the drawer is open; seeded from the
  // committed deltas each time it opens, committed only on Done.
  const [draft, setDraft] = React.useState<OverviewSelectionDeltas>(deltas);

  const loaded = options !== null;
  const showTools = (options?.tools.length ?? 0) > 0;

  function openDrawer() {
    setDraft(deltas); // seed the buffer from the committed deltas
    setOpen(true);
  }

  function commit() {
    onCommit(draft);
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
              {loaded && options ? summarize(options, deltas, showTools) : "Loading your sources…"}
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
          <SheetHeader className="flex-row items-center justify-between gap-3 pr-12">
            <SheetTitle>Sources for your overview</SheetTitle>
            <span
              className="text-muted-foreground shrink-0 text-[12.5px]"
              data-testid="overview-sources-statusline"
            >
              {statusLine(draft)}
            </span>
          </SheetHeader>
          <SheetDescription className="sr-only">
            Pin or hide which publications, funding awards, and methods ground your generated
            overview. Hiding a record affects only this overview.
          </SheetDescription>

          <div className="flex-1 overflow-y-auto p-4">
            {options && (
              <OverviewIncludePicker
                options={options}
                deltas={draft}
                onChange={setDraft}
                disabled={disabled}
              />
            )}
          </div>

          <SheetFooter className="flex-row items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft(DEFAULT_OVERVIEW_SELECTION_DELTAS)}
              disabled={disabled}
              data-testid="overview-sources-reset"
            >
              Reset to recommended
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
