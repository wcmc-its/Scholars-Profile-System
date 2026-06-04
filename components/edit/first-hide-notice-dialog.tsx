/**
 * The first-hide-of-a-session educational notice (#570).
 *
 * Shown once per session, before the very first publication hide commits. Its
 * job is to put the *correct* tool in front of the scholar at the moment of
 * action: Hide is display-only on Scholars and is exactly right for "this is
 * mine, I'd just rather not show it"; rejecting in Publication Manager is the
 * correct-at-source fix for "this isn't mine" and is the ONLY thing that
 * corrects the misattribution upstream (reports, the Faculty Review Tool, the
 * SOR).
 *
 * Load-bearing constraint (`docs/self-edit-launch-spec.md` § Item-level
 * feedback): the copy leads with Hide and keeps it the primary button. Reject
 * is a secondary, explicitly "it's not mine" affordance — never the loud
 * default — because rejecting a paper that genuinely IS the scholar's feeds a
 * false negative into ReCiter's disambiguation algorithm and degrades
 * attribution accuracy for the whole corpus, not just this profile.
 *
 * Presentational only: the once-per-session bookkeeping (sessionStorage) and
 * the compose-with-sole-author-confirm sequencing live in the parent
 * `publications-card.tsx`.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";

export type FirstHideNoticeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Primary action — proceed with the hide the scholar already initiated. */
  onHide: () => void;
  /**
   * The "it's not mine" path: the scholar leaves for Publication Manager in a
   * new tab. The publication is NOT hidden on Scholars. Fires for either reject
   * affordance (the inline body link or the footer button).
   */
  onNotMine: () => void;
};

export function FirstHideNoticeDialog({
  open,
  onOpenChange,
  onHide,
  onNotMine,
}: FirstHideNoticeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>You&apos;re about to hide this paper.</DialogTitle>
          <DialogDescription>
            Hiding removes it from your Scholars profile only — it&apos;s
            display-only and reversible, and it changes nothing upstream. If this
            paper is yours and you&apos;d just rather not show it, hiding is
            exactly right.
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm text-muted-foreground">
          <p>
            <span className="text-foreground font-medium">
              Is this paper not actually yours?
            </span>{" "}
            Then don&apos;t hide it —{" "}
            <a
              href={PUBLICATION_MANAGER_URL}
              target="_blank"
              rel="noreferrer"
              onClick={onNotMine}
              className="text-foreground underline"
            >
              reject it in Publication Manager
            </a>{" "}
            so the misattribution is corrected at the source (it otherwise keeps
            appearing in internal reports and the Faculty Review Tool; the
            correction reaches Scholars in about a day).{" "}
            <span className="text-foreground font-medium">
              Only reject papers that genuinely aren&apos;t yours
            </span>{" "}
            — rejecting your own work to tidy your profile feeds the wrong signal
            into the matching algorithm and weakens attribution for everyone.
          </p>
        </div>

        <DialogFooter>
          {/* The "not mine" path lives only as the educational inline link above
              (vision-round finding 4.9 + #570) — the standing per-row "Not mine?"
              affordance handles the repeat case, so the footer no longer
              duplicates it. DOM order Cancel -> Hide it keeps the primary
              "Hide it" rightmost on desktop and on top on mobile; it's autofocused
              because it IS the action the scholar already initiated. */}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="first-hide-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            autoFocus
            onClick={onHide}
            data-testid="first-hide-confirm"
          >
            Hide it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
