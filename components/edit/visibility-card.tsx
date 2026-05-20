/**
 * The Profile Visibility card (#356 Phase 6 C6, UI-SPEC § `/edit` Card 2).
 *
 * A four-state machine over the scholar's own scholar-suppression rows:
 *   ┌─────────────────┬────────────────┬───────────────────────────────────┐
 *   │ ownRow          │ adminRow       │ Controls                          │
 *   ├─────────────────┼────────────────┼───────────────────────────────────┤
 *   │ null            │ null           │ "Hide my profile" → confirm dialog│
 *   │ set             │ null           │ "Make my profile visible" (revoke)│
 *   │ null            │ set            │ no control (admin-only revoke)    │
 *   │ set             │ set            │ "Remove my hold" (revoke own only)│
 *   └─────────────────┴────────────────┴───────────────────────────────────┘
 *
 * Hide → confirm dialog (UI-SPEC § Suppression and confirmation dialogs row 1,
 * optional-preset reason). Revoke → no dialog (UI-SPEC § Feedback: confirmation
 * gates loss of visibility, never restoration).
 *
 * Endpoints (Phase 2):
 *   POST /api/edit/suppress  { entityType, entityId, reason }   → { suppressionId }
 *   POST /api/edit/revoke    { suppressionId }                  → { ok }
 *
 * On a successful write the card flips into its new state locally and calls
 * `router.refresh()` so sibling components (the publications card) pick up
 * any cascading changes from a suppression-OFF re-read.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { EditContextScholar } from "@/lib/api/edit-context";

type SuppressionRow = { id: string; reason: string };
type AdminRow = SuppressionRow & { createdAt: Date };

export type VisibilityCardProps = {
  cwid: string;
  /** The visibility-card slice of the scholar's suppression state. */
  suppression: EditContextScholar["suppression"];
};

export function VisibilityCard({ cwid, suppression: initial }: VisibilityCardProps) {
  const router = useRouter();
  const [ownRow, setOwnRow] = React.useState<SuppressionRow | null>(initial.ownRow);
  const [adminRow] = React.useState<AdminRow | null>(initial.adminRow);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function hideProfile(reason: string | null) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          // The server defaults a missing/blank reason to a "self-suppressed via /edit" string.
          ...(reason ? { reason } : {}),
        }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't hide your profile. Please try again.");
        // Re-throw so the dialog's "Working…" state resets and the dialog
        // stays open for the user to retry / cancel.
        throw new Error("suppress_failed");
      }
      setOwnRow({ id: data.suppressionId, reason: reason ?? "Self-suppressed via /edit" });
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function revokeOwnSuppression() {
    if (!ownRow) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressionId: ownRow.id }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't make your profile visible. Please try again.");
        return;
      }
      setOwnRow(null);
      router.refresh();
    } catch {
      setError("We couldn't make your profile visible. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-slot="visibility-card">
      <CardHeader>
        <CardTitle>Profile visibility</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* visible */}
        {ownRow === null && adminRow === null && (
          <>
            <p className="text-sm">Your profile is visible to the public.</p>
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmOpen(true)}
                data-testid="visibility-hide"
              >
                Hide my profile
              </Button>
            </div>
          </>
        )}

        {/* hidden — self only */}
        {ownRow !== null && adminRow === null && (
          <>
            <Alert variant="info">
              <AlertDescription>
                Your profile is hidden. It is not visible to the public or in search.
              </AlertDescription>
            </Alert>
            <div>
              <Button
                type="button"
                onClick={revokeOwnSuppression}
                disabled={pending}
                data-testid="visibility-revoke-self"
              >
                {pending ? "Working…" : "Make my profile visible"}
              </Button>
            </div>
          </>
        )}

        {/* hidden — admin only */}
        {ownRow === null && adminRow !== null && (
          <Alert variant="info">
            <AlertDescription>
              Your profile has been hidden by a site administrator. Contact the
              Scholars Profile team for help.
            </AlertDescription>
          </Alert>
        )}

        {/* hidden — both (edge case 4) */}
        {ownRow !== null && adminRow !== null && (
          <>
            <Alert variant="info">
              <AlertDescription>
                Your profile has been hidden by a site administrator. Contact the
                Scholars Profile team for help.
              </AlertDescription>
            </Alert>
            <p className="text-sm">You have also hidden it yourself.</p>
            <p className="text-sm text-muted-foreground">
              The profile stays hidden while the administrator hold remains.
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={revokeOwnSuppression}
                disabled={pending}
                data-testid="visibility-revoke-own-hold"
              >
                {pending ? "Working…" : "Remove my hold"}
              </Button>
            </div>
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Hide your profile?"
        description="Your profile will be removed from public view and search immediately. You can make it visible again at any time."
        reasonMode="optional-preset"
        confirmLabel="Hide my profile"
        confirmVariant="destructive"
        onConfirm={hideProfile}
      />
    </Card>
  );
}
