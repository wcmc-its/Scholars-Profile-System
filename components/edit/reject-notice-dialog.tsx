/**
 * The "Not mine" reject interstitial soft-warning (#746, #570).
 *
 * Shown when a scholar clicks "Not mine?" on a publication AND the in-app reject
 * is enabled (`RECITER_REJECT_SEND=on`) — otherwise that control keeps the
 * Publication-Manager off-ramp. Unlike Hide (display-only, reversible,
 * mine-but-private), a reject is a one-way upstream signal to ReCiter that the
 * paper ISN'T this scholar's, so the copy leads with the #570 guardrail: only
 * reject genuine misattribution; rejecting your own work feeds a false negative
 * into the matching algorithm and weakens attribution for everyone. Cancel is
 * the autofocused default (the safety invariant — never the destructive
 * action); a secondary "Hide it instead" steers a mine-but-private intent to the
 * reversible path.
 *
 * Self-managed pending/error (mirrors confirm-dialog.tsx): `onReject` is awaited
 * with a "Working…" state; on rejection the dialog stays open and renders an
 * inline error. The parent closes the dialog on success.
 */
"use client";

import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RejectNoticeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The publication title, shown in the dialog body. */
  pubTitle: string;
  /** `superuser` reframes the first-person copy to the scholar's name — a
   *  superuser rejecting a misattributed paper on the scholar's behalf. */
  mode?: "self" | "superuser";
  scholarName?: string;
  /**
   * Commit the rejection (async). Resolves on success — the parent then closes
   * the dialog; rejects to keep the dialog open with an inline error.
   */
  onReject: () => Promise<void>;
  /** Secondary path — this IS mine, just hide it (reversible). */
  onHideInstead: () => void;
};

export function RejectNoticeDialog({
  open,
  onOpenChange,
  pubTitle,
  mode = "self",
  scholarName = "",
  onReject,
  onHideInstead,
}: RejectNoticeDialogProps) {
  const su = mode === "superuser";
  const possessive = su ? `${scholarName}’s` : "yours";
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset transient state whenever the dialog opens for a new publication.
  React.useEffect(() => {
    if (open) {
      setPending(false);
      setError(null);
    }
  }, [open]);

  async function handleReject() {
    setError(null);
    setPending(true);
    try {
      await onReject();
      // Success: the parent closes the dialog via the `open` prop.
    } catch {
      setError("We couldn't reject this publication. Please try again.");
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Don't let a backdrop/Esc close mid-commit.
        if (!pending) onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Is this paper not {possessive}?</DialogTitle>
          <DialogDescription>
            Rejecting <span className="text-foreground font-medium">{pubTitle}</span>{" "}
            tells the matching system this publication isn&apos;t {possessive}, so
            it&apos;s corrected at the source — it stops appearing on{" "}
            {su ? `${scholarName}’s` : "your"} profile, in internal reports, and in the Faculty
            Review Tool.
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm text-muted-foreground">
          <p>
            <span className="text-foreground font-medium">
              Only reject papers that genuinely aren&apos;t {possessive}.
            </span>{" "}
            {su ? (
              <>
                Rejecting {scholarName}&apos;s own work feeds the wrong signal into the matching
                algorithm and weakens attribution for everyone. If this paper{" "}
                <span className="text-foreground font-medium">is</span> {scholarName}&apos;s and
                they&apos;d just rather not show it, hide it instead — hiding is display-only and
                reversible.
              </>
            ) : (
              <>
                Rejecting your own work to tidy your profile feeds the wrong signal into the
                matching algorithm and weakens attribution for everyone. If this paper{" "}
                <span className="text-foreground font-medium">is</span> yours and you&apos;d just
                rather not show it, hide it instead — hiding is display-only and reversible.
              </>
            )}
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {/* DOM order Cancel -> Hide instead -> Reject puts the destructive
              "Reject" rightmost on desktop (footer is sm:flex-row justify-end)
              and on top on mobile. Cancel is autofocused — never the destructive
              action (#570 safety invariant). */}
          <Button
            type="button"
            variant="ghost"
            autoFocus
            disabled={pending}
            onClick={() => onOpenChange(false)}
            data-testid="reject-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onHideInstead}
            data-testid="reject-hide-instead"
          >
            Hide it instead
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={handleReject}
            data-testid="reject-confirm"
          >
            {pending ? "Working…" : su ? `Reject — it's not ${scholarName}’s` : "Reject — it's not mine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
