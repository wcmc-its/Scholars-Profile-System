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
 * #875 redesign — the two-tab (`Existing | Generator`) layout is replaced by a
 * single persistent editor with a collapsible **Draft with AI** block stacked
 * above it and a coral **draft-review card** that intercepts every generated
 * draft. Generation NEVER writes the editor: a draft lands in the review card,
 * and only an explicit Replace / Insert below pulls it into the editor. The
 * `sourceGenerationId` provenance link is threaded through Replace AND Insert
 * (both produce generated content), and stays null for hand-written or
 * discarded-then-edited text (saves as `authored`). When `generateEnabled` is
 * false (the dark-flag default and every non-self surface), there is NO block
 * and NO review card — the manual editor renders exactly as the Phase 6 surface
 * did, so that path is byte-for-byte unchanged.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronDown, Globe, Sparkles, TriangleAlert } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import {
  OverviewDraftReviewCard,
  type OverviewReviewDraft,
} from "@/components/edit/overview-draft-review-card";
import { OverviewEditor } from "@/components/edit/overview-editor";
import { OverviewGenerateControls } from "@/components/edit/overview-generate-controls";
import { OverviewProvenanceNote } from "@/components/edit/overview-provenance-note";
import { OverviewSourceDrawer } from "@/components/edit/overview-source-drawer";
import {
  summarizeParams,
  summarizeParamsCompact,
  type OverviewGenerationItem,
} from "@/components/edit/overview-versions-panel";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  DEFAULT_OVERVIEW_PARAMS,
  type OverviewParams,
  type OverviewSelection,
} from "@/lib/edit/overview-params";
import type { OverviewOrigin } from "@/lib/edit/overview-provenance";
import { cn } from "@/lib/utils";

/** The hard cap on stored sanitized HTML (`self-edit-spec.md` § overview) — the
 *  server ceiling. Save still blocks if somehow exceeded, mapping to the
 *  destructive counter style. */
const OVERVIEW_MAX_CHARS = 20000;
/** The real editorial cap (#875). The counter shows `{n}/2,500`; an amber
 *  warning fires at ~80% and Save is gated here, well below the server ceiling. */
const OVERVIEW_EDITORIAL_MAX = 2500;
/** ~80% of the editorial cap — the amber-warning threshold. */
const OVERVIEW_WARN_CHARS = 2000;

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

// #875 §6 — the two pre-generation conditional hints (verbatim from the spec).
const HINT_EMPHASIS_CONFLICT =
  "awards are selected as sources but won't be mentioned directly — turn on Grants & funding to include them in the overview.";
const HINT_SPARSE_SOURCES = "Limited sources may produce a generic draft.";

/** A fresh, all-empty source selection (before the source-options load). */
const EMPTY_SELECTION: OverviewSelection = { pmids: [], grantIds: [], toolNames: [] };

/** The populated default selection from the source-options' `defaultSelected`
 *  flags (v3.1 — first/last-author scored pubs + PI funding; tools land in C3). */
