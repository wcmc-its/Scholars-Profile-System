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
 *
 * #742 v3 — two tabs (decision 1, inline publish). When `generateEnabled`, the
 * Overview surface splits into **Existing** (the plain manual editor — saves as
 * `authored`) and **Generator** ᴮᴱᵀᴬ (controls + Generate + its OWN editor —
 * saves as `generated`/`generated_edited`). Both publish through the same
 * `/api/edit/field`; the shared saved bio + provenance + draft history live in
 * the parent so each tab keeps an independent unsaved draft and one
 * `UnsavedChangesGuard` covers either-tab-dirty. When `generateEnabled` is
 * false (the dark-flag default and every non-self surface), there are NO tabs —
 * the manual editor renders exactly as the Phase 6 surface did, so that path is
 * byte-for-byte unchanged.
 *
 * The generator never writes the published bio. A draft seeds the Generator's
 * editor as UNSAVED content; the existing Save path publishes it. `savedHtml`
 * stays the last-published value, so Discard reverts there (spec G3/G4).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Check, RefreshCw, Sparkles } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { OverviewEditor } from "@/components/edit/overview-editor";
import { OverviewGenerateControls } from "@/components/edit/overview-generate-controls";
import { OverviewProvenanceNote } from "@/components/edit/overview-provenance-note";
import { OverviewSourceDrawer } from "@/components/edit/overview-source-drawer";
import {
  OverviewVersionsPanel,
  type OverviewGenerationItem,
} from "@/components/edit/overview-versions-panel";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  DEFAULT_OVERVIEW_PARAMS,
  type OverviewParams,
  type OverviewSelection,
} from "@/lib/edit/overview-params";
import type { OverviewOrigin } from "@/lib/edit/overview-provenance";
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

/** A fresh, all-empty source selection (before the source-options load). */
const EMPTY_SELECTION: OverviewSelection = { pmids: [], grantIds: [], toolNames: [] };

/** The populated default selection from the source-options' `defaultSelected`
 *  flags (v3.1 — first/last-author scored pubs + PI funding; tools land in C3). */
function selectionFromOptions(options: OverviewSourceOptions): OverviewSelection {
  return {
    pmids: options.publications.filter((p) => p.defaultSelected).map((p) => p.pmid),
    grantIds: options.funding.filter((f) => f.defaultSelected).map((f) => f.id),
    toolNames: [],
  };
}

/** The provenance line shape the GET /api/edit/overview/generations route
 *  serializes (`updatedAt` as an ISO string) — drives {@link OverviewProvenanceNote}. */
type OverviewProvenanceLine = {
  origin: OverviewOrigin;
  model: string | null;
  updatedAt: string;
};

/** The GET /api/edit/overview/generations response (owner-only history + the
 *  currently-saved bio's provenance). `provenance` is null until the owner has
 *  saved at least once with provenance recorded. */
