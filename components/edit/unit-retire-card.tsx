/**
 * UnitRetireCard — the whole-unit retire flow (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 7). Superuser-only. A three-state machine:
 *
 *   1. **idle** — an explainer + "Retire this {unitType}" button.
 *   2. **confirming** — the operator types the unit's display name to unlock
 *      "Confirm retire" (the type-to-confirm gate lifted from
 *      `visibility-card.tsx`) and supplies a required reason.
 *   3. **retired** — "Retired on {date}. Public page returns 404." + Restore.
 *
 * Retire POSTs `/api/edit/suppress` `{ entityType, entityId, reason }`; Restore
 * POSTs `/api/edit/revoke` `{ suppressionId }`. Retiring a department with an
 * active chair appointment is refused server-side (409
 * `leadership_appointment_not_suppressible`) — surfaced here as a real
 * explanation, not a generic error. The retiring actor is recorded in the B03
 * audit row and is **not** shown in the UI.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type UnitRetireCardProps = {
  entityType: "department" | "division" | "center";
  /** The unit code (the API request's `entityId`). */
  entityId: string;
  /** The unit's display name — the type-to-confirm gate matches against this. */
  unitName: string;
  /** Present when the unit is already retired; drives the Restore state. */
  suppression: { id: string; suppressedAt: Date } | null;
};

type Mode = "idle" | "confirming" | "retired";

export function UnitRetireCard({ entityType, entityId, unitName, suppression }: UnitRetireCardProps) {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>(suppression ? "retired" : "idle");
  const [suppressionId, setSuppressionId] = React.useState<string | null>(suppression?.id ?? null);
  const [retiredAt, setRetiredAt] = React.useState<Date | null>(suppression?.suppressedAt ?? null);

  const [nameInput, setNameInput] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const nameMatches = nameInput.trim() === unitName.trim();
  const canConfirm = !busy && nameMatches && reason.trim().length > 0;

  function startConfirm() {
    setError(null);
    setNameInput("");
    setReason("");
    setMode("confirming");
  }

  function cancelConfirm() {
    setError(null);
    setMode("idle");
  }

  async function retire() {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, reason: reason.trim() }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage("error" in data ? data.error : "", entityType));
        return;
      }
      setSuppressionId(data.suppressionId);
      setRetiredAt(new Date());
      setMode("retired");
      router.refresh();
    } catch {
      setError(mapErrorToMessage("", entityType));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (busy || suppressionId === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressionId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? "", entityType));
        return;
      }
      setMode("idle");
      setSuppressionId(null);
      setRetiredAt(null);
      router.refresh();
    } catch {
      setError(mapErrorToMessage("", entityType));
    } finally {
      setBusy(false);
    }
  }

  return (
    <EditPanel
      slot="unit-retire-card"
      heading={`Retire ${entityType}`}
      description={
        mode === "retired"
          ? "This unit is retired. Its public page returns 404."
          : `Retiring this ${entityType} is reversible.`
      }
    >
      <div className="flex flex-col gap-4">
        {mode === "idle" && (
          <>
            <p className="text-muted-foreground text-sm">
              The {entityType} page will return 404. Member scholars are unaffected. The facet drops
              on the next search rebuild. Retirement is reversible.
            </p>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="destructive"
                onClick={startConfirm}
                data-testid="unit-retire-start"
              >
                Retire this {entityType}
              </Button>
            </div>
          </>
        )}

        {mode === "confirming" && (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="unit-retire-name" className="text-sm font-medium">
                Type <span className="font-semibold">{unitName}</span> to confirm
              </label>
              <Input
                id="unit-retire-name"
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (error) setError(null);
                }}
                autoComplete="off"
                data-testid="unit-retire-name-input"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="unit-retire-reason" className="text-sm font-medium">
                Reason
              </label>
              <Textarea
                id="unit-retire-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (error) setError(null);
                }}
                rows={3}
                placeholder="Required — why this unit is being retired"
                data-testid="unit-retire-reason"
              />
            </div>
            <div className="flex items-center justify-end gap-3">
              <Button type="button" variant="outline" onClick={cancelConfirm} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={retire}
                disabled={!canConfirm}
                data-testid="unit-retire-confirm"
              >
                {busy ? "Retiring…" : "Confirm retire"}
              </Button>
            </div>
          </>
        )}

        {mode === "retired" && (
          <>
            <p className="text-sm" data-testid="unit-retire-retired-state">
              Retired{retiredAt ? ` on ${formatDate(retiredAt)}` : ""}. Public page returns 404.
            </p>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="apollo"
                onClick={restore}
                disabled={busy}
                data-testid="unit-retire-restore"
              >
                {busy ? "Restoring…" : "Restore"}
              </Button>
            </div>
          </>
        )}

        {error && (
          <Alert variant="destructive" data-testid="unit-retire-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </EditPanel>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function mapErrorToMessage(code: string, entityType: string): string {
  switch (code) {
    case "leadership_appointment_not_suppressible":
      return `This ${entityType} has an active chair appointment. End the chair appointment in HR first, then retry.`;
    case "not_superuser":
      return "You no longer have access to retire this unit. Refresh the page and try again.";
    case "reason_required":
      return "A reason is required.";
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
