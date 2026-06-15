/**
 * UnitUrlCard — the unit `url` editor (#1021). A single-line URL input, a Save,
 * and a Clear-override action gated on an existing override. Mirrors
 * `UnitDescriptionCard` exactly (same save/clear/error/optimistic patterns and
 * the same POST paths) — the only differences are the single-line input, the
 * "Website" label, and the `url` field name.
 *
 * Dept/div Save / Clear POST `/api/edit/field` (`{ entityType, entityId,
 * fieldName:"url", value, op }`). A center edits its URL in-row: Save POSTs
 * `/api/edit/unit` op:"update" — centers have no `field_override`, so `canClear`
 * is false and there is no Clear path.
 */
"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Matches `validateUnitUrl`'s cap (the `@db.VarChar(512)` column). */
const URL_MAX_CHARS = 512;

export type UnitUrlCardProps = {
  entityType: "department" | "division" | "center";
  entityId: string;
  url: string | null;
  /** False for a center (no field_override — edits in-row). */
  canClear: boolean;
  /** True when a `field_override(url)` row currently exists. */
  hasOverride: boolean;
};

export function UnitUrlCard({
  entityType,
  entityId,
  url,
  canClear,
  hasOverride,
}: UnitUrlCardProps) {
  const initial = url ?? "";
  const [value, setValue] = React.useState(initial);
  const [saved, setSaved] = React.useState(initial);
  const [overrideExists, setOverrideExists] = React.useState(hasOverride);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const dirty = value !== saved;
  const overLimit = value.length > URL_MAX_CHARS;

  async function save() {
    if (!dirty || overLimit || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      // Centers edit in-row via /api/edit/unit op:"update" (no field_override);
      // dept/div write a field_override row via /api/edit/field.
      const res =
        entityType === "center"
          ? await fetch("/api/edit/unit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                op: "update",
                entityType,
                entityId,
                fieldName: "url",
                value,
              }),
            })
          : await fetch("/api/edit/field", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                op: "set",
                entityType,
                entityId,
                fieldName: "url",
                value,
              }),
            });
      const data = (await res.json()) as { ok: true; value: string } | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage("error" in data ? data.error : ""));
        return;
      }
      setSaved(data.value);
      setValue(data.value);
      setOverrideExists(true);
      setJustSaved(true);
    } catch {
      setError(mapErrorToMessage(""));
    } finally {
      setIsSaving(false);
    }
  }

  async function clearOverride() {
    setError(null);
    const res = await fetch("/api/edit/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "clear", entityType, entityId, fieldName: "url" }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
      throw new Error("clear_failed"); // keeps the dialog open
    }
    // The upstream (ETL) value now shows through; we don't know it client-side,
    // so blank the editor and let the next page load re-seed it.
    setOverrideExists(false);
    setConfirmOpen(false);
    setJustSaved(true);
  }

  return (
    <EditPanel
      slot="unit-url-card"
      heading="Website"
      description={`An optional link shown beside the ${entityType} name on its public page.`}
    >
      <div className="flex flex-col gap-3">
        <Input
          type="url"
          inputMode="url"
          aria-label="Website"
          placeholder="https://"
          value={value}
          maxLength={URL_MAX_CHARS}
          onChange={(e) => {
            setValue(e.target.value);
            if (justSaved) setJustSaved(false);
            if (error) setError(null);
          }}
          data-testid="unit-url-input"
        />
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
          {canClear && overrideExists && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              disabled={isSaving}
              data-testid="unit-url-clear"
            >
              Clear override
            </Button>
          )}
          <Button
            type="button"
            variant="apollo"
            onClick={save}
            disabled={!dirty || overLimit || isSaving}
            data-testid="unit-url-save"
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

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear the website override?"
        description="Clearing the override lets the upstream value (if any) show through."
        reasonMode="none"
        confirmLabel="Clear override"
        confirmVariant="default"
        onConfirm={clearOverride}
      />
    </EditPanel>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this unit. Refresh the page and try again.";
    case "url_too_long":
    case "invalid_url":
    case "invalid_value":
      return "That doesn't look like a valid https:// web address. Check it and try again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
