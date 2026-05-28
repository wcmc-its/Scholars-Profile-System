/**
 * UnitSlugCard — the unit "Profile URL" editor (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 5). Superuser-only. Adapts the structure of
 * `components/edit/slug-card.tsx` (the scholar card) to the two unit write
 * paths, which differ in *both* mechanism and latency:
 *
 *   - **center** — the slug is a column, edited in-row via `/api/edit/unit`
 *     op:"update". The change is **live immediately** (old + new `/centers/{slug}`
 *     revalidate); the card shows "Live now". A center has no `field_override`,
 *     so there is no override to clear and a colliding slug is rejected at write
 *     time (`slug_taken` → 400).
 *   - **dept/div** — the slug is written as a `field_override(slug)` row via
 *     `/api/edit/field`. The ETL consults it on the next `etl/ed` run, so the URL
 *     flip is **pending** (card shows "Pending — applies on the next nightly
 *     ETL"). A colliding override is *not* rejected here — the ETL's
 *     collision-suffix pipeline resolves it — so there is no live collision
 *     error on this path. "Clear override" (op:"clear") is available when an
 *     override is active.
 *
 * Format validation runs client-side via `validateSlugFormat` (the same function
 * the server uses — one source of truth for the slug-policy regex, #497 PR-1).
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { validateSlugFormat, type SlugFormatResult } from "@/lib/edit/validators";

/** Public-URL prefix shown next to the input, per unit type. */
const URL_PREFIX: Record<UnitSlugCardProps["entityType"], string> = {
  department: "/departments/",
  division: "…/divisions/",
  center: "/centers/",
};

export type UnitSlugCardProps = {
  entityType: "department" | "division" | "center";
  /** The unit code (the API requests' `entityId`). */
  entityId: string;
  /** The live public slug — the unit's `slug` column. */
  liveSlug: string;
  /** dept/div: the current `field_override(slug)` value, else null. Always null
   *  for a center (no override — the input edits the column directly). */
  initialOverride: string | null;
};

type FormatError = "format" | "too_long" | "reserved";
type SaveError = "collision" | "unknown";
type SaveSuccess = "live" | "pending" | "cleared";

