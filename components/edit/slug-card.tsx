/**
 * The slug-override card (#356 Phase 7 C5, UI-SPEC § `/edit/scholar/[cwid]`
 * Card 3 — superuser arm, SPEC § The v1 editable-field set — `slug` row).
 *
 * The superuser-only "Profile URL" card. The live `scholar.slug` is the
 * directory-derived value (`etl/ed`); `slugOverride` (from
 * `field_override(slug)`) is the manual layer. The card lets a superuser:
 *
 *   1. Set a new override (`POST /api/edit/field` with `fieldName: 'slug'`).
 *   2. Clear an existing override (`POST /api/edit/clear-field` — Phase 7 C1).
 *
 * Live format validation runs client-side via `validateSlugFormat` (the same
 * function the server uses — single source of truth for the format rule). A
 * **collision** is *not* checked live (UI-SPEC Open Question #4 — fast-follow);
 * it surfaces on Save via the server `400 collision`.
 *
 * The card mounts an `UnsavedChangesGuard` whose `dirty` bit is `inputValue
 * !== initialOverride` — typing-then-navigating-away triggers the confirm.
 *
 * Endpoints (Phase 2 / Phase 7 C1):
 *   POST /api/edit/field        { entityType, entityId, fieldName: 'slug', value }
 *   POST /api/edit/clear-field  { entityType, entityId, fieldName: 'slug' }
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateSlugFormat, type SlugFormatResult } from "@/lib/edit/validators";

export type SlugCardProps = {
  /** The target scholar's cwid (the API requests' `entityId`). */
  cwid: string;
  /**
   * The live `scholar.slug` — the URL segment the profile resolves at today.
   * Display only; not editable here. Under reconcile-on-write (ADR-005
   * Amendment 2, D5) a successful override updates `Scholar.slug` in the same
   * transaction, so this equals the override when one is active; the change is
   * immediate and the prior slug 301-redirects via `slug_history`.
   */
  liveSlug: string;
  /**
   * The current `field_override(slug)` value — `null` when no override is
   * active. Server-fetched at page load (`loadEditContext` § Phase 7 §2).
   */
  initialOverride: string | null;
};

type FormatError = "format" | "too_long" | "reserved";
type SaveError = "collision" | "unknown";
type SaveSuccess = "set" | "cleared";

