/**
 * The Profile Visibility card (#356 Phase 6 C6 / Phase 7 C4, UI-SPEC § `/edit`
 * Card 2 + § `/edit/scholar/[cwid]` Card 2 superuser arm).
 *
 * Two state machines over the same `(ownRow, adminRow)` pair, one per mode:
 *
 * **Self mode** (`mode='self'`) — the scholar manages their own self-suppression
 * (`ownRow`); the admin row is informational only.
 *
 *   ┌─────────────────┬────────────────┬───────────────────────────────────┐
 *   │ ownRow          │ adminRow       │ Controls                          │
 *   ├─────────────────┼────────────────┼───────────────────────────────────┤
 *   │ null            │ null           │ "Hide my profile" → confirm dialog│
 *   │ set             │ null           │ "Make my profile visible" (revoke)│
 *   │ null            │ set            │ no control (admin-only revoke)    │
 *   │ set             │ set            │ "Remove my hold" (revoke own only)│
 *   └─────────────────┴────────────────┴───────────────────────────────────┘
 *
 * **Superuser mode** (`mode='superuser'`) — the administrator manages the
 * admin hold (`adminRow`); the scholar's self-suppression is informational
 * only (v1 does not surface a "revoke their self-hold" admin action — keeps
 * scope tight).
 *
 *   ┌─────────────────┬────────────────┬────────────────────────────────────────────┐
 *   │ ownRow          │ adminRow       │ Controls (acting on adminRow only)         │
 *   ├─────────────────┼────────────────┼────────────────────────────────────────────┤
 *   │ null            │ null           │ "Hide this scholar's profile" (req. reason)│
 *   │ set             │ null           │ "Hide this scholar's profile" + self-note  │
 *   │ null            │ set            │ "Restore this scholar's profile" (revoke)  │
 *   │ set             │ set            │ "Restore this scholar's profile" + self-note │
 *   └─────────────────┴────────────────┴────────────────────────────────────────────┘
 *
 * Hide → confirm dialog. In self mode the dialog is `optional-preset`
 * (UI-SPEC § Suppression and confirmation dialogs row 1); in superuser mode
 * the dialog is `required-text` (UI-SPEC § Suppression … row 2, SPEC §
 * Suppression UX — a superuser suppression's reason is mandatory). Revoke /
 * restore → no dialog (UI-SPEC § Feedback: confirmation gates loss of
 * visibility, never restoration).
 *
 * Endpoints (Phase 2):
 *   POST /api/edit/suppress  { entityType, entityId, reason }   → { suppressionId }
 *   POST /api/edit/revoke    { suppressionId }                  → { ok }
 *
 * On a successful write the card flips into its new state locally and calls
 * `router.refresh()` so sibling components pick up any cascading changes from
 * a suppression-OFF re-read.
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
  /**
   * The target scholar's preferred name — drives the superuser dialog title
   * ("Hide **{Name}**'s profile?") and the inline copy. Required when
   * `mode='superuser'`; ignored in `mode='self'`.
   */
  scholarName?: string;
  /**
   * Defaults to `'self'` for Phase 6 callers. `'superuser'` flips the state-
   * machine controls onto `adminRow`, switches the dialog to `required-text`
   * (UI-SPEC § Suppression and confirmation dialogs row 2 — a superuser
   * suppression's reason is mandatory), and adjusts the inline copy.
   */
  mode?: "self" | "superuser";
};