type OverviewGenerationsResponse = {
  generations: OverviewGenerationItem[];
  provenance: OverviewProvenanceLine | null;
};

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
   * with no editor / toolbar / Save / counter / unsaved-guard.
   */
  readOnly?: boolean;
  /**
   * Whether the #742 overview-statement generator is available on this surface
   * (`SELF_EDIT_OVERVIEW_GENERATE`). Passed true only on the SELF arm. Off ⇒ no
   * tabs and no Generate affordance; the editor behaves exactly as the Phase 6
   * surface did.
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
// Editor arm — self mode. One manual surface (Existing); plus, behind the flag,
// the Generator tab (#742 v3). Shared saved bio + provenance + history live
// here so both tabs publish to one field and keep independent drafts.
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
  // The currently-published bio — the dirty baseline shared by both tabs. A Save
  // from either tab updates this (and the other tab's draft is then dirty vs the
  // new value, which is correct: it's an independent candidate).
  const [savedHtml, setSavedHtml] = React.useState(initialHtml);

  // #742 Phase B — draft history + provenance, owner-only. `generations` drives
  // the Versions panel; `provenance` is the one-line origin of the *currently
  // saved* bio (rendered above the tabs, since it describes the live bio
  // regardless of which tab you're on).
  const [generations, setGenerations] = React.useState<OverviewGenerationItem[]>([]);
  const [provenance, setProvenance] = React.useState<OverviewProvenanceLine | null>(null);

  // Re-read the owner's draft history + the saved bio's provenance. Best-effort:
  // a failed read leaves the panel/line in their last state.
  const refreshGenerations = React.useCallback(async () => {
    if (!generateEnabled) return;
    try {
      const res = await fetch("/api/edit/overview/generations", { method: "GET" });
      if (!res.ok) return;
      const data = (await res.json()) as OverviewGenerationsResponse;
      setGenerations(Array.isArray(data.generations) ? data.generations : []);
      setProvenance(data.provenance ?? null);
    } catch {
      // Swallow — the history panel is non-essential and must never disrupt the editor.
    }
  }, [generateEnabled]);

  React.useEffect(() => {
    void refreshGenerations();
  }, [refreshGenerations]);

  // A Save from either tab publishes and re-reads provenance. `value` is the
  // server's post-sanitize response, which becomes the new shared baseline.
  const onSaved = React.useCallback(
    (value: string) => {
      setSavedHtml(value);
      void refreshGenerations();
    },
    [refreshGenerations],
  );

  // Two independent editor states, both rooted on the shared `savedHtml`. The
  // generator one composes the manual editor + the generate/version machinery.
  const existing = useOverviewEditor({ cwid, savedHtml, onSaved });
  const generator = useOverviewGenerator({
    cwid,
    savedHtml,
    onSaved,
    refreshGenerations,
    generateEnabled,
  });

  const dirty = existing.dirty || (generateEnabled && generator.editor.dirty);

  // Without the flag: the Phase 6 manual surface, no tabs — unchanged behavior.
  if (!generateEnabled) {
    return (
      <EditPanel
        slot="overview-card"
        heading="Overview"
        owned
        description="A short bio shown at the top of your public profile."
      >
        <UnsavedChangesGuard dirty={dirty} />
        <OverviewManualSurface editor={existing} previewHref={previewHref} />
      </EditPanel>
    );
  }

  // With the flag: two tabs. Existing (manual) is the default; Generator is the
  // opt-in beta. The provenance line sits above the tabs (it's about the live
  // bio, not a tab). Radix unmounts the inactive tab, so only one editor is in
  // the DOM at a time and each tab's draft is preserved in the hooks above.
  return (
    <EditPanel
      slot="overview-card"
      heading="Overview"
      owned
      description="A short bio shown at the top of your public profile."
    >
      <UnsavedChangesGuard dirty={dirty} />
      <OverviewProvenanceNote provenance={provenance} />
      <Tabs defaultValue="existing">
        <TabsList aria-label="Overview editor mode">
          <TabsTrigger value="existing" data-testid="overview-tab-existing">
            Existing
          </TabsTrigger>
          <TabsTrigger value="generator" data-testid="overview-tab-generator">
            Generator
            <span
              className="bg-apollo-maroon/10 text-apollo-maroon ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
              data-testid="overview-generator-beta"
            >
              Beta
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="existing" className="flex flex-col gap-4">
          <OverviewManualSurface editor={existing} previewHref={previewHref} />
        </TabsContent>
        <TabsContent value="generator" className="flex flex-col gap-4">
          <OverviewGeneratorSurface
            generator={generator}
            generations={generations}
            savedHtml={savedHtml}
            previewHref={previewHref}
          />
        </TabsContent>
      </Tabs>
    </EditPanel>
  );
}

// ---------------------------------------------------------------------------
// Editor state hooks — shared between the manual (Existing) surface and the
// Generator surface, so the save/dirty/counter mechanics live in one place.
// ---------------------------------------------------------------------------

type UseOverviewEditor = {
  /** Live editor HTML (the counter + dirty source). */
  currentHtml: string;
  /** Bump-to-remount key — drives a re-seed of the (uncontrolled) Tiptap editor. */
  editorKey: number;
  isSaving: boolean;
  error: string | null;
  justSaved: boolean;
  dirty: boolean;
  overLimit: boolean;
  handleChange: (html: string) => void;
  /** Re-seed the editor with `html` (generate / load-version / discard). */
  reseed: (html: string) => void;
  discard: () => void;
  /** Publish the current HTML, tagging provenance with `sourceGenerationId`. */
  save: (sourceGenerationId: string | null) => Promise<void>;
};

