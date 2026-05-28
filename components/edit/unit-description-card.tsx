/**
 * UnitDescriptionCard — the unit `description` editor (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 1). A plain textarea (descriptions are
 * short prose blurbs, not rich content — the simpler `OverviewCard` plaintext
 * path, not Tiptap), a Save, and a Clear-override action gated on an existing
 * override.
 *
 * Dept/div Save / Clear POST `/api/edit/field` (`{ entityType, entityId,
 * fieldName:"description", value, op }`). A center edits its description in-row:
 * Save POSTs `/api/edit/unit` op:"update" (PR-7b) — centers have no
 * `field_override`, so `canClear` is false and there is no Clear path.
 */
"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Matches `validateUnitFieldValue`'s description cap (manual-layer ≤ 4,000). */
const DESCRIPTION_MAX_CHARS = 4000;

export type UnitDescriptionCardProps = {
  entityType: "department" | "division" | "center";
  entityId: string;
  description: string | null;
  /** False for a center (no field_override — edits in-row). */
  canClear: boolean;
  /** True when a `field_override(description)` row currently exists. */
  hasOverride: boolean;
};

export function UnitDescriptionCard({
  entityType,
  entityId,
  description,
  canClear,
  hasOverride,
}: UnitDescriptionCardProps) {
  const initial = description ?? "";
  const [value, setValue] = React.useState(initial);
  const [saved, setSaved] = React.useState(initial);
  const [overrideExists, setOverrideExists] = React.useState(hasOverride);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const dirty = value !== saved;
  const overLimit = value.length > DESCRIPTION_MAX_CHARS;

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
                fieldName: "description",
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
                fieldName: "description",
                value,
              }),
            });
      const data = (await res.json()) as
        | { ok: true; value: string }
        | { ok: false; error: string };
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
      body: JSON.stringify({ op: "clear", entityType, entityId, fieldName: "description" }),
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
    <Card data-slot="unit-description-card">
      <CardHeader>
        <CardTitle>Description</CardTitle>
        <CardDescription>
          A short blurb shown on the public {entityType} page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          aria-label="Description"
          value={value}
          rows={6}
          onChange={(e) => {
            setValue(e.target.value);
            if (justSaved) setJustSaved(false);
            if (error) setError(null);
          }}
          data-testid="unit-description-textarea"
        />
        <div className="flex items-center justify-between gap-3">
          <span
            aria-live="polite"
            className={cn(
              "text-sm tabular-nums",
              overLimit ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {value.length.toLocaleString()}/{DESCRIPTION_MAX_CHARS.toLocaleString()}
          </span>
          <div className="flex items-center gap-3">
            {justSaved && (
              <span
                role="status"
                aria-live="polite"
                className="text-primary inline-flex items-center gap-1 text-sm"
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
                data-testid="unit-description-clear"
              >
                Clear override
              </Button>
            )}
            <Button
              type="button"
              onClick={save}
              disabled={!dirty || overLimit || isSaving}
              data-testid="unit-description-save"
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear the description override?"
        description="Clearing the override lets the upstream value (if any) show through."
        reasonMode="none"
        confirmLabel="Clear override"
        confirmVariant="default"
        onConfirm={clearOverride}
      />
    </Card>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this unit. Refresh the page and try again.";
    case "description_too_long":
    case "invalid_value":
      return "We couldn't save that description. Trim unusual formatting and try again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
