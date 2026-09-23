/**
 * The Overview card (#356 Phase 6 C5 / Phase 7 C3, UI-SPEC § `/edit` Card 1
 * + § `/edit/scholar/[cwid]` Card 1 superuser arm).
 *
 * Wraps `OverviewEditor`, owns Save, and renders the counter + inline
 * success/failure feedback. POSTs `/api/edit/field` (Phase 2 contract,
 * `app/api/edit/field/route.ts`).
 *
 * The counter measures the *visible text* length (tags stripped) — the human
 * editorial cap (2,500) and its amber warning gate on what the reader sees, not
 * the markup byte count. The SPEC's 20,000 cap is a separate hard ceiling on the
 * *stored* sanitized HTML, so `overLimit` still measures `currentHtml.length`.
 * Saved becomes the server's *response* value, not what we sent, so a
 * sanitize-time normalization (a dropped href, a whitespace collapse) updates
 * the dirty baseline correctly.
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
 *
 * Two-column layout (2026-09-23 "Overview editor, two-column" canvas) — the
 * editor sits left and a persistent "Draft with AI" rail sits right. A draft
 * under review takes the editor's place as a read-only preview behind a review
 * bar (draft N of M, Current text ⇄ AI draft); the Sources picker likewise takes
 * the editor's place while open. The header carries a status pill (imported /
 * edited / unsaved / draft pending review) and a History toggle listing every
 * draft plus the published text.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronLeft, ChevronRight, Globe, History, Settings2, Sparkles } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { OverviewEditor } from "@/components/edit/overview-editor";
import {
  OverviewGenerateControls,
  TONE_AUDIENCE,
} from "@/components/edit/overview-generate-controls";
import { OverviewProgress } from "@/components/edit/overview-progress";
import { OverviewProvenanceNote } from "@/components/edit/overview-provenance-note";
import {
  OverviewSourcePanel,
  OverviewSourcesRow,
} from "@/components/edit/overview-source-drawer";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  DEFAULT_OVERVIEW_PARAMS,
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  OVERVIEW_ELEMENTS,
  type OverviewParams,
  type OverviewSelection,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";
import {
  humanizeModelId,
  type OverviewPromptVersionId,
  type OverviewPromptVersionMeta,
} from "@/lib/edit/overview-prompt-versions";
import { estimateDraftCostUsd } from "@/lib/llm/pricing";
import { resolveOverviewSelection, selectionToDeltas } from "@/lib/edit/overview-resolve";
import {
  readOverviewStream,
  type OverviewProgressState,
  type OverviewStreamResult,
} from "@/lib/edit/overview-stream";
import type { OverviewOrigin } from "@/lib/edit/overview-provenance";
import { cn, OVERVIEW_HTML_CLASS } from "@/lib/utils";

/** The hard cap on stored sanitized HTML (`self-edit-spec.md` § overview) — the
 *  server ceiling. Save still blocks if somehow exceeded, mapping to the
 *  destructive counter style. */
const OVERVIEW_MAX_CHARS = 20000;
/** The real editorial cap (#875). The counter shows `{n}/2,500`; an amber
 *  warning fires at ~80% and Save is gated here, well below the server ceiling. */
const OVERVIEW_EDITORIAL_MAX = 2500;
/** ~80% of the editorial cap — the amber-warning threshold. */
const OVERVIEW_WARN_CHARS = 2000;

/** Strip HTML tags so the counter and the editorial cap measure the *visible*
 *  text the reader sees, not the markup byte count (a bio full of links/emphasis
 *  otherwise trips the 2,500 cap far below 2,500 visible characters). The 20,000
 *  server ceiling still measures raw HTML — this is only the human-facing count. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

// #742 generator copy — verbatim from
// `overview-statement-generator-spec.md` § Copy (initial). Kept as named
// constants so the strings live in one place and the tests assert against them.
const GENERATE_SPARSE =
  "We don't have enough of your work indexed to draft an overview yet. You can write your own, or review My Publications first.";
const GENERATE_RATE_LIMITED =
  "You've generated several drafts recently — please try again in a little while.";
const GENERATE_FAILED = "We couldn't generate a draft just now. Please try again.";
const GENERATE_DEBUG_FAILED = "Couldn't prepare the prompt payload. Please try again.";

// #875 §6 — the two pre-generation conditional hints (verbatim from the spec).
const HINT_SPARSE_SOURCES = "Limited sources may produce a generic draft.";

/** A fresh, all-empty source selection (before the source-options load). */
const EMPTY_SELECTION: OverviewSelection = { pmids: [], grantIds: [], toolNames: [] };

/** Restore a persisted selection (#765 — "Use these settings") against the
 *  CURRENT candidate pool: drop any pmids / grantIds / toolNames the scholar's
 *  corpus no longer offers (a draft can predate a corpus change), mirroring the
 *  server-side ownership filter so stale ids never re-enter selection state. */