export function VisibilityCard({
  cwid,
  suppression: initial,
  scholarName,
  mode = "self",
}: VisibilityCardProps) {
  const router = useRouter();
  const [ownRow, setOwnRow] = React.useState<SuppressionRow | null>(initial.ownRow);
  const [adminRow, setAdminRow] = React.useState<AdminRow | null>(initial.adminRow);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  // ---- POST helpers --------------------------------------------------------

  async function suppressTarget(reason: string | null) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          // server defaults a blank reason for self; superuser mode pre-validates
          // the dialog's required-text so a blank should never reach here.
          ...(reason ? { reason } : {}),
        }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(
          mode === "superuser"
            ? "We couldn't hide this scholar's profile. Please try again."
            : "We couldn't hide your profile. Please try again.",
        );
        // Re-throw so the dialog's "Working…" state resets and the dialog
        // stays open for the user to retry / cancel.
        throw new Error("suppress_failed");
      }
      const newRow: SuppressionRow = {
        id: data.suppressionId,
        reason: reason ?? (mode === "superuser" ? "" : "Self-suppressed via /edit"),
      };
      if (mode === "self") {
        setOwnRow(newRow);
      } else {
        // The just-created superuser suppression is the new adminRow. The
        // server stamps `createdAt`; we approximate locally — a router.refresh
        // pulls the server value on the next re-render.
        setAdminRow({ ...newRow, createdAt: new Date() });
      }
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function revokeTarget(suppressionId: string, which: "own" | "admin") {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressionId }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(
          which === "admin"
            ? "We couldn't restore this scholar's profile. Please try again."
            : "We couldn't make your profile visible. Please try again.",
        );
        return;
      }
      if (which === "admin") setAdminRow(null);
      else setOwnRow(null);
      router.refresh();
    } catch {
      setError(
        which === "admin"
          ? "We couldn't restore this scholar's profile. Please try again."
          : "We couldn't make your profile visible. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  // ---- render --------------------------------------------------------------

  return (
    <Card data-slot="visibility-card" data-mode={mode}>
      <CardHeader>
        <CardTitle>Profile visibility</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mode === "self"
          ? renderSelfBody({
              ownRow,
              adminRow,
              pending,
              onHide: () => setConfirmOpen(true),
              onRevokeOwn: () => ownRow && revokeTarget(ownRow.id, "own"),
            })
          : renderSuperuserBody({
              ownRow,
              adminRow,
              pending,
              onHide: () => setConfirmOpen(true),
              onRevokeAdmin: () => adminRow && revokeTarget(adminRow.id, "admin"),
            })}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          mode === "superuser"
            ? `Hide ${scholarName ?? "this scholar"}'s profile?`
            : "Hide your profile?"
        }
        description={
          mode === "superuser"
            ? "This scholar's profile will be removed from public view and search immediately. A reason is required for the audit log."
            : "Your profile will be removed from public view and search immediately. You can make it visible again at any time."
        }
        reasonMode={mode === "superuser" ? "required-text" : "optional-preset"}
        confirmLabel={mode === "superuser" ? "Hide profile" : "Hide my profile"}
        confirmVariant="destructive"
        onConfirm={suppressTarget}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Self body — the Phase 6 state machine, copy unchanged.
// ---------------------------------------------------------------------------

type SelfBodyArgs = {
  ownRow: SuppressionRow | null;
  adminRow: AdminRow | null;
  pending: boolean;
  onHide: () => void;
  onRevokeOwn: () => void;
};

function renderSelfBody({ ownRow, adminRow, pending, onHide, onRevokeOwn }: SelfBodyArgs) {
  if (ownRow === null && adminRow === null) {
    return (
      <>
        <p className="text-sm">Your profile is visible to the public.</p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={onHide}
            data-testid="visibility-hide"
          >
            Hide my profile
          </Button>
        </div>
      </>
    );
  }
  if (ownRow !== null && adminRow === null) {
    return (
      <>
        <Alert variant="info">
          <AlertDescription>
            Your profile is hidden. It is not visible to the public or in search.
          </AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            onClick={onRevokeOwn}
            disabled={pending}
            data-testid="visibility-revoke-self"
          >
            {pending ? "Working…" : "Make my profile visible"}
          </Button>
        </div>
      </>
    );
  }
  if (ownRow === null && adminRow !== null) {
    return (
      <Alert variant="info">
        <AlertDescription>
          Your profile has been hidden by a site administrator. Contact the
          Scholars Profile team for help.
        </AlertDescription>
      </Alert>
    );
  }
  // both — edge case 4
  return (
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
          onClick={onRevokeOwn}
          disabled={pending}
          data-testid="visibility-revoke-own-hold"
        >
          {pending ? "Working…" : "Remove my hold"}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Superuser body — controls act on adminRow only; ownRow is informational.
// ---------------------------------------------------------------------------

type SuperuserBodyArgs = {
  ownRow: SuppressionRow | null;
  adminRow: AdminRow | null;
  pending: boolean;
  onHide: () => void;
  onRevokeAdmin: () => void;
};

function renderSuperuserBody({
  ownRow,
  adminRow,
  pending,
  onHide,
  onRevokeAdmin,
}: SuperuserBodyArgs) {
  // No admin hold → the superuser may add one. ownRow becomes informational.
  if (adminRow === null) {
    return (
      <>
        {ownRow === null ? (
          <p className="text-sm">This scholar&apos;s profile is visible to the public.</p>
        ) : (
          <Alert variant="info">
            <AlertDescription>
              This scholar has self-hidden their profile. You can still add an
              administrator hold.
            </AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={onHide}
            data-testid="visibility-hide"
          >
            Hide this scholar&apos;s profile
          </Button>
        </div>
      </>
    );
  }
  // Admin hold exists → the superuser may restore.
  return (
    <>
      <Alert variant="info">
        <AlertDescription>
          An administrator hold is in place. Reason:{" "}
          <em>{adminRow.reason || "(no reason on file)"}</em>.
        </AlertDescription>
      </Alert>
      {ownRow !== null && (
        <p className="text-sm text-muted-foreground">
          This scholar has also self-hidden their profile. Restoring the hold
          lifts the administrator action; the scholar&apos;s self-hold remains.
        </p>
      )}
      <div>
        <Button
          type="button"
          onClick={onRevokeAdmin}
          disabled={pending}
          data-testid="visibility-revoke-admin"
        >
          {pending ? "Working…" : "Restore this scholar's profile"}
        </Button>
      </div>
    </>
  );
}
