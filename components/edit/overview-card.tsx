/**
 * The Overview card (#356 Phase 6 C5 / Phase 7 C3, UI-SPEC § `/edit` Card 1
 * + § `/edit/scholar/[cwid]` Card 1 superuser arm).
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
 *
 * Phase 7 — the `readOnly` arm. The superuser surface
 * (`/edit/scholar/[other-cwid]`) renders the merged sanitized HTML through a
 * `prose prose-sm` div with no toolbar, no Save, no counter, no unsaved-guard.
 * The read-only branch is a separate sub-component so the editor's hooks /
 * fetch path never initialize on a surface that doesn't use them, keeping the
 * non-editor render clean (a future dynamic-import of `OverviewEditor` would
 * harden the bundle isolation — fast-follow per the Phase 7 plan §12).
 *
 * #742 — the overview-statement generator. Behind `generateEnabled` (the SELF
 * arm only), the editor exposes "Generate a draft" / "Regenerate", which POST
 * `/api/edit/overview/generate` and seed the returned draft into the editor as
 * *unsaved* content (`overview-statement-generator-spec.md` § The generate flow
 * + § States & edge cases G1–G9). The generator never writes the DB; the
 * existing Save path is what publishes the (now-dirty) draft. A new draft
 * re-seeds the editor by bumping `editorKey` against a `seedHtml` distinct from
 * `savedHtml`, so Discard still reverts to the last-saved bio (not the draft).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Check, RefreshCw, Sparkles } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { OverviewEditor } from "@/components/edit/overview-editor";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The hard cap on stored sanitized HTML (`self-edit-spec.md` § overview). */
const OVERVIEW_MAX_CHARS = 20000;

// #742 generator copy — verbatim from
// `overview-statement-generator-spec.md` § Copy (initial). Kept as named
// constants so the strings live in one place and the tests assert against them.
const GENERATE_BANNER =
  "Draft generated from your Scholars data. Review and edit it before saving — nothing is published until you save.";
const GENERATE_SPARSE =
  "We don't have enough of your work indexed to draft an overview yet. You can write your own, or review My Publications first.";
const GENERATE_RATE_LIMITED =
  "You've generated several drafts recently — please try again in a little while.";
const GENERATE_FAILED = "We couldn't generate a draft just now. Please try again.";
const REGENERATE_CONFIRM = "Replace your current text with a new draft? Your edits will be lost.";

export type OverviewCardProps = {
  cwid: string;
  initialHtml: string;
  /**
   * The public profile URL (by slug). When set, a successful save shows a
   * persistent "Saved — live. View it →" confirmation that links here in the
   * same tab, closing the edit → preview → live loop (vision-round T3.1).
   */
  previewHref?: string;
  /**
   * The superuser-mode read-only render (#356 Phase 7 C3, UI-SPEC § Card 1
   * superuser arm). When true, the card displays the merged sanitized bio
   * with no editor / toolbar / Save / counter / unsaved-guard, and the
   * description copy explains why the bio is uneditable here.
   */
  readOnly?: boolean;
  /**
   * Whether the #742 overview-statement generator is available on this surface
   * (`SELF_EDIT_OVERVIEW_GENERATE`). Passed true only on the SELF arm — an
   * owner generating their own draft. Off ⇒ no Generate/Regenerate affordance
   * and the editor behaves exactly as the Phase 6 surface did.
   */
  generateEnabled?: boolean;
};

export function OverviewCard({
  cwid,
  initialHtml,
  previewHref,
  readOnly = false,
  generateEnabled = false,
}: OverviewCardProps) {
  if (readOnly) return <OverviewReadOnlyCard initialHtml={initialHtml} />;
  return (
    <OverviewEditorCard
      cwid={cwid}
      initialHtml={initialHtml}
      previewHref={previewHref}
      generateEnabled={generateEnabled}
    />
  );
}

// ---------------------------------------------------------------------------
// Read-only arm — superuser viewing another scholar's bio.
// ---------------------------------------------------------------------------

