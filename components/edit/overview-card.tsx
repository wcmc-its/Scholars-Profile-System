/**
 * The Overview card (#356 Phase 6 C5, UI-SPEC § `/edit` Card 1).
 *
 * Wraps `OverviewEditor`, owns Save, and renders the counter + inline
 * success/failure feedback. POSTs `/api/edit/field` (Phase 2 contract,
 * `app/api/edit/field/route.ts`).
 *
 * The counter measures `currentHtml.length` directly — the SPEC's 20,000 cap
 * is on the *stored* sanitized HTML, and the editor emits the same byte shape
 * the server stores (link rel/target attributes are in both). Saved becomes
 * the server's *response* value, not what we sent, so a sanitize-time
 * normalization (a dropped href, a whitespace collapse) updates the dirty
 * baseline correctly.
 */
"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { OverviewEditor } from "@/components/edit/overview-editor";
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
import { cn } from "@/lib/utils";

/** The hard cap on stored sanitized HTML (`self-edit-spec.md` § overview). */
const OVERVIEW_MAX_CHARS = 20000;

export type OverviewCardProps = {
  cwid: string;
  initialHtml: string;
  /**
   * Fires after every state transition that flips the dirty bit:
   * `true` after the first edit, `false` on a successful save or a re-edit
   * back to the saved value. Drives the unsaved-changes guard (C9).
   */
  onDirtyChange?: (dirty: boolean) => void;
};

export function OverviewCard({ cwid, initialHtml, onDirtyChange }: OverviewCardProps) {
  const [currentHtml, setCurrentHtml] = React.useState(initialHtml);
  const [savedHtml, setSavedHtml] = React.useState(initialHtml);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  const dirty = currentHtml !== savedHtml;
  const overLimit = currentHtml.length > OVERVIEW_MAX_CHARS;

  // Propagate dirty changes upward so the unsaved-changes guard sees them.
  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function handleEditorChange(html: string) {
    setCurrentHtml(html);
    // Any edit clears the "Saved" badge (UI-SPEC § Card 1).
    if (justSaved) setJustSaved(false);
    if (error) setError(null);
  }

  async function save() {
    if (!dirty || overLimit || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "overview",
          value: currentHtml,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; fieldName: string; value: string }
        | { ok: false; error: string; field?: string };
      if (!res.ok || data.ok !== true) {
        setError(
          "error" in data && typeof data.error === "string"
            ? mapErrorToMessage(data.error)
            : "Something went wrong — your changes weren't saved. Please try again.",
        );
        return;
      }
      // Server may have normalized the HTML (sanitize, link rewrite). Track
      // the post-sanitize value as the dirty baseline — see file doc-comment.
      setSavedHtml(data.value);
      setJustSaved(true);
    } catch {
      setError("Something went wrong — your changes weren't saved. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card data-slot="overview-card">
      <UnsavedChangesGuard dirty={dirty} />
      <CardHeader>
        <CardTitle>Overview</CardTitle>
        <CardDescription>
          A short bio shown at the top of your public profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <OverviewEditor initialHtml={initialHtml} onChange={handleEditorChange} />
        <div className="flex items-center justify-between gap-3">
          <span
            aria-live="polite"
            className={cn(
              "text-sm tabular-nums",
              overLimit ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {currentHtml.length.toLocaleString()}/{OVERVIEW_MAX_CHARS.toLocaleString()}
          </span>
          <div className="flex items-center gap-3">
            {justSaved && (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1 text-sm text-primary"
              >
                <Check className="size-4" />
                Saved
              </span>
            )}
            <Button
              type="button"
              onClick={save}
              disabled={!dirty || overLimit || isSaving}
              data-testid="overview-save"
            >
              {isSaving ? "Saving…" : "Save bio"}
            </Button>
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Map a server error code to the user-facing string. Most errors here are
 * surprises (the route's per-field validation runs server-side and re-validates
 * what the editor schema already constrains), so the default applies broadly.
 */
function mapErrorToMessage(code: string): string {
  switch (code) {
    case "overview_too_long":
      return `Your bio exceeds the ${OVERVIEW_MAX_CHARS.toLocaleString()}-character limit. Trim it and try again.`;
    case "invalid_value":
      return "We couldn't save that bio. Try removing unusual formatting and saving again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
