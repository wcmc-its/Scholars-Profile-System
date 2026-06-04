/**
 * CenterTypeCard — the center `centerType` editor (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 6). Superuser-only, centers only: a radio
 * between `center` and `institute`. A center's type can change post-creation
 * (an informal initiative gets institute-level recognition), so this is a
 * standalone attribute rather than a create-form-only choice.
 *
 * Save POSTs `/api/edit/unit` op:"update" `{ fieldName:"centerType" }` — center
 * fields edit in-row, not via `field_override` (#553). `centerType:"institute"`
 * is Superuser-only even at create, so an Owner never sees this card (the rail
 * filters it out).
 */
"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type CenterType = "center" | "institute";

export type CenterTypeCardProps = {
  /** The center's synthetic code (the API request's `entityId`). */
  entityId: string;
  centerType: CenterType;
};

export function CenterTypeCard({ entityId, centerType }: CenterTypeCardProps) {
  const [value, setValue] = React.useState<CenterType>(centerType);
  const [saved, setSaved] = React.useState<CenterType>(centerType);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  const dirty = value !== saved;

  async function save() {
    if (!dirty || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/unit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "update",
          entityType: "center",
          entityId,
          fieldName: "centerType",
          value,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; fieldName: string; value: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage("error" in data ? data.error : ""));
        return;
      }
      setSaved(value);
      setJustSaved(true);
    } catch {
      setError(mapErrorToMessage(""));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <EditPanel
      slot="center-type-card"
      heading="Center type"
      description="Whether this unit is presented as a center or an institute."
    >
      <div className="flex flex-col gap-4">
        <RadioGroup
          value={value}
          onValueChange={(v) => {
            setValue(v as CenterType);
            if (justSaved) setJustSaved(false);
            if (error) setError(null);
          }}
          className="flex gap-4"
        >
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="center" data-testid="center-type-center" /> Center
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="institute" data-testid="center-type-institute" /> Institute
          </label>
        </RadioGroup>

        <div className="flex items-center justify-end gap-3">
          {justSaved && (
            <span
              role="status"
              aria-live="polite"
              className="text-apollo-green inline-flex items-center gap-1 text-sm"
            >
              <Check className="size-4" />
              Saved
            </span>
          )}
          <Button
            type="button"
            variant="apollo"
            onClick={save}
            disabled={!dirty || isSaving}
            data-testid="center-type-save"
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </EditPanel>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_superuser":
    case "not_curator":
    case "not_unit_owner":
      return "You no longer have access to this unit. Refresh the page and try again.";
    default:
      return "Something went wrong — your change wasn't saved. Please try again.";
  }
}