function OverviewReadOnlyCard({ initialHtml }: { initialHtml: string }) {
  // initialHtml arrives from `loadEditContext` → `getEffectiveOverview`, which
  // re-sanitises the stored override on read via `sanitizeOverviewHtml`
  // (DOMPurify). This is the same render path the public profile uses; the
  // dangerouslySetInnerHTML below is the documented trust boundary.
  const hasBio = initialHtml.trim().length > 0;
  return (
    <EditPanel
      slot="overview-card"
      heading="Overview"
      description="Only the profile owner can edit the bio."
    >
      {hasBio ? (
        <div
          className="prose prose-sm border-apollo-border bg-apollo-surface-2 rounded-md border px-4 py-3"
          dangerouslySetInnerHTML={{ __html: initialHtml }}
          data-slot="overview-readonly"
        />
      ) : (
        <p className="text-muted-foreground text-sm" data-slot="overview-readonly-empty">
          No bio yet.
        </p>
      )}
    </EditPanel>
  );
}

// ---------------------------------------------------------------------------
// Editor arm — self mode (the Phase 6 surface, unchanged behavior).
// ---------------------------------------------------------------------------

type OverviewEditorCardProps = Pick<
  OverviewCardProps,
  "cwid" | "initialHtml" | "previewHref" | "generateEnabled"
>;