function selectionFromOptions(options: OverviewSourceOptions): OverviewSelection {
  return {
    pmids: options.publications.filter((p) => p.defaultSelected).map((p) => p.pmid),
    grantIds: options.funding.filter((f) => f.defaultSelected).map((f) => f.id),
    toolNames: options.tools.filter((t) => t.defaultSelected).map((t) => t.toolName),
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
   * Draft-with-AI block and no review card; the editor behaves exactly as the
   * Phase 6 surface did.
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
  //
  // #844 — this arm is no longer reached from the live `/edit` surface: a
  // superuser now gets the editable manual editor on another scholar's bio
  // (`edit-page.tsx` stopped forcing `readOnly` for the superuser mode), and the
  // self / proxy / unit-admin surfaces were always editable. The component (and
  // its `readOnly` prop) are retained as a defensive, genuinely-read-only render
  // for any future caller; the copy no longer claims ONLY the owner can edit,
  // since superusers can.
  const hasBio = initialHtml.trim().length > 0;
  return (
    <EditPanel
      slot="overview-card"
      heading="Overview"
      description="This overview is shown read-only here."
    >
      {hasBio ? (
        <div
          className="prose prose-sm border-apollo-border bg-apollo-surface-2 rounded-md border px-4 py-3"
          dangerouslySetInnerHTML={{ __html: initialHtml }}
          data-slot="overview-readonly"
        />
      ) : (
        <p className="text-muted-foreground text-sm" data-slot="overview-readonly-empty">
          No overview yet.
        </p>
      )}
    </EditPanel>
  );
}

// ---------------------------------------------------------------------------
// Editor arm — self mode. ONE persistent editor; behind the flag, the
// Draft-with-AI block + the coral draft-review card stack above it (#875). The
// saved bio + provenance + history live here so the editor publishes to one
// field and the generator only ever proposes drafts into the review card.
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
  // The currently-published bio — the dirty baseline.
  const [savedHtml, setSavedHtml] = React.useState(initialHtml);

  // #742 Phase B — draft history + provenance, owner-only. `generations` drives
  // the in-card "Draft N of M" affordance; `provenance` is the one-line origin
  // of the *currently saved* bio.
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

  // A Save publishes and re-reads provenance. `value` is the server's
  // post-sanitize response, which becomes the new shared baseline.
  const onSaved = React.useCallback(
    (value: string) => {
      setSavedHtml(value);
      void refreshGenerations();
    },
    [refreshGenerations],
  );

  const editor = useOverviewEditor({ cwid, savedHtml, onSaved });

  if (!generateEnabled) {
    // The Phase 6 manual surface, byte-for-byte unchanged.
    return (
      <EditPanel
        slot="overview-card"
        heading="Overview"
        owned
        description="A short overview shown at the top of your public profile."
      >
        <UnsavedChangesGuard dirty={editor.dirty} />
        <OverviewEditorBody editor={editor} previewHref={previewHref} sourceCounts={null} />
      </EditPanel>
    );
  }

  return (
    <EditPanel
      slot="overview-card"
      heading="Overview"
      owned
      description="A short overview shown at the top of your public profile."
    >
      <UnsavedChangesGuard dirty={editor.dirty} />
      <OverviewProvenanceNote provenance={provenance} />
      <OverviewGeneratorArm
        cwid={cwid}
        savedHtml={savedHtml}
        editor={editor}
        generations={generations}
        refreshGenerations={refreshGenerations}
        previewHref={previewHref}
      />
    </EditPanel>
  );
}

// ---------------------------------------------------------------------------
// Editor state hook — the save/dirty/counter mechanics in one place, shared by
// the manual surface and the generator arm.
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
  /** Over the editorial cap — Save is gated here first. */
  overEditorialLimit: boolean;
  /** Within the amber-warning band (≥ 80% of the editorial cap). */
  nearLimit: boolean;
  /** Over the hard server ceiling (maps to the destructive counter style). */
  overLimit: boolean;
  handleChange: (html: string) => void;
  /** Re-seed the editor with `html` (replace / insert / discard). */
  reseed: (html: string) => void;
  discard: () => void;
  /** Publish the current HTML, tagging provenance with `sourceGenerationId`. */
  save: (sourceGenerationId: string | null) => Promise<void>;
};

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
  const overEditorialLimit = currentHtml.length > OVERVIEW_EDITORIAL_MAX;
  const nearLimit = currentHtml.length >= OVERVIEW_WARN_CHARS;
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
    if (!dirty || overEditorialLimit || isSaving) return;
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
    overEditorialLimit,
    nearLimit,
    overLimit,
    handleChange,
    reseed,
    discard,
    save,
  };
}

// ---------------------------------------------------------------------------
// The generator arm — the Draft-with-AI block, the conditional hints, and the
// coral review card. Generation lands a draft in `reviewDraft`, NEVER the
// editor; Replace / Insert below are the only paths into the editor, and both
// carry the generation id for provenance.
// ---------------------------------------------------------------------------

