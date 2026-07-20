/**
 * UnitNameCard — the unit display-name editor.
 *
 * Renames a unit whose name SPS owns: a center (always manually owned — no ETL
 * writes `Center.name`) or a manually-created division (`source='manual'`).
 * An ED-sourced division or any department is NOT renamable here — the
 * directory owns those names and the next `etl/ed` run would overwrite the
 * edit — so the page does not render this card for them.
 *
 * Save POSTs `/api/edit/unit` op:"update" `{ fieldName: "name" }` — unit fields
 * edit in-row, not via `field_override` (#553), so the change is live
 * immediately on the unit page and `/browse`.
 *
 * The name is deliberately decoupled from the URL: renaming does NOT move the
 * slug, matching the seed data's "slugs kept stable across renames to preserve
 * URLs". The Profile URL card edits that separately and is Superuser-only.
 *
 * Adapted from `components/edit/unit-slug-card.tsx`, minus the override/clear
 * machinery — a unit name is a single column with no pending-ETL flavor.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateUnitName } from "@/lib/edit/validators";

export type UnitNameCardProps = {
  entityType: "center" | "division";
  /** The unit code (the API request's `entityId`). */
  entityId: string;
  /** The unit's current `name` column. */
  name: string;
};

type FormatError = "invalid_name" | "name_too_long";
type SaveError = "unknown";

export function UnitNameCard({ entityType, entityId, name }: UnitNameCardProps) {
  const router = useRouter();

  const [savedName, setSavedName] = React.useState(name);
  const [inputValue, setInputValue] = React.useState(name);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<SaveError | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Same validator the server runs — one source of truth for the length cap.
  const trimmed = inputValue.trim();
  const result = trimmed.length === 0 ? null : validateUnitName(trimmed);
  // validateUnitName's error union widens to string at the boundary; it only
  // ever emits these two codes.
  const formatError: FormatError | null =
    result && !result.ok ? (result.error as FormatError) : null;

  const dirty = inputValue !== savedName;
  const canSave = !saving && dirty && result !== null && result.ok;

  function handleInputChange(value: string) {
    setInputValue(value);
    if (saveError) setSaveError(null);
    if (saved) setSaved(false);
  }

  async function handleSave() {
    if (!canSave || result === null || !result.ok) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch("/api/edit/unit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "update",
          entityType,
          entityId,
          fieldName: "name",
          value: result.value,
        }),
      });
      // Check status BEFORE parsing: a bodyless 401 (session expiry) or an edge
      // error page is not JSON, and parsing first would throw past the error
      // handling and leave the card looking saved.
      if (!res.ok) {
        setSaveError("unknown");
        return;
      }
      const data = (await res.json()) as
        | { ok: true; fieldName: string; value: string }
        | { ok: false; error: string };
      if (data.ok !== true) {
        setSaveError("unknown");
        return;
      }
      setSavedName(data.value);
      setInputValue(data.value);
      setSaved(true);
      router.refresh();
    } catch {
      setSaveError("unknown");
    } finally {
      setSaving(false);
    }
  }

  return (
    <EditPanel
      slot="unit-name-card"
      heading="Name"
      description="The unit's display name, shown on its page, in search, and on browse. Changing it does not change the URL."
    >
      <UnsavedChangesGuard dirty={dirty} />
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="unit-name-card-input" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="unit-name-card-input"
            type="text"
            value={inputValue}
            onChange={(e) => handleInputChange(e.target.value)}
            aria-invalid={formatError !== null}
            aria-describedby={formatError ? "unit-name-card-format-error" : undefined}
            autoComplete="off"
            data-testid="unit-name-card-input"
          />
          {formatError && (
            <p
              id="unit-name-card-format-error"
              role="alert"
              className="text-destructive text-sm"
              data-testid="unit-name-card-format-error"
            >
              {formatErrorMessage(formatError)}
            </p>
          )}
        </div>

        <div>
          <Button
            type="button"
            variant="apollo"
            onClick={handleSave}
            disabled={!canSave}
            data-testid="unit-name-card-save"
          >
            {saving ? "Saving…" : "Save name"}
          </Button>
        </div>

        {saveError === "unknown" && (
          <Alert variant="destructive" data-testid="unit-name-card-unknown-error">
            <AlertDescription>
              We couldn&apos;t save the name. Please try again.
            </AlertDescription>
          </Alert>
        )}
        {saved && (
          <Alert variant="info" data-testid="unit-name-card-success">
            <AlertDescription>
              Live now. Search results update on the next nightly index rebuild.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </EditPanel>
  );
}

function formatErrorMessage(error: FormatError): string {
  switch (error) {
    case "name_too_long":
      return "Use 255 characters or fewer.";
    case "invalid_name":
      return "Enter a name.";
  }
}