function OverviewEditorCard({
  cwid,
  initialHtml,
  previewHref,
  generateEnabled = false,
}: OverviewEditorCardProps) {
  const [currentHtml, setCurrentHtml] = React.useState(initialHtml);
  const [savedHtml, setSavedHtml] = React.useState(initialHtml);
  // What the editor seeds from on (re)mount. Defaults to the saved bio; a
  // generated draft swaps it to the draft so the editor re-seeds with that text
  // while `savedHtml` stays the last-published value (so Discard reverts there,
  // not to the draft — spec G3 keeps the saved bio recoverable).
  const [seedHtml, setSeedHtml] = React.useState(initialHtml);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  // Bumping this remounts OverviewEditor, re-seeding it from seedHtml — the
  // mechanism behind Discard and behind injecting a generated draft (Tiptap has
  // no controlled-value prop).
  const [editorKey, setEditorKey] = React.useState(0);

  // #742 generator UI state. `generated` tracks whether a draft has been seeded
  // this session (drives Generate→Regenerate), `lastGeneratedDraft` is the exact
  // text last seeded (so a regenerate-over-manual-edits confirm can tell a draft
  // apart from the scholar's own edits, spec G3).
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [generated, setGenerated] = React.useState(false);
  const [lastGeneratedDraft, setLastGeneratedDraft] = React.useState<string | null>(null);
  const [generateNotice, setGenerateNotice] = React.useState<string | null>(null);
  const [generateError, setGenerateError] = React.useState<string | null>(null);

  const dirty = currentHtml !== savedHtml;
  const overLimit = currentHtml.length > OVERVIEW_MAX_CHARS;
  // Hide Generate when the scholar already has a non-empty saved bio (spec G9 —
  // don't invite clobbering good content); only Regenerate, behind a confirm.
  const hasExistingBio = initialHtml.trim().length > 0;

  function handleEditorChange(html: string) {
    setCurrentHtml(html);
    // The "Saved — live" confirmation persists across keystrokes and clears
    // only on the next save (vision-round T3.1) — re-editing doesn't un-publish
    // the last-saved bio.
    if (error) setError(null);
    if (generateError) setGenerateError(null);
  }

  function discard() {
    setCurrentHtml(savedHtml);
    setSeedHtml(savedHtml);
    setEditorKey((k) => k + 1);
    if (error) setError(null);
    if (generateError) setGenerateError(null);
    setGenerateNotice(null);
  }

  async function generate() {
    if (isGenerating || isSaving) return;
    // Regenerating over edits the scholar made (text that matches neither the
    // saved bio nor the draft we last seeded) prompts a confirm before we
    // replace it (spec G3).
    if (
      generated &&
      currentHtml !== savedHtml &&
      currentHtml !== (lastGeneratedDraft ?? "") &&
      !window.confirm(REGENERATE_CONFIRM)
    ) {
      return;
    }
    setIsGenerating(true);
    setGenerateError(null);
    setGenerateNotice(null);
    try {
      const res = await fetch("/api/edit/overview/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: cwid }),
      });
      const data = (await res.json()) as
        | { ok: true; draft: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        // Editor is left untouched on any failure (spec G8) — only a notice or
        // error appears.
        const code = "error" in data && typeof data.error === "string" ? data.error : "";
        if (code === "insufficient_facts") {
          setGenerateNotice(GENERATE_SPARSE);
        } else if (code === "rate_limited") {
          setGenerateError(GENERATE_RATE_LIMITED);
        } else {
          setGenerateError(GENERATE_FAILED);
        }
        return;
      }
      // Seed the draft as UNSAVED content: re-seed the editor from the draft and
      // mark the card dirty so the existing Save publishes it. `savedHtml` is
      // untouched, so Discard still reverts to the last-saved bio.
      setSeedHtml(data.draft);
      setCurrentHtml(data.draft);
      setLastGeneratedDraft(data.draft);
      setGenerated(true);
      setGenerateNotice(GENERATE_BANNER);
      setEditorKey((k) => k + 1);
      if (error) setError(null);
    } catch {
      setGenerateError(GENERATE_FAILED);
    } finally {
      setIsGenerating(false);
    }
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
      // The saved value is now the editor's seed baseline too, so a later
      // Discard reverts here rather than to a stale draft (spec G4). The draft
      // origin no longer matters once the scholar has published their text.
      setSeedHtml(data.value);
      setJustSaved(true);
      setGenerateNotice(null);
      setLastGeneratedDraft(null);
      setGenerated(false);
    } catch {
      setError("Something went wrong — your changes weren't saved. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <EditPanel
      slot="overview-card"
      heading="Overview"
      owned
      description="A short bio shown at the top of your public profile."
    >
      <UnsavedChangesGuard dirty={dirty} />
      {generateEnabled && (
        <div className="flex flex-wrap items-center gap-3">
          {hasExistingBio || generated ? (
            <Button
              type="button"
              variant="outline"
              onClick={generate}
              disabled={isGenerating || isSaving}
              data-testid="overview-regenerate"
            >
              <RefreshCw className="size-4" />
              {isGenerating ? "Generating…" : "Regenerate"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={generate}
              disabled={isGenerating || isSaving}
              data-testid="overview-generate"
            >
              <Sparkles className="size-4" />
              {isGenerating ? "Generating…" : "Generate a draft"}
            </Button>
          )}
          <span className="text-muted-foreground text-sm">
            Draft from your Scholars publications, topics, and grants — you review and edit it.
          </span>
        </div>
      )}
      {generateNotice && (
        <Alert data-testid="overview-generate-notice">
          <AlertDescription>{generateNotice}</AlertDescription>
        </Alert>
      )}
      {generateError && (
        <Alert variant="destructive" data-testid="overview-generate-error">
          <AlertDescription>{generateError}</AlertDescription>
        </Alert>
      )}
      <div className="max-w-prose">
        <OverviewEditor key={editorKey} initialHtml={seedHtml} onChange={handleEditorChange} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          aria-live="polite"
          className={cn(
            "text-sm tabular-nums",
            overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {currentHtml.length.toLocaleString()}/{OVERVIEW_MAX_CHARS.toLocaleString()}
        </span>
        <div className="flex flex-wrap items-center gap-3">
          {justSaved && (
            <span
              role="status"
              aria-live="polite"
              className="text-apollo-green inline-flex items-center gap-1.5 text-sm"
            >
              <Check className="size-4" />
              Saved — live.
              {previewHref && (
                <Link
                  href={previewHref}
                  className="text-apollo-maroon font-medium underline underline-offset-2"
                >
                  View it →
                </Link>
              )}
            </span>
          )}
          {dirty && (
            <Button
              type="button"
              variant="outline"
              onClick={discard}
              disabled={isSaving}
              data-testid="overview-discard"
            >
              Discard
            </Button>
          )}
          <Button
            type="button"
            variant="apollo"
            onClick={save}
            disabled={!dirty || overLimit || isSaving}
            data-testid="overview-save"
          >
            {isSaving ? "Saving…" : "Save bio"}
          </Button>
          <span className="text-muted-foreground text-sm">
            Changes publish to your public profile immediately.
          </span>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </EditPanel>
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