function clampSelectionToOptions(
  selection: OverviewSelection,
  options: OverviewSourceOptions,
): OverviewSelection {
  const pmids = new Set(options.publications.map((p) => p.pmid));
  const grantIds = new Set(options.funding.map((f) => f.id));
  const toolNames = new Set(options.tools.map((t) => t.toolName));
  return {
    pmids: selection.pmids.filter((p) => pmids.has(p)),
    grantIds: selection.grantIds.filter((g) => grantIds.has(g)),
    toolNames: selection.toolNames.filter((t) => toolNames.has(t)),
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
  /**
   * Who is editing: the scholar themselves (`self`) or a superuser on their
   * behalf (`superuser`). Only reframes the provenance note's first-person copy
   * (#1077 follow-up) — a superuser must not be told the bio was "written by
   * you". Mirrors the `mode` reframing the sibling cards already take.
   */
  mode?: "self" | "superuser";
  /**
   * #742 prompt versioning. `canSelectPromptVersion` (superuser / curator only)
   * shows the version dropdown; a faculty owner never sees it and always generates
   * on `defaultPromptVersion`. `promptVersions` are the selectable versions with
   * their RESOLVED effective model (server-filled). `defaultPromptVersion` is the
   * live default id (env rollback honored) — seeds the params so the value the
   * client sends matches the server default.
   */
  canSelectPromptVersion?: boolean;
  promptVersions?: OverviewPromptVersionMeta[];
  defaultPromptVersion?: OverviewPromptVersionId;
  /**
   * Whether to show the superuser "View prompt & payload" debug affordance (the raw
   * FACTS projection is internal data). STRICTLY superuser — set by `edit-page`,
   * mirroring the biosketch tool's gate.
   */
  canDebug?: boolean;
  /**
   * Whether the generate route streams its response (`SELF_EDIT_OVERVIEW_GENERATE_STREAM`).
   * When true the client reads NDJSON and drives the `<OverviewProgress>` bar; off ⇒ the
   * buffered path (the prior behavior). Server-evaluated and passed in.
   */
  streamEnabled?: boolean;
  /**
   * The scholar's display name when someone else is editing (superuser / proxy /
   * unit-admin) — the description reads "Shown at the top of {name}'s public
   * profile." Omitted on the self surface ("your public profile").
   */
  scholarName?: string;
};

/** One history row, shaped to match the GET /api/edit/overview/generations
 *  contract (`createdAt` is the ISO string the route serializes). The generate
 *  route persists the source `selection` (v3.1) inside the same `params` JSON
 *  column, so "Use settings" can restore it (#765). `promptVersion` is the
 *  dedicated column (#742); null on rows written before versioning shipped. */
export type OverviewGenerationItem = {
  id: string;
  model: string;
  promptVersion?: string | null;
  params: OverviewParams & { selection?: OverviewSelection };
  createdAt: string;
  text: string;
};

/** One draft the review bar can page through: a session draft (just generated)
 *  or a persisted `OverviewGeneration` row. */
type OverviewReviewDraft = {
  /** The generated HTML to review. */
  text: string;
  /** The OverviewGeneration row id, or null for a history write that hiccuped. */
  generationId: string | null;
  /** ISO timestamp the draft was generated. */
  createdAt: string;
  /** The settings it was generated with (history rows carry the selection too). */
  params?: OverviewGenerationItem["params"];
};

/** A draft's stable key — its generation id, else its timestamp. */
function draftKey(d: OverviewReviewDraft): string {
  return d.generationId ?? d.createdAt;
}

export function OverviewCard({
  cwid,
  initialHtml,
  previewHref,
  readOnly = false,
  generateEnabled = false,
  mode = "self",
  canSelectPromptVersion = false,
  promptVersions = [],
  defaultPromptVersion,
  canDebug = false,
  streamEnabled = false,
  scholarName,
}: OverviewCardProps) {
  if (readOnly) return <OverviewReadOnlyCard initialHtml={initialHtml} />;
  return (
    <OverviewEditorCard
      cwid={cwid}
      initialHtml={initialHtml}
      previewHref={previewHref}
      generateEnabled={generateEnabled}
      mode={mode}
      canSelectPromptVersion={canSelectPromptVersion}
      promptVersions={promptVersions}
      defaultPromptVersion={defaultPromptVersion}
      canDebug={canDebug}
      streamEnabled={streamEnabled}
      scholarName={scholarName}
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
          className={cn(
            "border-apollo-border bg-apollo-surface-2 rounded-md border px-4 py-3",
            // #2579 — `prose prose-sm` here styled nothing; the read-only
            // preview dropped links and list markers the published page shows.
            OVERVIEW_HTML_CLASS,
          )}
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
  | "cwid"
  | "initialHtml"
  | "previewHref"
  | "generateEnabled"
  | "mode"
  | "canSelectPromptVersion"
  | "promptVersions"
  | "defaultPromptVersion"
  | "canDebug"
  | "streamEnabled"
  | "scholarName"
>;

function OverviewEditorCard({
  cwid,
  initialHtml,
  previewHref,
  generateEnabled = false,
  mode = "self",
  canSelectPromptVersion = false,
  promptVersions = [],
  defaultPromptVersion,
  canDebug = false,
  streamEnabled = false,
  scholarName,
}: OverviewEditorCardProps) {
  // The currently-published bio — the dirty baseline.
  const [savedHtml, setSavedHtml] = React.useState(initialHtml);

  // #742 Phase B — draft history + provenance, owner-only. `generations` drives
  // the in-card "Draft N of M" affordance; `provenance` is the one-line origin
  // of the *currently saved* bio.
  const [generations, setGenerations] = React.useState<OverviewGenerationItem[]>([]);
  const [provenance, setProvenance] = React.useState<OverviewProvenanceLine | null>(null);
  // #1077 — has the provenance read resolved? Gates the imported-bio fallback in
  // the note so it never flashes before the fetch lands.
  const [provenanceLoaded, setProvenanceLoaded] = React.useState(false);

  // Re-read the owner's draft history + the saved bio's provenance. Best-effort:
  // a failed read leaves the panel/line in their last state.
  const refreshGenerations = React.useCallback(async () => {
    if (!generateEnabled) return;
    try {
      // #986 — key the history to the scholar being edited (`cwid`), not the
      // viewer. On `/edit/scholar/X` for a superuser, `cwid` is X; the route
      // authorizes the foreign read with the same predicate as the generate write.
      const res = await fetch(
        `/api/edit/overview/generations?cwid=${encodeURIComponent(cwid)}`,
        { method: "GET" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as OverviewGenerationsResponse;
      setGenerations(Array.isArray(data.generations) ? data.generations : []);
      setProvenance(data.provenance ?? null);
    } catch {
      // Swallow — the history panel is non-essential and must never disrupt the editor.
    } finally {
      // #1077 — mark the read resolved either way so the note can decide between
      // a real "Last updated" line and the imported-bio fallback (vs. nothing).
      setProvenanceLoaded(true);
    }
  }, [generateEnabled, cwid]);

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
    <OverviewGeneratorArm
        cwid={cwid}
        editor={editor}
        savedHtml={savedHtml}
        provenance={provenance}
        provenanceLoaded={provenanceLoaded}
        mode={mode}
        scholarName={scholarName}
        generations={generations}
        refreshGenerations={refreshGenerations}
        previewHref={previewHref}
        canSelectPromptVersion={canSelectPromptVersion}
        promptVersions={promptVersions}
        defaultPromptVersion={defaultPromptVersion}
        canDebug={canDebug}
        streamEnabled={streamEnabled}
      />
  );
}

// ---------------------------------------------------------------------------
// Editor state hook — the save/dirty/counter mechanics in one place, shared by
// the manual surface and the generator arm.
// ---------------------------------------------------------------------------

type UseOverviewEditor = {
  /** Live editor HTML (the dirty baseline + the save payload). */
  currentHtml: string;
  /** Visible text length (tags stripped) — what the counter displays and what the
   *  editorial cap / near-limit gate measure. */
  textLength: number;
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
  // The human-facing editorial measures gate on VISIBLE text length (tags
  // stripped), not the markup byte count. `overLimit` stays on the raw HTML
  // length — the 20,000 ceiling is on the stored sanitized HTML (mirrors the
  // server `sanitizeOverview` cap).
  const textLength = stripTags(currentHtml).length;
  const overEditorialLimit = textLength > OVERVIEW_EDITORIAL_MAX;
  const nearLimit = textLength >= OVERVIEW_WARN_CHARS;
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
    textLength,
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
// The generator arm — header (status + History), the editor column, and the
// Draft-with-AI rail. Generation lands a draft in review, NEVER the editor; Use
// this draft / Insert below are the only paths into the editor, and both carry
// the generation id for provenance.
// ---------------------------------------------------------------------------

const AMBER_PILL =
  "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber rounded-full border px-2 py-px text-xs font-medium";
const NEUTRAL_PILL =
  "bg-apollo-surface-2 text-muted-foreground rounded-full px-2 py-px text-xs font-medium";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Third person · Standard · Formal · informed readers" — a draft's settings. */
function draftSettings(params: OverviewParams | undefined): string {
  if (!params) return "";
  const voice = params.voice === "first" ? "First person" : "Third person";
  const length = params.length.charAt(0).toUpperCase() + params.length.slice(1);
  const tone = TONE_AUDIENCE.find((t) => t.audience === params.audience)?.label ?? params.tone;
  return [voice, length, tone].join(" · ");
}

function OverviewGeneratorArm({
  cwid,
  editor,
  savedHtml,
  provenance,
  provenanceLoaded,
  mode,
  scholarName,
  generations,
  refreshGenerations,
  previewHref,
  canSelectPromptVersion = false,
  promptVersions = [],
  defaultPromptVersion,
  canDebug = false,
  streamEnabled = false,
}: {
  cwid: string;
  editor: UseOverviewEditor;
  savedHtml: string;
  provenance: OverviewProvenanceLine | null;
  provenanceLoaded: boolean;
  mode: "self" | "superuser";
  scholarName?: string;
  generations: OverviewGenerationItem[];
  refreshGenerations: () => Promise<void>;
  previewHref?: string;
  canSelectPromptVersion?: boolean;
  promptVersions?: OverviewPromptVersionMeta[];
  defaultPromptVersion?: OverviewPromptVersionId;
  canDebug?: boolean;
  streamEnabled?: boolean;
}) {
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [generateNotice, setGenerateNotice] = React.useState<string | null>(null);
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  // Streamed-generation progress (#917 follow-up A, ported). `progress` is non-null only
  // while a streamed run is in flight; `elapsedMs` advances a 1s timer so the bar feels
  // alive within a phase. `isDebugLoading` gates the superuser "View prompt & payload".
  const [progress, setProgress] = React.useState<OverviewProgressState | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [isDebugLoading, setIsDebugLoading] = React.useState(false);
  const elapsedTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Seed the version from the server-resolved default so the value the client
  // sends matches the live default (the route forces it anyway for an owner, but
  // a superuser / curator's selector should open on the real default).
  const [params, setParams] = React.useState<OverviewParams>(() => ({
    ...DEFAULT_OVERVIEW_PARAMS,
    promptVersion: defaultPromptVersion ?? DEFAULT_OVERVIEW_PARAMS.promptVersion,
  }));

  // Drafts generated this session (newest first); merged with the persisted
  // history below so the review bar pages through ALL drafts.
  const [sessionDrafts, setSessionDrafts] = React.useState<OverviewReviewDraft[]>([]);
  // The draft under review (by `draftKey`); null = no review in progress.
  const [reviewKey, setReviewKey] = React.useState<string | null>(null);
  // While reviewing: show the draft preview or the (editable) current text.
  const [view, setView] = React.useState<"draft" | "current">("draft");
  // The generation id that produced the editor's CURRENT content — set on
  // Use / Insert, cleared on Save / hand-edit / discard.
  const [currentGenerationId, setCurrentGenerationId] = React.useState<string | null>(null);
  // What the editor held before the last Use / Insert — "Restore previous text".
  const [previous, setPrevious] = React.useState<{
    html: string;
    generationId: string | null;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [sourcesOpen, setSourcesOpen] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  // The source picker. Fetch the candidate lists once and seed the selection
  // from the populated default. Best-effort: a failed fetch leaves the picker
  // disabled, not the editor — generation still defaults server-side.
  const [sourceOptions, setSourceOptions] = React.useState<OverviewSourceOptions | null>(null);
  // The durable three-state deltas (#742 §2.5), loaded from + saved to
  // `/api/edit/overview/selection`. The generation SNAPSHOT is derived from them.
  const [deltas, setDeltas] = React.useState<OverviewSelectionDeltas>(
    DEFAULT_OVERVIEW_SELECTION_DELTAS,
  );

  // The generation snapshot, DERIVED from the deltas applied to the recommended
  // auto-set (`defaultSelected`); with no deltas it equals the pure default. The
  // §6 hints, the generate POST, and the source-count readout all read this.
  const selection = React.useMemo<OverviewSelection>(
    () => (sourceOptions ? resolveOverviewSelection(sourceOptions, deltas) : EMPTY_SELECTION),
    [sourceOptions, deltas],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // #986 — candidate sources for the scholar being edited (`cwid`), not the
        // viewer. The route authorizes a foreign `?cwid` with the generate-write
        // predicate, so a superuser on `/edit/scholar/X` drafts from X's corpus.
        const res = await fetch(
          `/api/edit/overview/source-options?cwid=${encodeURIComponent(cwid)}`,
          { method: "GET" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { ok: true } & OverviewSourceOptions;
        if (cancelled) return;
        const options: OverviewSourceOptions = {
          publications: Array.isArray(data.publications) ? data.publications : [],
          funding: Array.isArray(data.funding) ? data.funding : [],
          tools: Array.isArray(data.tools) ? data.tools : [],
        };
        setSourceOptions(options);
      } catch {
        // Swallow — the picker is a convenience; generation defaults server-side.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwid]);

  // Load the scholar's durable selection deltas alongside the candidate lists.
  // Best-effort: a failed read leaves the pure auto-set (the default deltas).
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/edit/overview/selection?cwid=${encodeURIComponent(cwid)}`,
          { method: "GET" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { ok: true; deltas: OverviewSelectionDeltas };
        if (!cancelled && data?.deltas) setDeltas(data.deltas);
      } catch {
        // Swallow — generation defaults to the auto-set server-side.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwid]);

  // Commit edited deltas: update local state AND persist them (best-effort — the
  // resolved selection still drives this session's generation if the write fails).
  const commitDeltas = React.useCallback(
    (next: OverviewSelectionDeltas) => {
      setDeltas(next);
      void fetch(`/api/edit/overview/selection?cwid=${encodeURIComponent(cwid)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deltas: next }),
      }).catch(() => {
        // Swallow — durability is best-effort; the in-session selection holds.
      });
    },
    [cwid],
  );

  // Every draft, newest first: this session's, then the persisted history
  // (de-duped by key — a session draft and its history row are the same draft).
  const drafts = React.useMemo<OverviewReviewDraft[]>(() => {
    const seen = new Set<string>();
    const out: OverviewReviewDraft[] = [];
    for (const d of [
      ...sessionDrafts,
      ...generations.map((g) => ({
        text: g.text,
        generationId: g.id,
        createdAt: g.createdAt,
        params: g.params,
      })),
    ]) {
      const k = draftKey(d);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
    return out;
  }, [sessionDrafts, generations]);
  const draftNumber = (i: number) => drafts.length - i; // oldest = 1

  const reviewIndex = reviewKey == null ? -1 : drafts.findIndex((d) => draftKey(d) === reviewKey);
  const reviewDraft = reviewIndex >= 0 ? drafts[reviewIndex] : null;
  const viewingDraft = reviewDraft != null && view === "draft";

  const busy = isGenerating || editor.isSaving;

  // Editing by hand un-links the text from its generation: hand-written text
  // is `authored`, not `generated_edited`. Use / Insert re-link it.
  const handleEditorChange = React.useCallback(
    (html: string) => {
      setGenerateError(null);
      setCurrentGenerationId(null);
      editor.handleChange(html);
    },
    [editor],
  );

  // §6 pre-generation hints, reading the LIVE selection + params (client-only).
  const conflictAwards = params.elements.includes("grants_funding") ? 0 : selection.grantIds.length;
  const showSparseHint =
    sourceOptions != null && selection.pmids.length <= 1 && selection.grantIds.length === 0;

  // The elapsed-time counter that gives the streamed progress bar liveness within a
  // single phase (a real timer, not a fake progress animation).
  const startElapsedTimer = React.useCallback(() => {
    const startedAt = Date.now();
    setElapsedMs(0);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
  }, []);
  const stopElapsedTimer = React.useCallback(() => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);
  React.useEffect(() => stopElapsedTimer, [stopElapsedTimer]);

  async function generate() {
    if (busy) return;
    setIsGenerating(true);
    setGenerateError(null);
    setGenerateNotice(null);
    if (streamEnabled) {
      setProgress({ phase: "drafting" });
      startElapsedTimer();
    }
    try {
      const res = await fetch("/api/edit/overview/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The source selection rides along with the steering params (v3.1); the
        // server re-normalizes / ownership-filters it.
        body: JSON.stringify({ entityId: cwid, params, selection }),
      });
      // The response is NDJSON when the stream flag is on AND generation actually ran
      // (a pre-flight failure on the stream route is still a buffered JSON error), so
      // branch on the content-type — both the streamed and buffered shapes then parse.
      const isStream = (res.headers.get("content-type") ?? "").includes("application/x-ndjson");
      const result: OverviewStreamResult | null = isStream
        ? await readOverviewStream(res, (p) => setProgress(p))
        : ((await res.json().catch(() => null)) as OverviewStreamResult | null);

      if (!result || result.ok !== true || (!isStream && !res.ok)) {
        // Editor untouched on any failure (G8) — only a notice or error appears.
        const code =
          result && "error" in result && typeof result.error === "string" ? result.error : "";
        if (code === "insufficient_facts") {
          setGenerateNotice(GENERATE_SPARSE);
        } else if (code === "rate_limited") {
          setGenerateError(GENERATE_RATE_LIMITED);
        } else {
          setGenerateError(GENERATE_FAILED);
        }
        return;
      }
      // The stream result is loosely typed (Record); the buffered body is the same shape.
      // Coerce the fields defensively.
      const draft: OverviewReviewDraft = {
        text: typeof result.draft === "string" ? result.draft : "",
        generationId: typeof result.generationId === "string" ? result.generationId : null,
        createdAt: new Date().toISOString(),
        params: { ...params, selection },
      };
      // Land the draft in review — NEVER the editor.
      setSessionDrafts((prev) => [draft, ...prev]);
      setReviewKey(draftKey(draft));
      setView("draft");
      setSourcesOpen(false);
      void refreshGenerations();
    } catch {
      setGenerateError(GENERATE_FAILED);
    } finally {
      setIsGenerating(false);
      setProgress(null);
      stopElapsedTimer();
    }
  }

  // Superuser-only: download the EXACT system prompt + user prompt + FACTS payload these
  // settings would send to the model, WITHOUT spending a generation (parity with the
  // biosketch "View prompt & payload" affordance). Errors surface in the generate-error slot.
  async function downloadDebugPayload() {
    if (busy || isDebugLoading) return;
    setIsDebugLoading(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/edit/overview/debug-payload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: cwid, params }),
      });
      const data = (await res.json().catch(() => null)) as
        | ({ ok: true; promptVersion?: string } & Record<string, unknown>)
        | { ok: false }
        | null;
      if (!res.ok || !data || data.ok !== true) {
        setGenerateError(GENERATE_DEBUG_FAILED);
        return;
      }
      const version =
        "promptVersion" in data && typeof data.promptVersion === "string"
          ? data.promptVersion
          : "draft";
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `overview-prompt-${cwid}-${version}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setGenerateError(GENERATE_DEBUG_FAILED);
    } finally {
      setIsDebugLoading(false);
    }
  }

  // Use this draft / Insert below: write the reviewed draft into the editor
  // (remembering what was there for "Restore previous text"); the editor's
  // content is now generated, so Save records provenance.
  function takeDraft(html: string) {
    if (!reviewDraft) return;
    setPrevious({ html: editor.currentHtml, generationId: currentGenerationId });
    editor.reseed(html);
    setCurrentGenerationId(reviewDraft.generationId);
    setReviewKey(null);
  }

  function restorePrevious() {
    if (!previous) return;
    editor.reseed(previous.html);
    setCurrentGenerationId(previous.generationId);
    setPrevious(null);
  }

  function review(d: OverviewReviewDraft) {
    if (busy) return;
    setReviewKey(draftKey(d));
    setView("draft");
    setHistoryOpen(false);
    setSourcesOpen(false);
    setGenerateError(null);
  }

  // Restore the steering params AND the source selection a draft was generated
  // with (#765). The persisted selection rides inside `params` (v3.1); split it
  // out so it never leaks into params state, clamp it to the current candidate
  // pool in case the corpus changed, then map the snapshot back to deltas against
  // today's auto-set (§2.5 — kept non-defaults pin, dropped defaults veto).
  function applySettings(d: OverviewReviewDraft) {
    if (!d.params) return;
    const { selection: savedSelection, ...steering } = d.params;
    setParams(steering);
    if (savedSelection && sourceOptions) {
      commitDeltas(
        selectionToDeltas(
          sourceOptions,
          clampSelectionToOptions(savedSelection, sourceOptions),
          deltas,
        ),
      );
    }
  }

  const hasSaved = savedHtml.trim().length > 0;
  const status: { label: string; amber: boolean } | null = reviewDraft
    ? { label: "Draft pending review", amber: true }
    : editor.dirty
      ? { label: "Unsaved changes", amber: true }
      : provenance
        ? { label: `Edited ${formatDate(provenance.updatedAt)}`, amber: false }
        : provenanceLoaded && hasSaved
          ? { label: "Imported · not edited here", amber: false }
          : null;

  const historyCount = drafts.length + (hasSaved ? 1 : 0);
  const selectedVersion = promptVersions.find((v) => v.id === params.promptVersion);
  const showVersionSelector = canSelectPromptVersion && promptVersions.length > 0;
  const cost = selectedVersion?.model ? estimateDraftCostUsd(selectedVersion.model) : null;

  return (
    <EditPanel
      slot="overview-card"
      heading="Overview"
      owned
      headingBadge={
        status && (
          <span
            className={status.amber ? AMBER_PILL : NEUTRAL_PILL}
            data-testid="overview-status"
          >
            {status.label}
          </span>
        )
      }
      headerAction={
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          aria-expanded={historyOpen}
          className={cn(
            "text-foreground inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px]",
            historyOpen
              ? "bg-apollo-surface-2 border-[#8a847c]"
              : "border-apollo-border-strong bg-apollo-surface",
          )}
          data-testid="overview-history-toggle"
        >
          <History className="size-3.5" aria-hidden="true" />
          History
          <span className="bg-apollo-surface-2 text-muted-foreground rounded-lg px-1.5 text-[11px] font-semibold">
            {historyCount}
          </span>
        </button>
      }
      description={
        scholarName
          ? `Shown at the top of ${scholarName}’s public profile.`
          : "Shown at the top of your public profile."
      }
    >
      <UnsavedChangesGuard dirty={editor.dirty} />
      {/* How the published text was produced — the imported case is the pill. */}
      {provenance && (
        <OverviewProvenanceNote
          provenance={provenance}
          loaded={provenanceLoaded}
          hasSavedOverview={hasSaved}
          mode={mode}
        />
      )}

      {historyOpen && (
        <div
          className="border-apollo-border-strong overflow-hidden rounded-lg border"
          data-testid="overview-versions-panel"
        >
          <div className="border-apollo-border bg-apollo-surface-2 text-muted-foreground border-b px-3.5 py-2.5 text-xs font-semibold tracking-[0.06em] uppercase">
            Drafts &amp; versions
          </div>
          <ul>
            {drafts.map((d, i) => {
              const tag =
                reviewKey === draftKey(d)
                  ? "Reviewing"
                  : d.generationId && d.generationId === currentGenerationId
                    ? "In editor"
                    : null;
              return (
                <li
                  key={draftKey(d)}
                  className="border-apollo-border flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3.5 py-2.5 first:border-t-0"
                  data-testid={`overview-version-${d.generationId ?? d.createdAt}`}
                >
                  <span className="flex w-[150px] flex-col">
                    <span className="text-sm font-medium">AI draft {draftNumber(i)}</span>
                    <span className="text-muted-foreground text-xs">{formatWhen(d.createdAt)}</span>
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 text-[13px]">
                    {draftSettings(d.params)}
                  </span>
                  {tag && (
                    <span className="bg-apollo-surface-2 text-muted-foreground rounded-full px-2 py-px text-xs">
                      {tag}
                    </span>
                  )}
                  {d.params && (
                    <button
                      type="button"
                      onClick={() => applySettings(d)}
                      disabled={busy}
                      className="text-muted-foreground text-[13px] underline underline-offset-2"
                      data-testid={`overview-version-use-settings-${d.generationId ?? d.createdAt}`}
                    >
                      Use settings
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => review(d)}
                    disabled={busy}
                    className="text-foreground text-[13px] underline underline-offset-2"
                    data-testid={`overview-version-load-${d.generationId ?? d.createdAt}`}
                  >
                    Review
                  </button>
                </li>
              );
            })}
            {hasSaved && (
              <li className="border-apollo-border flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3.5 py-2.5 first:border-t-0">
                <span className="flex w-[150px] flex-col">
                  <span className="text-sm font-medium">
                    {provenance ? "Published version" : "Imported text"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {provenance ? formatWhen(provenance.updatedAt) : "Previous profile system"}
                  </span>
                </span>
                <span className="text-muted-foreground min-w-0 flex-1 text-[13px]">
                  {provenance
                    ? "What the public profile shows now"
                    : "Original overview before any edits here"}
                </span>
                <span className="bg-apollo-surface-2 text-muted-foreground rounded-full px-2 py-px text-xs">
                  Published
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          {sourcesOpen && sourceOptions ? (
            <OverviewSourcePanel
              options={sourceOptions}
              deltas={deltas}
              staleDraft={reviewDraft != null}
              disabled={busy}
              onClose={(next) => {
                if (next !== deltas) commitDeltas(next);
                setSourcesOpen(false);
              }}
            />
          ) : (
            <>
              {reviewDraft && (
                <div
                  className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5"
                  data-testid="overview-draft-review-card"
                >
                  <Sparkles className="size-4 shrink-0" aria-hidden="true" />
                  <div className="flex min-w-[200px] flex-1 flex-col gap-px">
                    <span className="text-sm font-semibold">
                      AI draft {draftNumber(reviewIndex)} of {drafts.length}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {[formatWhen(reviewDraft.createdAt), draftSettings(reviewDraft.params)]
                        .filter(Boolean)
                        .join(" · ")}{" "}
                      · nothing changes until you use it
                    </span>
                  </div>
                  {drafts.length > 1 && (
                    <div className="flex items-center gap-0.5" data-testid="overview-draft-pager">
                      <button
                        type="button"
                        onClick={() => setReviewKey(draftKey(drafts[reviewIndex + 1]))}
                        disabled={busy || reviewIndex >= drafts.length - 1}
                        aria-label="Previous draft"
                        className="flex size-[26px] items-center justify-center rounded-md disabled:opacity-40"
                        data-testid="overview-draft-prev"
                      >
                        <ChevronLeft className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setReviewKey(draftKey(drafts[reviewIndex - 1]))}
                        disabled={busy || reviewIndex <= 0}
                        aria-label="Next draft"
                        className="flex size-[26px] items-center justify-center rounded-md disabled:opacity-40"
                        data-testid="overview-draft-next"
                      >
                        <ChevronRight className="size-3.5" />
                      </button>
                    </div>
                  )}
                  <div
                    role="group"
                    aria-label="Show"
                    className="border-apollo-border bg-apollo-surface flex gap-0.5 rounded-[7px] border p-0.5"
                  >
                    {(
                      [
                        ["current", "Current text"],
                        ["draft", "AI draft"],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setView(k)}
                        aria-pressed={view === k}
                        className={cn(
                          "rounded-[5px] px-3 py-1 text-[13px]",
                          view === k
                            ? "bg-apollo-surface-2 text-foreground font-semibold"
                            : "text-muted-foreground",
                        )}
                        data-testid={`overview-review-view-${k}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {viewingDraft && reviewDraft ? (
                <>
                  <div className="rounded-lg border border-[#8a847c] bg-[#fdfcfb] shadow-[0_0_0_3px_rgba(44,38,35,0.08)]">
                    <div className="border-apollo-border text-muted-foreground flex justify-end border-b px-3 py-2 text-xs">
                      Draft preview · read only
                    </div>
                    <div
                      className={cn("px-[18px] py-4 text-[15px] leading-relaxed", OVERVIEW_HTML_CLASS)}
                      dangerouslySetInnerHTML={{ __html: reviewDraft.text }}
                      data-testid="overview-draft-body"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="apollo"
                      size="sm"
                      onClick={() => takeDraft(reviewDraft.text)}
                      disabled={busy}
                      data-testid="overview-draft-replace"
                    >
                      Use this draft
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => takeDraft(editor.currentHtml + reviewDraft.text)}
                      disabled={busy}
                      data-testid="overview-draft-insert"
                    >
                      Insert below
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setReviewKey(null)}
                      disabled={busy}
                      data-testid="overview-draft-discard"
                    >
                      Discard
                    </Button>
                    <span className="text-muted-foreground text-[13px]">
                      Replaces the text in the editor. You can still edit before saving.
                    </span>
                  </div>
                </>
              ) : (
                <OverviewEditorBody
                  editor={editor}
                  sourceGenerationId={currentGenerationId}
                  previewHref={previewHref}
                  sourceCounts={
                    sourceOptions != null
                      ? { publications: selection.pmids.length, awards: selection.grantIds.length }
                      : null
                  }
                  onChange={handleEditorChange}
                  onRestorePrevious={previous ? restorePrevious : undefined}
                  publishTarget={scholarName ? "the public profile" : "your public profile"}
                  withGenerator
                />
              )}
            </>
          )}
        </div>

        <aside
          className="bg-apollo-rail border-apollo-rail-border flex flex-col rounded-[10px] border lg:sticky lg:top-4"
          data-testid="overview-draft-block"
        >
          <div className="border-apollo-rail-border flex items-center gap-2 border-b px-4 py-3.5">
            <span className="text-[15px] font-semibold">Draft with AI</span>
            <span
              className="bg-apollo-surface border-apollo-border-strong text-muted-foreground rounded border px-1.5 text-[11px] font-semibold tracking-[0.04em]"
              data-testid="overview-generator-beta"
            >
              BETA
            </span>
          </div>

          <OverviewGenerateControls
            value={params}
            onChange={setParams}
            disabled={busy}
            emphasisNote={
              <>
                {conflictAwards > 0 && (
                  <div
                    className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                    data-testid="overview-hint-emphasis-conflict"
                  >
                    <span className="flex-1">
                      {conflictAwards === 1
                        ? "1 award is in sources but won’t be mentioned."
                        : `${conflictAwards} awards are in sources but won’t be mentioned.`}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setParams((p) => ({
                          ...p,
                          elements: OVERVIEW_ELEMENTS.map((e) => e.key).filter(
                            (k) => p.elements.includes(k) || k === "grants_funding",
                          ),
                        }))
                      }
                      disabled={busy}
                      className="font-semibold underline underline-offset-2"
                      data-testid="overview-hint-include-grants"
                    >
                      {conflictAwards === 1 ? "Include it" : "Include them"}
                    </button>
                  </div>
                )}
                {showSparseHint && (
                  <p
                    className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber rounded-md border px-2 py-1.5 text-xs"
                    data-testid="overview-hint-sparse-sources"
                  >
                    {HINT_SPARSE_SOURCES}
                  </p>
                )}
              </>
            }
            sources={
              <OverviewSourcesRow
                options={sourceOptions}
                deltas={deltas}
                open={sourcesOpen}
                onToggle={() => setSourcesOpen((o) => !o)}
                disabled={busy}
              />
            }
          />

          <div className="flex flex-col gap-2 px-4 py-3.5">
            <button
              type="button"
              onClick={generate}
              disabled={busy}
              className="bg-apollo-bar h-9 rounded-lg text-sm font-medium text-white disabled:cursor-progress disabled:opacity-70"
              data-testid="overview-generate"
            >
              {isGenerating ? "Generating…" : reviewDraft ? "Regenerate draft" : "Generate draft"}
            </button>
            <span className="text-muted-foreground text-center text-xs">
              You review the draft before anything changes.
            </span>
            {/* Streamed-generation progress bar (#917 follow-up A) — present only while a
                streamed run is in flight; the buffered path leaves `progress` null. */}
            {progress && <OverviewProgress state={progress} elapsedMs={elapsedMs} />}
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
          </div>

          {(showVersionSelector || canDebug) && (
            <div className="border-apollo-rail-border border-t">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                aria-expanded={advancedOpen}
                className="text-muted-foreground flex w-full items-center gap-2 px-4 py-2.5 text-xs"
                data-testid="overview-advanced-toggle"
              >
                <Settings2 className="size-3.5" aria-hidden="true" />
                <span className="flex-1 text-left">Advanced · superusers only</span>
                <span aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
              </button>
              {advancedOpen && (
                <div className="text-muted-foreground flex flex-col gap-2 px-4 pb-3.5 text-xs">
                  {showVersionSelector && (
                    <>
                      <select
                        value={params.promptVersion}
                        disabled={busy}
                        onChange={(e) =>
                          setParams((p) => ({
                            ...p,
                            promptVersion: e.target.value as OverviewPromptVersionId,
                          }))
                        }
                        aria-label="Prompt version"
                        className="border-apollo-border-strong bg-apollo-surface text-foreground h-[30px] rounded-md border px-2 text-xs"
                        data-testid="overview-prompt-version"
                      >
                        {promptVersions.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                      {selectedVersion?.description && <span>{selectedVersion.description}</span>}
                      {selectedVersion?.model && (
                        <span data-testid="overview-prompt-version-model">
                          Model: {humanizeModelId(selectedVersion.model)}
                          {cost != null && (
                            <span data-testid="overview-prompt-version-cost">
                              {" "}
                              · ~${cost.toFixed(2)} per draft
                            </span>
                          )}
                        </span>
                      )}
                    </>
                  )}
                  {canDebug && (
                    <button
                      type="button"
                      onClick={downloadDebugPayload}
                      disabled={busy || isDebugLoading}
                      className="text-foreground w-fit underline underline-offset-2"
                      title="Download the exact system prompt, user prompt, and FACTS payload these settings would send to the model (superusers only)."
                      data-testid="overview-debug-payload"
                    >
                      {isDebugLoading ? "Preparing…" : "View prompt & payload"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </EditPanel>
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
  onRestorePrevious,
  publishTarget = "your public profile",
  withGenerator = false,
}: {
  editor: UseOverviewEditor;
  sourceGenerationId?: string | null;
  previewHref?: string;
  /** Live selected counts for the empty-state on-ramp; null while loading or on
   *  the manual surface (no source data) → count-less fallback copy. */
  sourceCounts: { publications: number; awards: number } | null;
  /** Override the editor's onChange (the generator arm un-links provenance). */
  onChange?: (html: string) => void;
  /** Undo the last Use this draft / Insert below; absent when there's nothing to undo. */
  onRestorePrevious?: () => void;
  publishTarget?: string;
  /** The Draft-with-AI rail is present — the empty-state points at it. */
  withGenerator?: boolean;
}) {
  const isEmpty = editor.currentHtml.trim().length === 0;

  return (
    <>
      <OverviewEditor
        key={editor.editorKey}
        initialHtml={editor.currentHtml}
        onChange={onChange ?? editor.handleChange}
      />
      {isEmpty && (
        <p className="text-muted-foreground text-sm" data-slot="overview-editor-empty">
          {sourceCounts
            ? `No overview yet. Generate a draft from your ${sourceCounts.publications} ${plural(
                sourceCounts.publications,
                "publication",
              )} and ${sourceCounts.awards} ${plural(
                sourceCounts.awards,
                "award",
              )} with Draft with AI, or start writing here.`
            : withGenerator
              ? "No overview yet. Generate a draft with Draft with AI, or start writing here."
              : "No overview yet. Start writing here."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-live="polite"
          className={cn(
            "text-[13px] tabular-nums",
            editor.overLimit || editor.overEditorialLimit
              ? "text-destructive"
              : editor.nearLimit
                ? "text-apollo-amber"
                : "text-muted-foreground",
          )}
          data-testid="overview-counter"
        >
          {editor.textLength.toLocaleString()} / {OVERVIEW_EDITORIAL_MAX.toLocaleString()}
        </span>
        {onRestorePrevious && (
          <button
            type="button"
            onClick={onRestorePrevious}
            className="text-muted-foreground text-[13px] underline underline-offset-2"
            data-testid="overview-restore-previous"
          >
            Restore previous text
          </button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
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
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px]">
            <Globe className="size-3.5" aria-hidden="true" />
            Publishes to {publishTarget} immediately
          </span>
          {editor.dirty && (
            <Button
              type="button"
              variant="outline"
              size="sm"
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
            size="sm"
            onClick={() => editor.save(sourceGenerationId)}
            disabled={!editor.dirty || editor.overEditorialLimit || editor.isSaving}
            data-testid="overview-save"
          >
            {editor.isSaving ? "Saving…" : "Save overview"}
          </Button>
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