export function UnitSlugCard({ entityType, entityId, liveSlug, initialOverride }: UnitSlugCardProps) {
  const router = useRouter();
  const isCenter = entityType === "center";

  // Center: the input edits the live column. Dept/div: the input edits the
  // override, with the column shown read-only as the current URL.
  const [liveSlugState, setLiveSlugState] = React.useState(liveSlug);
  const [override, setOverride] = React.useState<string | null>(initialOverride);
  const [inputValue, setInputValue] = React.useState<string>(
    isCenter ? liveSlug : (initialOverride ?? ""),
  );
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = React.useState(false);
  const [saveError, setSaveError] = React.useState<SaveError | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<SaveSuccess | null>(null);

  const trimmed = inputValue.trim();
  const formatResult: SlugFormatResult | null =
    trimmed.length === 0 ? null : validateSlugFormat(trimmed);
  const formatError: FormatError | null =
    formatResult && !formatResult.ok ? formatResult.error : null;

  const baseline = isCenter ? liveSlugState : (override ?? "");
  const dirty = inputValue !== baseline;
  const canSave = !saving && dirty && formatResult !== null && formatResult.ok && trimmed.length > 0;

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
      const res = isCenter
        ? await fetch("/api/edit/unit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              op: "update",
              entityType,
              entityId,
              fieldName: "slug",
              value: formatResult.value,
            }),
          })
        : await fetch("/api/edit/field", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              op: "set",
              entityType,
              entityId,
              fieldName: "slug",
              value: formatResult.value,
            }),
          });
      const data = (await res.json()) as
        | { ok: true; fieldName: string; value: string }
        | { ok: false; error: string; field?: string };
      if (!res.ok || data.ok !== true) {
        const code = "error" in data ? data.error : "unknown";
        // Only the center path rejects a collision at write time.
        setSaveError(code === "slug_taken" || code === "collision" ? "collision" : "unknown");
        return;
      }
      if (isCenter) {
        setLiveSlugState(data.value);
        setInputValue(data.value);
        setSaveSuccess("live");
      } else {
        setOverride(data.value);
        setInputValue(data.value);
        setSaveSuccess("pending");
      }
      router.refresh();
    } catch {
      setSaveError("unknown");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (isCenter || override === null || clearing) return;
    setSaveError(null);
    setSaveSuccess(null);
    setClearing(true);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "clear", entityType, entityId, fieldName: "slug" }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
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

  const currentSlug = isCenter ? liveSlugState : (override ?? liveSlug);
  const prefix = URL_PREFIX[entityType];

  return (
    <Card data-slot="unit-slug-card">
      <UnsavedChangesGuard dirty={dirty} />
      <CardHeader>
        <CardTitle>Profile URL</CardTitle>
        <CardDescription>
          {isCenter
            ? "Set the URL segment for this center. The change takes effect immediately; the old URL redirects to the new one."
            : "Override the directory-derived URL segment. The change applies on the next nightly ETL run."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="text-muted-foreground">Current URL: </span>
          <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
            {prefix}
            {currentSlug}
          </code>
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor="unit-slug-card-input" className="text-sm font-medium">
            URL segment
          </label>
          <div className="flex items-center gap-2">
            <span
              className="text-muted-foreground select-none whitespace-nowrap text-sm"
              data-slot="slug-prefix"
            >
              {prefix}
            </span>
            <Input
              id="unit-slug-card-input"
              type="text"
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              aria-invalid={formatError !== null}
              aria-describedby={formatError ? "unit-slug-card-format-error" : undefined}
              autoComplete="off"
              spellCheck={false}
              data-testid="unit-slug-card-input"
            />
          </div>
          {formatError && (
            <p
              id="unit-slug-card-format-error"
              role="alert"
              className="text-destructive text-sm"
              data-testid="unit-slug-card-format-error"
            >
              {formatErrorMessage(formatError)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              data-testid="unit-slug-card-save"
            >
              {saving ? "Saving…" : "Save URL"}
            </Button>
            {!isCenter && override !== null && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setClearConfirmOpen(true)}
                disabled={clearing || saving}
                data-testid="unit-slug-card-clear"
              >
                {clearing ? "Clearing…" : "Clear override"}
              </Button>
            )}
          </div>
        </div>

        {saveError === "collision" && (
          <Alert variant="destructive" data-testid="unit-slug-card-collision">
            <AlertDescription>That URL is already in use.</AlertDescription>
          </Alert>
        )}
        {saveError === "unknown" && (
          <Alert variant="destructive" data-testid="unit-slug-card-unknown-error">
            <AlertDescription>We couldn&apos;t save the URL. Please try again.</AlertDescription>
          </Alert>
        )}
        {saveSuccess === "live" && (
          <Alert variant="info" data-testid="unit-slug-card-live-success">
            <AlertDescription>
              Live now: <code>{prefix}{liveSlugState}</code> — the old URL redirects to it
              automatically.
            </AlertDescription>
          </Alert>
        )}
        {saveSuccess === "pending" && (
          <Alert variant="info" data-testid="unit-slug-card-pending-success">
            <AlertDescription>
              Override saved. <code>{prefix}{override}</code> applies on the next nightly ETL run.
            </AlertDescription>
          </Alert>
        )}
        {saveSuccess === "cleared" && (
          <Alert variant="info" data-testid="unit-slug-card-cleared-success">
            <AlertDescription>
              Override cleared. The directory-derived URL applies on the next nightly ETL run.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="Clear the slug override?"
        description="The URL reverts to the directory-derived value on the next nightly ETL run."
        reasonMode="none"
        confirmLabel="Clear override"
        confirmVariant="default"
        onConfirm={handleClear}
      />
    </Card>
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