function OverviewGeneratorArm({
  cwid,
  savedHtml,
  editor,
  generations,
  refreshGenerations,
  previewHref,
}: {
  cwid: string;
  savedHtml: string;
  editor: UseOverviewEditor;
  generations: OverviewGenerationItem[];
  refreshGenerations: () => Promise<void>;
  previewHref?: string;
}) {
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [generateNotice, setGenerateNotice] = React.useState<string | null>(null);
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  const [params, setParams] = React.useState<OverviewParams>(DEFAULT_OVERVIEW_PARAMS);

  // The draft currently under review (coral card). `null` = no draft proposed.
  // `reviewIndex` pages back through `reviewHistory` (newest first).
  const [reviewHistory, setReviewHistory] = React.useState<OverviewReviewDraft[]>([]);
  const [reviewIndex, setReviewIndex] = React.useState(0);
  // The generation id that produced the editor's CURRENT content — set on
  // Replace / Insert, cleared on Save / hand-edit / discard.
  const [currentGenerationId, setCurrentGenerationId] = React.useState<string | null>(null);

  // The source picker. Fetch the candidate lists once and seed the selection
  // from the populated default. Best-effort: a failed fetch leaves the drawer
  // disabled, not the editor — generation still defaults server-side.
  const [sourceOptions, setSourceOptions] = React.useState<OverviewSourceOptions | null>(null);
  const [selection, setSelection] = React.useState<OverviewSelection>(EMPTY_SELECTION);

  // The block is expanded when there is no saved bio, collapsed when one exists
  // (§8) — set once on mount from the initial saved value.
  const [blockOpen, setBlockOpen] = React.useState(() => savedHtml.trim().length === 0);

  React.useEffect(() => {
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
  }, []);

  const busy = isGenerating || editor.isSaving;
  const reviewDraft = reviewHistory[reviewIndex] ?? null;

  // Editing the draft by hand un-links it from its generation: hand-written text
  // is `authored`, not `generated_edited`. Generation/replace/insert re-link it.
  const handleEditorChange = React.useCallback(
    (html: string) => {
      setGenerateError(null);
      setCurrentGenerationId(null);
      editor.handleChange(html);
    },
    [editor],
  );

  // §6 pre-generation hints, reading the LIVE selection + params (client-only).
  const showConflictHint =
    selection.grantIds.length > 0 && !params.elements.includes("grants_funding");
  const showSparseHint = selection.pmids.length <= 1 && selection.grantIds.length === 0;

  async function generate() {
    if (busy) return;
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
      // Land the draft in the review card — NEVER the editor. Re-running appends
      // a new draft to the front and keeps prior ones (cheap iteration).
      const draft: OverviewReviewDraft = {
        text: data.draft,
        generationId: data.generationId,
        createdAt: new Date().toISOString(),
      };
      setReviewHistory((prev) => [draft, ...prev]);
      setReviewIndex(0);
      setGenerateNotice(GENERATE_BANNER);
      void refreshGenerations();
    } catch {
      setGenerateError(GENERATE_FAILED);
    } finally {
      setIsGenerating(false);
    }
  }

  // Replace: overwrite the editor with the reviewed draft; the editor's content
  // is now generated, so Save records provenance.
  function replaceWithDraft() {
    if (!reviewDraft) return;
    editor.reseed(reviewDraft.text);
    setCurrentGenerationId(reviewDraft.generationId);
    setReviewHistory([]);
    setReviewIndex(0);
  }

  // Insert below: append the draft to the editor's current contents (Open Q2 —
  // append-to-end). Must go through `reseed` so the uncontrolled Tiptap DOM
  // updates. An inserted draft contains generated content → still `generated*`.
  function insertDraftBelow() {
    if (!reviewDraft) return;
    editor.reseed(editor.currentHtml + reviewDraft.text);
    setCurrentGenerationId(reviewDraft.generationId);
    setReviewHistory([]);
    setReviewIndex(0);
  }

  // Discard: drop the review card only; the editor and saved bio are untouched.
  function discardDraft() {
    setReviewHistory([]);
    setReviewIndex(0);
    setGenerateNotice(null);
  }

  // Loading a history row proposes it as a review draft (never the editor).
  function loadVersion(gen: OverviewGenerationItem) {
    if (busy) return;
    setReviewHistory([{ text: gen.text, generationId: gen.id, createdAt: gen.createdAt }]);
    setReviewIndex(0);
    setGenerateNotice(GENERATE_BANNER);
    setGenerateError(null);
  }

  const sourceCounts =
    sourceOptions != null
      ? { publications: selection.pmids.length, awards: selection.grantIds.length }
      : null;

  return (
    <>
      <OverviewDraftBlock
        open={blockOpen}
        onToggle={() => setBlockOpen((o) => !o)}
        params={params}
        setParams={setParams}
        sourceOptions={sourceOptions}
        selection={selection}
        setSelection={setSelection}
        showConflictHint={showConflictHint}
        showSparseHint={showSparseHint}
        conflictAwardCount={selection.grantIds.length}
        onGenerate={generate}
        isGenerating={isGenerating}
        busy={busy}
        generations={generations}
        onLoadVersion={loadVersion}
      />

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

      {reviewDraft && (
        <OverviewDraftReviewCard
          draft={reviewDraft}
          index={reviewIndex + 1}
          total={reviewHistory.length}
          onPrev={() => setReviewIndex((i) => Math.max(0, i - 1))}
          onNext={() => setReviewIndex((i) => Math.min(reviewHistory.length - 1, i + 1))}
          onReplace={replaceWithDraft}
          onInsert={insertDraftBelow}
          onDiscard={discardDraft}
          disabled={busy}
        />
      )}

      <OverviewEditorBody
        editor={editor}
        sourceGenerationId={currentGenerationId}
        previewHref={previewHref}
        sourceCounts={sourceCounts}
        onChange={handleEditorChange}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The "Draft with AI" collapsible block (#875 §4.1/§4.2). Internal order
// inverts today's: Settings → Sources → hints → Generate button LAST.
// ---------------------------------------------------------------------------

function OverviewDraftBlock({
  open,
  onToggle,
  params,
  setParams,
  sourceOptions,
  selection,
  setSelection,
  showConflictHint,
  showSparseHint,
  conflictAwardCount,
  onGenerate,
  isGenerating,
  busy,
  generations,
  onLoadVersion,
}: {
  open: boolean;
  onToggle: () => void;
  params: OverviewParams;
  setParams: React.Dispatch<React.SetStateAction<OverviewParams>>;
  sourceOptions: OverviewSourceOptions | null;
  selection: OverviewSelection;
  setSelection: React.Dispatch<React.SetStateAction<OverviewSelection>>;
  showConflictHint: boolean;
  showSparseHint: boolean;
  conflictAwardCount: number;
  onGenerate: () => void;
  isGenerating: boolean;
  busy: boolean;
  generations: OverviewGenerationItem[];
  onLoadVersion: (gen: OverviewGenerationItem) => void;
}) {
  return (
    <div
      className="border-apollo-border bg-apollo-surface rounded-lg border"
      data-testid="overview-draft-block"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        data-testid="overview-draft-block-toggle"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className="text-apollo-maroon size-[18px] shrink-0" aria-hidden="true" />
          <span className="shrink-0 text-sm font-medium whitespace-nowrap">Draft with AI</span>
          <span
            className="bg-apollo-maroon/10 text-apollo-maroon shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            data-testid="overview-generator-beta"
          >
            Beta
          </span>
          {!open && (
            <span
              className="text-muted-foreground min-w-0 truncate text-xs"
              data-testid="overview-draft-block-summary"
            >
              {summarizeParamsCompact(params)}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="flex flex-col gap-4 px-4 pb-4" data-testid="overview-draft-block-body">
          <OverviewGenerateControls value={params} onChange={setParams} disabled={busy} />

          <OverviewSourceDrawer
            options={sourceOptions}
            selection={selection}
            onSelectionChange={setSelection}
            disabled={busy}
          />

          {generations.length > 0 && (
            <details className="group" data-testid="overview-versions-panel">
              <summary className="text-apollo-maroon w-fit cursor-pointer text-sm font-medium select-none">
                Earlier drafts ({generations.length})
              </summary>
              <ul className="border-apollo-border bg-apollo-surface-2 mt-3 flex flex-col gap-3 rounded-md border p-4">
                {generations.map((gen) => (
                  <li
                    key={gen.id}
                    className="flex flex-wrap items-start justify-between gap-3"
                    data-testid={`overview-version-${gen.id}`}
                  >
                    <span className="text-muted-foreground min-w-0 text-xs">
                      {summarizeParams(gen.params)}
                    </span>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onLoadVersion(gen)}
                        disabled={busy}
                        data-testid={`overview-version-load-${gen.id}`}
                      >
                        View draft
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setParams(gen.params)}
                        disabled={busy}
                        data-testid={`overview-version-use-settings-${gen.id}`}
                      >
                        Use these settings
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {showConflictHint && (
            <Alert data-testid="overview-hint-emphasis-conflict">
              <AlertDescription>
                {conflictAwardCount} {HINT_EMPHASIS_CONFLICT}
              </AlertDescription>
            </Alert>
          )}
          {showSparseHint && (
            <Alert
              className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber"
              data-testid="overview-hint-sparse-sources"
            >
              <TriangleAlert className="size-4" />
              <AlertDescription className="text-apollo-amber">
                {HINT_SPARSE_SOURCES}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={onGenerate}
              disabled={busy}
              data-testid="overview-generate"
            >
              <Sparkles className="size-4" />
              {isGenerating ? "Generating…" : "Generate a draft"}
            </Button>
            <span className="text-muted-foreground text-sm">
              Draft from your Scholars publications, topics, and grants — you review it before
              anything reaches your overview.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor + counter + Save/Discard row (the single source of truth).
// ---------------------------------------------------------------------------

function OverviewEditorBody({
  editor,
  sourceGenerationId = null,
  previewHref,
  sourceCounts,
  onChange,
}: {
  editor: UseOverviewEditor;
  sourceGenerationId?: string | null;
  previewHref?: string;
  /** Live selected counts for the empty-state on-ramp; null while loading or on
   *  the manual surface (no source data) → count-less fallback copy. */
  sourceCounts: { publications: number; awards: number } | null;
  /** Override the editor's onChange (the generator arm un-links provenance). */
  onChange?: (html: string) => void;
}) {
  const isEmpty = editor.currentHtml.trim().length === 0;

  return (
    <>
      <div className="max-w-prose">
        <OverviewEditor
          key={editor.editorKey}
          initialHtml={editor.currentHtml}
          onChange={onChange ?? editor.handleChange}
        />
      </div>
      {isEmpty && (
        <p className="text-muted-foreground text-sm" data-slot="overview-editor-empty">
          {sourceCounts
            ? `No overview yet. Generate a draft from your ${sourceCounts.publications} ${plural(
                sourceCounts.publications,
                "publication",
              )} and ${sourceCounts.awards} ${plural(
                sourceCounts.awards,
                "award",
              )} above, or start writing here.`
            : "No overview yet. Generate a draft from your work above, or start writing here."}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          aria-live="polite"
          className={cn(
            "text-sm tabular-nums",
            editor.overLimit || editor.overEditorialLimit
              ? "text-destructive"
              : editor.nearLimit
                ? "text-apollo-amber"
                : "text-muted-foreground",
          )}
          data-testid="overview-counter"
        >
          {editor.nearLimit
            ? `${editor.currentHtml.length.toLocaleString()}/${OVERVIEW_EDITORIAL_MAX.toLocaleString()}`
            : editor.currentHtml.length.toLocaleString()}
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
            disabled={!editor.dirty || editor.overEditorialLimit || editor.isSaving}
            data-testid="overview-save"
          >
            {editor.isSaving ? "Saving…" : "Save overview"}
          </Button>
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
            <Globe className="size-3.5" aria-hidden="true" />
            Publishes to your public profile immediately.
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

function plural(n: number, singular: string): string {
  return `${singular}${n === 1 ? "" : "s"}`;
}

/**
 * Map a server error code to the user-facing string. Most errors here are
 * surprises (the route's per-field validation runs server-side and re-validates
 * what the editor schema already constrains), so the default applies broadly.
 */
function mapErrorToMessage(code: string): string {
  switch (code) {
    case "overview_too_long":
      return `Your overview exceeds the ${OVERVIEW_MAX_CHARS.toLocaleString()}-character limit. Trim it and try again.`;
    case "invalid_value":
      return "We couldn't save that overview. Try removing unusual formatting and saving again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
