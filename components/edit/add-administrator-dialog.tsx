/**
 * AddAdministratorDialog — the page-level "Add administrator" affordance for the
 * Administrators tab (#728 Phase C, `ed-admin-org-unit-roles-spec.md` § 4.3).
 *
 * Replaces the per-person Add-admin forms that previously repeated inside every
 * roster card: one grant action belongs to the page, not to a person (the
 * grantee is picked here, so a per-card form was misleading and didn't scale).
 * A single button opens this dialog; on a successful grant it calls `onGranted`
 * so the roster upserts the new/updated grant optimistically.
 *
 * Thin client over the existing `POST /api/edit/grant` (no new endpoint). The
 * unit list is the set of units already present on the roster (same source the
 * per-card form used) — the grant route remains the authority boundary
 * (`canGrant` + `ed_locked` are all enforced server-side regardless of what the
 * picker offers).
 */
"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";

import { DirectoryPeopleTypeahead, type DirectoryValue } from "@/components/edit/directory-people-typeahead";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AdminRosterGrant } from "@/lib/api/administrators-roster";

/** A unit the dialog can grant on, pre-parsed from the roster's grants. */
export type AddAdminUnit = {
  /** `"entityType:entityId"` — the select option value. */
  value: string;
  entityType: AdminRosterGrant["entityType"];
  entityId: string;
  unitName: string;
  /** "{unitName} · {Kind}" for the option label. */
  label: string;
};

export type AddAdministratorDialogProps = {
  units: ReadonlyArray<AddAdminUnit>;
  /** Called after a successful grant so the roster can upsert it. */
  onGranted: (grantee: DirectoryValue, grant: AdminRosterGrant) => void;
};

/** Map a grant-route error code to a human message (add-flow subset). */
function mapAddError(code: string): string {
  switch (code) {
    case "scope_violation":
    case "authority_violation":
    case "not_unit_owner":
      return "You don't have permission to manage access for that unit.";
    case "invalid_cwid":
      return "That person couldn't be found. Try a different search.";
    default:
      return "Something went wrong — please try again.";
  }
}

export function AddAdministratorDialog({ units, onGranted }: AddAdministratorDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [grantee, setGrantee] = React.useState<DirectoryValue | null>(null);
  const [unitValue, setUnitValue] = React.useState("");
  const [role, setRole] = React.useState<"owner" | "curator">("curator");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset the draft each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setGrantee(null);
      setUnitValue("");
      setRole("curator");
      setSending(false);
      setError(null);
    }
  }, [open]);

  const noUnits = units.length === 0;
  const canSubmit = grantee !== null && unitValue.length > 0 && !sending;

  async function handleSubmit() {
    const chosen = units.find((u) => u.value === unitValue);
    if (!grantee || !chosen || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: chosen.entityType,
          entityId: chosen.entityId,
          cwid: grantee.cwid,
          role,
          action: "grant",
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapAddError(data.error ?? ""));
        return;
      }
      onGranted(grantee, {
        entityType: chosen.entityType,
        entityId: chosen.entityId,
        unitName: chosen.unitName,
        role,
        source: "manual",
      });
      setOpen(false);
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} data-testid="administrators-add-trigger">
        <UserPlus />
        Add administrator
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="administrators-add-dialog">
          <DialogHeader className="gap-1 text-left">
            <DialogTitle>Add administrator</DialogTitle>
            <DialogDescription>
              Grant a person Owner or Curator access to an org unit.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive" data-testid="administrators-add-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {noUnits ? (
            <p className="text-muted-foreground text-sm" data-testid="administrators-add-no-units">
              No org units are available to grant on yet.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Person</span>
                <DirectoryPeopleTypeahead
                  idPrefix="administrators-add"
                  value={grantee}
                  onChange={setGrantee}
                />
              </div>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Org unit</span>
                <select
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  value={unitValue}
                  onChange={(e) => setUnitValue(e.target.value)}
                  data-testid="administrators-add-unit"
                >
                  <option value="">Select a unit…</option>
                  {units.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Role</span>
                <RadioGroup
                  value={role}
                  onValueChange={(v) => setRole(v as "owner" | "curator")}
                  className="flex gap-4"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="curator" data-testid="administrators-add-role-curator" /> Curator
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="owner" data-testid="administrators-add-role-owner" /> Owner
                  </label>
                </RadioGroup>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="administrators-add-submit"
            >
              {sending ? "Granting…" : "Grant access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