export function SlugCard({ cwid, liveSlug, initialOverride }: SlugCardProps) {
  const router = useRouter();
  const [override, setOverride] = React.useState<string | null>(initialOverride);
  const [inputValue, setInputValue] = React.useState<string>(initialOverride ?? "");
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = React.useState(false);
  const [saveError, setSaveError] = React.useState<SaveError | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<SaveSuccess | null>(null);

  // Empty input is not a "format error" — it just means there's no value to
  // save. Treat it like the pristine state: Save is disabled because dirty
  // is false (matches override === null) or because the value is empty.
  const trimmed = inputValue.trim();
  const formatResult: SlugFormatResult | null = trimmed.length === 0 ? null : validateSlugFormat(trimmed);
  const formatError: FormatError | null = formatResult && !formatResult.ok ? formatResult.error : null;

  const dirty = inputValue !== (override ?? "");

  // Saving is enabled iff there's a non-empty validly-formatted slug different
  // from the active override. (Use the validated/normalized value when sending.)
  const canSave =
    !saving && dirty && formatResult !== null && formatResult.ok && trimmed.length > 0;

  function handleInputChange(value: string) {
    setInputValue(value);
    if (saveError) setSaveError(null);
    if (saveSuccess) setSaveSuccess(null);
  }

  async function handleSave() {
    if (!canSave || formatResult === null || !formatResult.ok) return;
    setSaveError(null);
    setSaveSuccess(null);
    setSaving(true);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "slug",
          value: formatResult.value,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; fieldName: string; value: string }
        | { ok: false; error: string; field?: string };
      if (!res.ok || data.ok !== true) {
        const code = "error" in data ? data.error : "unknown";
        setSaveError(code === "collision" ? "collision" : "unknown");
        return;
      }
      // Server normalizes (lowercase, trim). Track the server's value as the
      // new dirty baseline.
      setOverride(data.value);
      setInputValue(data.value);
      setSaveSuccess("set");
      router.refresh();
    } catch {
      setSaveError("unknown");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (override === null || clearing) return;
    setSaveError(null);
    setSaveSuccess(null);
    setClearing(true);
    try {
      const res = await fetch("/api/edit/clear-field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "slug",
        }),
      });
      const data = (await res.json()) as
        | { ok: true; fieldName: string; cleared: boolean }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setSaveError("unknown");
        return;
      }
      setOverride(null);
      setInputValue("");
      setSaveSuccess("cleared");
      setClearConfirmOpen(false);
      router.refresh();
    } catch {
      setSaveError("unknown");
    } finally {
      setClearing(false);
    }
  }

  return (
    <EditPanel
      slot="slug-card"
      heading="Profile URL"
      description="Override the directory-derived URL segment. The change takes effect immediately; the old URL redirects to the new one automatically. The short form scholars.weill.cornell.edu/<segment> and the longer /scholars/<segment> both lead to the same page."
    >
      <UnsavedChangesGuard dirty={dirty} />
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="text-muted-foreground">Current URL: </span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            /scholars/{override ?? liveSlug}
          </code>
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor="slug-card-input" className="text-sm font-medium">
            URL segment
          </label>
          <div className="flex items-center gap-2">
            <span
              className="text-muted-foreground select-none whitespace-nowrap text-sm"
              data-slot="slug-prefix"
            >
              /scholars/
            </span>
            <Input
              id="slug-card-input"
              type="text"
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              aria-invalid={formatError !== null}
              aria-describedby={formatError ? "slug-card-format-error" : undefined}
              autoComplete="off"
              spellCheck={false}
              data-testid="slug-card-input"
            />
          </div>
          {formatError && (
            <p
              id="slug-card-format-error"
              role="alert"
              className="text-destructive text-sm"
              data-testid="slug-card-format-error"
            >
              {formatErrorMessage(formatError)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="apollo"
              onClick={handleSave}
              disabled={!canSave}
              data-testid="slug-card-save"
            >
              {saving ? "Saving…" : "Save URL"}
            </Button>
            {override !== null && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setClearConfirmOpen(true)}
                disabled={clearing || saving}
                data-testid="slug-card-clear"
              >
                {clearing ? "Clearing…" : "Clear override"}
              </Button>
            )}
          </div>
        </div>

        {saveError === "collision" && (
          <Alert variant="destructive" data-testid="slug-card-collision">
            <AlertDescription>That URL is already in use.</AlertDescription>
          </Alert>
        )}
        {saveError === "unknown" && (
          <Alert variant="destructive" data-testid="slug-card-unknown-error">
            <AlertDescription>
              We couldn&apos;t save the URL. Please try again.
            </AlertDescription>
          </Alert>
        )}
        {saveSuccess === "set" && override !== null && (
          <Alert variant="info" data-testid="slug-card-set-success">
            <AlertDescription>
              Override saved: <code>/scholars/{override}</code> is now live — the
              old URL redirects to it automatically.
            </AlertDescription>
          </Alert>
        )}
        {saveSuccess === "cleared" && (
          <Alert variant="info" data-testid="slug-card-cleared-success">
            <AlertDescription>
              Override cleared. The URL is now <code>/scholars/{liveSlug}</code>{" "}
              — the old URL redirects to it automatically.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="Clear the slug override?"
        description="The profile URL reverts to the directory-derived value, effective immediately. The old URL will redirect to it automatically."
        reasonMode="none"
        confirmLabel="Clear override"
        confirmVariant="default"
        onConfirm={handleClear}
      />
    </EditPanel>
  );
}

function formatErrorMessage(error: FormatError): string {
  switch (error) {
    case "too_long":
      return "Use 64 characters or fewer.";
    case "reserved":
      return "That URL segment is reserved — please choose another.";
    case "format":
      return "Use lowercase letters, numbers, and hyphens only — no leading or trailing hyphen, no double hyphens.";
  }
}