/**
 * The shared editor state: live HTML, dirty/over-limit, Save (to the field
 * route), Discard, and the re-seed mechanism. `savedHtml` is the shared
 * baseline owned by the parent; `onSaved` hands the server's post-sanitize
 * value back up. The editor seeds from `currentHtml`, so a tab-switch remount
 * preserves the in-progress draft (the value isn't lost when Radix unmounts the
 * inactive tab).
 */
function useOverviewEditor({
  cwid,
  savedHtml,
  onSaved,
  onChangeExtra,
  onSaveSuccess,
  onDiscardExtra,
}: {
  cwid: string;
  savedHtml: string;
  onSaved: (value: string) => void;
  onChangeExtra?: () => void;
  onSaveSuccess?: () => void;
  onDiscardExtra?: () => void;
}): UseOverviewEditor {
  const [currentHtml, setCurrentHtml] = React.useState(savedHtml);
  const [editorKey, setEditorKey] = React.useState(0);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  const dirty = currentHtml !== savedHtml;
  const overLimit = currentHtml.length > OVERVIEW_MAX_CHARS;

  function handleChange(html: string) {
    setCurrentHtml(html);
    // The "Saved — live" confirmation persists across keystrokes and clears only
    // on the next save (vision-round T3.1) — re-editing doesn't un-publish.
    if (error) setError(null);
    onChangeExtra?.();
  }

  function reseed(html: string) {
    setCurrentHtml(html);
    setEditorKey((k) => k + 1);
    if (error) setError(null);
  }

  function discard() {
    reseed(savedHtml);
    onDiscardExtra?.();
  }

  async function save(sourceGenerationId: string | null) {
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
          // The generation this draft came from (or null for hand-written text);
          // the field route uses it to record provenance after the upsert.
          sourceGenerationId,
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
      // Server may have normalized the HTML (sanitize, link rewrite). The new
      // shared baseline is the server's value; `currentHtml` is left as-is, so a
      // normalization that differs shows dirty until the editor re-emits it.
      // Guard against a malformed response without a string value so the shared
      // baseline (and thus dirty state) can never be corrupted to a non-string.
      if (typeof data.value === "string") onSaved(data.value);
      setJustSaved(true);
      onSaveSuccess?.();
    } catch {
      setError("Something went wrong — your changes weren't saved. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return {
    currentHtml,
    editorKey,
    isSaving,
    error,
    justSaved,
    dirty,
    overLimit,
    handleChange,
    reseed,
    discard,
    save,
  };
}

type UseOverviewGenerator = {
  editor: UseOverviewEditor;
  params: OverviewParams;
  setParams: React.Dispatch<React.SetStateAction<OverviewParams>>;
  isGenerating: boolean;
  generated: boolean;
  generateNotice: string | null;
  generateError: string | null;
  currentGenerationId: string | null;
  /** The Sources drawer's candidate lists (null until the fetch resolves). */
  sourceOptions: OverviewSourceOptions | null;
  /** Which sources ground the next draft (v3.1). */
  selection: OverviewSelection;
  setSelection: React.Dispatch<React.SetStateAction<OverviewSelection>>;
  generate: () => Promise<void>;
  loadVersion: (gen: OverviewGenerationItem) => void;
};

/**
 * The Generator surface's state: the shared editor (composed) plus the
 * Generate/Regenerate flow, the steering params, and the draft↔generation link
 * that lets Save record provenance. A generated draft seeds the editor as
 * UNSAVED content; `savedHtml` is untouched so Discard reverts to the last bio.
 */
function useOverviewGenerator({
  cwid,
  savedHtml,
  onSaved,
  refreshGenerations,
  generateEnabled,
}: {
  cwid: string;
  savedHtml: string;
  onSaved: (value: string) => void;
  refreshGenerations: () => Promise<void>;
  generateEnabled: boolean;
}): UseOverviewGenerator {
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [generated, setGenerated] = React.useState(false);
  const [lastGeneratedDraft, setLastGeneratedDraft] = React.useState<string | null>(null);
  const [generateNotice, setGenerateNotice] = React.useState<string | null>(null);
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  const [params, setParams] = React.useState<OverviewParams>(DEFAULT_OVERVIEW_PARAMS);
  const [currentGenerationId, setCurrentGenerationId] = React.useState<string | null>(null);

  // #742 v3.1 — the source picker. Fetch the candidate lists once (SELF arm) and
  // seed the selection from the populated default (first/last-author scored pubs +
  // PI funding). Best-effort: a failed fetch leaves the drawer disabled, not the
  // editor — generation still falls back to the server's default selection.
  const [sourceOptions, setSourceOptions] = React.useState<OverviewSourceOptions | null>(null);
  const [selection, setSelection] = React.useState<OverviewSelection>(EMPTY_SELECTION);

  React.useEffect(() => {
    if (!generateEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/edit/overview/source-options", { method: "GET" });
        if (!res.ok) return;
        const data = (await res.json()) as { ok: true } & OverviewSourceOptions;
        if (cancelled) return;
        const options: OverviewSourceOptions = {
          publications: Array.isArray(data.publications) ? data.publications : [],
          funding: Array.isArray(data.funding) ? data.funding : [],
          tools: Array.isArray(data.tools) ? data.tools : [],
        };
        setSourceOptions(options);
        setSelection(selectionFromOptions(options));
      } catch {
        // Swallow — the picker is a convenience; generation defaults server-side.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generateEnabled]);

  const editor = useOverviewEditor({
    cwid,
    savedHtml,
    onSaved,
    // Editing the draft clears a stale generation error too.
    onChangeExtra: () => setGenerateError(null),
    // Publishing the draft clears the banner + draft↔generation link, then
    // re-reads provenance (now authored / generated / generated_edited).
    onSaveSuccess: () => {
      setGenerateNotice(null);
      setLastGeneratedDraft(null);
      setGenerated(false);
      setCurrentGenerationId(null);
    },
    // Discard drops the draft banner along with the text.
    onDiscardExtra: () => setGenerateNotice(null),
  });

  function loadVersion(gen: OverviewGenerationItem) {
    if (isGenerating || editor.isSaving) return;
    editor.reseed(gen.text);
    setLastGeneratedDraft(gen.text);
    setGenerated(true);
    setCurrentGenerationId(gen.id);
    setGenerateNotice(GENERATE_BANNER);
    setGenerateError(null);
  }

  async function generate() {
    if (isGenerating || editor.isSaving) return;
    // Regenerating over edits the scholar made (text matching neither the saved
    // bio nor the last-seeded draft) prompts a confirm before we replace it (G3).
    if (
      generated &&
      editor.currentHtml !== savedHtml &&
      editor.currentHtml !== (lastGeneratedDraft ?? "") &&
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
        // The source selection rides along with the steering params (v3.1); the
        // server re-normalizes / ownership-filters it.
        body: JSON.stringify({ entityId: cwid, params, selection }),
      });
      const data = (await res.json()) as
        | { ok: true; draft: string; model: string; generationId: string | null }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        // Editor untouched on any failure (G8) — only a notice or error appears.
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
      // Seed the draft as UNSAVED content; the existing Save publishes it.
      editor.reseed(data.draft);
      setLastGeneratedDraft(data.draft);
      setGenerated(true);
      setGenerateNotice(GENERATE_BANNER);
      // Tie the in-editor draft to its history row so a subsequent Save records
      // provenance. `null` (a history write that hiccuped) saves as authored.
      setCurrentGenerationId(data.generationId);
      void refreshGenerations();
    } catch {
      setGenerateError(GENERATE_FAILED);
    } finally {
      setIsGenerating(false);
    }
  }

  return {
    editor,
    params,
    setParams,
    isGenerating,
    generated,
    generateNotice,
    generateError,
    currentGenerationId,
    sourceOptions,
    selection,
    setSelection,
    generate,
    loadVersion,
  };
}

// ---------------------------------------------------------------------------
// Presentational surfaces.
// ---------------------------------------------------------------------------

/** The Existing tab (and the no-flag surface): the plain manual editor. Saves
 *  as `authored` (no sourceGenerationId). */
function OverviewManualSurface({
  editor,
  previewHref,
}: {
  editor: UseOverviewEditor;
  previewHref?: string;
}) {
  return <OverviewEditorBody editor={editor} sourceGenerationId={null} previewHref={previewHref} />;
}

/** The Generator tab: the steering controls + Generate/Regenerate + Versions +
 *  notices, above the editor body. Saves as `generated`/`generated_edited`. */
function OverviewGeneratorSurface({
  generator,
  generations,
  savedHtml,
  previewHref,
}: {
  generator: UseOverviewGenerator;
  generations: OverviewGenerationItem[];
  savedHtml: string;
  previewHref?: string;
}) {
  const { editor } = generator;
  // Hide Generate when the scholar already has a non-empty saved bio (G9 — don't
  // invite clobbering good content); offer Regenerate (behind a confirm) instead.
  const hasExistingBio = savedHtml.trim().length > 0;
  const busy = generator.isGenerating || editor.isSaving;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {hasExistingBio || generator.generated ? (
          <Button
            type="button"
            variant="outline"
            onClick={generator.generate}
            disabled={busy}
            data-testid="overview-regenerate"
          >
            <RefreshCw className="size-4" />
            {generator.isGenerating ? "Generating…" : "Regenerate"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={generator.generate}
            disabled={busy}
            data-testid="overview-generate"
          >
            <Sparkles className="size-4" />
            {generator.isGenerating ? "Generating…" : "Generate a draft"}
          </Button>
        )}
        <span className="text-muted-foreground text-sm">
          Draft from your Scholars publications, topics, and grants — you review and edit it.
        </span>
      </div>

      <details className="group" data-testid="overview-generate-options">
        <summary className="text-apollo-maroon w-fit cursor-pointer text-sm font-medium select-none">
          Generation options
        </summary>
        <div className="mt-3">
          <OverviewGenerateControls
            value={generator.params}
            onChange={generator.setParams}
            disabled={busy}
          />
        </div>
      </details>

      <OverviewSourceDrawer
        options={generator.sourceOptions}
        selection={generator.selection}
        onSelectionChange={generator.setSelection}
        disabled={busy}
      />

      <OverviewVersionsPanel
        generations={generations}
        onLoad={generator.loadVersion}
        onUseSettings={generator.setParams}
        disabled={busy}
      />

      {generator.generateNotice && (
        <Alert data-testid="overview-generate-notice">
          <AlertDescription>{generator.generateNotice}</AlertDescription>
        </Alert>
      )}
      {generator.generateError && (
        <Alert variant="destructive" data-testid="overview-generate-error">
          <AlertDescription>{generator.generateError}</AlertDescription>
        </Alert>
      )}

      <OverviewEditorBody
        editor={editor}
        sourceGenerationId={generator.currentGenerationId}
        previewHref={previewHref}
      />
    </>
  );
}

/** The editor + counter + Save/Discard row shared by both surfaces. Only one is
 *  mounted at a time (Radix unmounts the inactive tab), so the `overview-save` /
 *  `overview-discard` testids stay unambiguous. */
function OverviewEditorBody({
  editor,
  sourceGenerationId,
  previewHref,
}: {
  editor: UseOverviewEditor;
  sourceGenerationId: string | null;
  previewHref?: string;
}) {
  return (
    <>
      <div className="max-w-prose">
        <OverviewEditor
          key={editor.editorKey}
          initialHtml={editor.currentHtml}
          onChange={editor.handleChange}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          aria-live="polite"
          className={cn(
            "text-sm tabular-nums",
            editor.overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {editor.currentHtml.length.toLocaleString()}/{OVERVIEW_MAX_CHARS.toLocaleString()}
        </span>
        <div className="flex flex-wrap items-center gap-3">
          {editor.justSaved && (
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
          {editor.dirty && (
            <Button
              type="button"
              variant="outline"
              onClick={editor.discard}
              disabled={editor.isSaving}
              data-testid="overview-discard"
            >
              Discard
            </Button>
          )}
          <Button
            type="button"
            variant="apollo"
            onClick={() => editor.save(sourceGenerationId)}
            disabled={!editor.dirty || editor.overLimit || editor.isSaving}
            data-testid="overview-save"
          >
            {editor.isSaving ? "Saving…" : "Save bio"}
          </Button>
          <span className="text-muted-foreground text-sm">
            Changes publish to your public profile immediately.
          </span>
        </div>
      </div>
      {editor.error && (
        <Alert variant="destructive">
          <AlertDescription>{editor.error}</AlertDescription>
        </Alert>
      )}
    </>
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
