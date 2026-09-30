/**
 * `BiosketchTool` — the client orchestrator for the NIH-biosketch prose
 * generator (#917 v5). Holds the steering params, renders
 * {@link BiosketchGenerateControls} + a Generate button, POSTs to
 * `POST /api/edit/biosketch/generate`, and renders {@link BiosketchResultCard}
 * on success.
 *
 * The output is a COPY/EXPORT artifact: there is no save-to-profile flow. The
 * fetch/error conventions mirror the overview generate client
 * (`overview-card.tsx` → `OverviewGeneratorArm.generate`): parse the
 * `{ ok: false, error }` shape the `/api/edit/*` routes return and map each code
 * to a friendly message.
 *
 * Generate is disabled while a request is in flight and while the Personal
 * Statement sub-mode is missing its required project title / aims (reusing
 * `missingPersonalStatementInputs`, the same predicate the route enforces), so a
 * request that the route would 400 never leaves the client.
 *
 * Layout: one mode chooser (three cards: Contributions, Personal Statement, and the
 * deterministic "Find publications") replaces the old tablist + "What to draft" pair. The setup
 * form steps aside while a draft runs or is on screen; the result bar brings it back ("Change
 * settings") or starts blank ("New draft").
 *
 * #2654 — the tool opens on the scholar's SAVED DRAFTS (the `biosketch_generation` rows, newest
 * first) with View / Clone / label / Delete per row, and a staleness nudge ("N publications added
 * since this draft") whose one click re-runs product suggestion only. The generation row IS the
 * draft — there is no separate draft table or endpoint.
 */
"use client";

import * as React from "react";
import { Braces, ChevronRight, Copy, Search, Sparkles, TriangleAlert } from "lucide-react";

import { BiosketchGenerateControls } from "@/components/edit/biosketch-generate-controls";
import {
  BiosketchResultCard,
  BiosketchSuggestedPubsCard,
  type BiosketchGenerateResult,
} from "@/components/edit/biosketch-result-card";
import { BiosketchProgress } from "@/components/edit/biosketch-progress";
import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { readBiosketchStream, type BiosketchProgressState } from "@/lib/edit/biosketch-stream";
import {
  DEFAULT_BIOSKETCH_PARAMS,
  normalizeBiosketchParams,
  missingPersonalStatementInputs,
  BIOSKETCH_APPLICATION_ROLE_LABELS,
  type BiosketchEntry,
  type BiosketchMode,
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";
import { type BiosketchProducts, type SuggestedPub } from "@/lib/edit/biosketch-products";
import { type BiosketchContributionSources } from "@/lib/edit/biosketch-sources";
import { type BiosketchPromptVersionMeta } from "@/lib/edit/biosketch-prompt-versions";
import { humanizeModelId } from "@/lib/edit/overview-prompt-versions";
import { cn } from "@/lib/utils";

// User-facing copy, kept as named constants (one place, asserted in tests).
const SPARSE =
  "We don't have enough of your work indexed to draft a biosketch yet. Review My Publications first, then try again.";
const RATE_LIMITED =
  "You've generated several biosketches recently — please try again in a little while.";
const MISSING_INPUTS =
  "Add a proposed project title and specific aims to draft a Personal Statement.";
const FAILED = "We couldn't generate a biosketch just now. Please try again.";
const DEBUG_FAILED = "We couldn't assemble the prompt payload just now. Please try again.";
const SUGGEST_FAILED = "We couldn't find matching publications just now. Please try again.";
const DELETE_FAILED = "We couldn't delete that draft just now. Please try again.";
const LABEL_FAILED = "We couldn't save that label just now. Please try again.";
/** `biosketch_generation.label VARCHAR(120)` — the input's maxLength. */
const LABEL_MAX = 120;

/**
 * `missingPersonalStatementInputs` key → the DOM id of the control that satisfies it, so a
 * blocked Generate can put focus on the first thing the user has to fill in.
 */
const REQUIRED_FIELD_IDS: Record<string, string> = {
  applicationRole: "biosketch-application-role",
  projectTitle: "biosketch-project-title",
  aims: "biosketch-aims",
};

/** The mode cards: the two AI drafts, then the deterministic publication finder (#1569). */
type ModeChoice = BiosketchMode | "suggest";
const MODE_CARDS: ReadonlyArray<{ value: ModeChoice; label: string; hint: string }> = [
  {
    value: "contributions",
    label: "Contributions to Science",
    hint: "Up to five bodies of work, drafted from your record. No application details needed.",
  },
  {
    value: "personal_statement",
    label: "Personal Statement",
    hint: "Tailored to one application. Needs your role, the project title, and its aims.",
  },
  {
    value: "suggest",
    label: "Find publications",
    hint: "Paste a statement you wrote and match it against your indexed publications.",
  },
];

export type BiosketchToolProps = {
  /** The scholar the biosketch is generated for (self cwid or the delegated `[cwid]`). */
  entityId: string;
  /** Whether to render the per-draft cost estimate (superuser / comms-steward / unit-admin). */
  canSeeCost: boolean;
  /** The resolved effective model id — drives the cost estimate display. */
  model: string;
  /** #917 v6 — the selectable prompt versions (privileged actors only). */
  versions?: BiosketchPromptVersionMeta[];
  /** #917 v6 — whether the actor may steer the prompt version. */
  canSelectVersion?: boolean;
  /**
   * #917 v6 follow-up B — whether to surface the "View prompt & payload" debug action.
   * STRICTLY superuser (the raw FACTS projection is internal data), narrower than
   * {@link canSeeCost}, which also includes a comms-steward.
   */
  canDebug?: boolean;
};

/** One row of biosketch generation history (the `/api/edit/biosketch/generations` shape). */
type BiosketchGenerationItem = {
  id: string;
  mode: BiosketchGenerateResult["mode"];
  entries: BiosketchEntry[];
  model: string;
  promptVersion?: string | null;
  params: BiosketchParams;
  products: BiosketchProducts | null;
  sources: BiosketchContributionSources[] | null;
  /** Audit "who ran it": the accountable human, plus the impersonation overlay (if any). */
  createdByCwid: string;
  impersonatedCwid: string | null;
  /** #2654 — the application-name label, or null when unlabeled. */
  label?: string | null;
  /** #2654 / #2668 — confirmed authorships LINKED to the profile after this draft (the
   *  staleness nudge), keyed on `publication_author.created_at`, which is set once. */
  pubsAddedSince?: number;
  createdAt: string;
};

export function BiosketchTool({
  entityId,
  canSeeCost,
  model,
  versions = [],
  canSelectVersion = false,
  canDebug = false,
}: BiosketchToolProps) {
  const [params, setParams] = React.useState<BiosketchParams>(() => ({
    ...DEFAULT_BIOSKETCH_PARAMS,
  }));
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [isDebugLoading, setIsDebugLoading] = React.useState(false);
  const [progress, setProgress] = React.useState<BiosketchProgressState | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BiosketchGenerateResult | null>(null);
  const [generations, setGenerations] = React.useState<BiosketchGenerationItem[]>([]);
  // #1992 — the history row a delete is being confirmed for, or null. A delete is unrecoverable
  // (the run is hard-deleted server side), so it goes through the house `ConfirmDialog`, where
  // Cancel — not the destructive button — is the focused default.
  const [pendingDelete, setPendingDelete] = React.useState<BiosketchGenerationItem | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  // #2654 — the application-name label the NEXT generation is saved under, and the draft the
  // current form was cloned from (a one-line notice asking for the new title / aims).
  const [label, setLabel] = React.useState("");
  const [clonedFrom, setClonedFrom] = React.useState<BiosketchGenerationItem | null>(null);
  // #2654 — inline label edit on one drafts-list row: which row, and the text being typed.
  const [editingLabelId, setEditingLabelId] = React.useState<string | null>(null);
  const [labelDraft, setLabelDraft] = React.useState("");
  const [isSavingLabel, setIsSavingLabel] = React.useState(false);
  // #2654 — the staleness nudge's one-click: which row's product suggestion is running / shown.
  const [nudgingId, setNudgingId] = React.useState<string | null>(null);
  const [nudge, setNudge] = React.useState<{ id: string; pubs: SuggestedPub[] } | null>(null);

  // #1569 — the two tool modes: the AI generator (default) and the DETERMINISTIC
  // "write your own statement → suggested publications" mode (no model call).
  const [toolMode, setToolMode] = React.useState<"generate" | "suggest">("generate");
  const [statement, setStatement] = React.useState("");
  const [isSuggesting, setIsSuggesting] = React.useState(false);
  const [suggestError, setSuggestError] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<SuggestedPub[] | null>(null);

  // Mirror the route's required-input gate so a request it would 400 never fires. The gate is
  // enforced on CLICK, not by disabling the button: a primary action that is dead on arrival
  // with no message next to it leaves the user hunting for what is wrong (and a disabled
  // button is not reliably announced). Generate stays pressable, and pressing it with fields
  // missing shows a message on each one and moves focus to the first.
  const missing = missingPersonalStatementInputs(params);
  const [showValidation, setShowValidation] = React.useState(false);

  // Tick an elapsed counter while a generation runs (the liveness within a static phase). Reset on
  // each run; cleared when generation ends.
  React.useEffect(() => {
    if (!isGenerating) return;
    const started = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 1000);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  const refreshGenerations = React.useCallback(async () => {
    try {
      const res = await fetch(
        `/api/edit/biosketch/generations?cwid=${encodeURIComponent(entityId)}`,
      );
      const data = (await res.json().catch(() => null)) as
        | { ok: true; generations: BiosketchGenerationItem[] }
        | { ok: false }
        | null;
      if (res.ok && data && data.ok === true && Array.isArray(data.generations)) {
        setGenerations(data.generations);
      }
    } catch {
      // History is a convenience; a failed refresh leaves the panel as-is.
    }
  }, [entityId]);

  React.useEffect(() => {
    void refreshGenerations();
  }, [refreshGenerations]);

  async function generate() {
    if (isGenerating) return;
    if (missing.length > 0) {
      setShowValidation(true);
      // Focus the first field the route would reject on, so the message is where the caret is.
      const first = missing[0];
      const id = first ? REQUIRED_FIELD_IDS[first] : undefined;
      if (id) window.requestAnimationFrame(() => document.getElementById(id)?.focus());
      return;
    }
    setShowValidation(false);
    setIsGenerating(true);
    setError(null);
    setResult(null);
    // Reset the timer synchronously (the effect resets it too, but only after the first paint —
    // without this a back-to-back run flashes the previous run's elapsed time for one frame).
    setElapsedMs(0);
    setProgress({ phase: "drafting", done: 0, total: 0 });
    try {
      const res = await fetch("/api/edit/biosketch/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, params, label }),
      });
      // A pre-stream rejection (4xx/5xx) is a BUFFERED JSON `editError`, not the NDJSON stream.
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(mapErrorToMessage(typeof data?.error === "string" ? data.error : ""));
        return;
      }
      // 200 ⇒ the NDJSON progress stream. Advance the bar on each phase event; the final result
      // line carries the same `{ ok }` payload the buffered response used to.
      const data = (await readBiosketchStream(res, setProgress)) as
        | ({ ok: true } & BiosketchGenerateResult)
        | { ok: false; error: string }
        | null;
      if (!data || data.ok !== true) {
        const code = data && "error" in data && typeof data.error === "string" ? data.error : "";
        setError(mapErrorToMessage(code));
        return;
      }
      setResult({
        mode: data.mode,
        entries: Array.isArray(data.entries) ? data.entries : [],
        model: data.model,
        overflow: Array.isArray(data.overflow) ? data.overflow : [],
        removedCount: typeof data.removedCount === "number" ? data.removedCount : 0,
        products: data.products ?? null,
        sources: data.sources ?? null,
        generationId: data.generationId ?? null,
      });
      setClonedFrom(null);
      void refreshGenerations();
    } catch {
      setError(FAILED);
    } finally {
      setIsGenerating(false);
      setProgress(null);
    }
  }

  /**
   * #1569 — the DETERMINISTIC counterpart to {@link generate}: POST the user's OWN written
   * statement to `/api/edit/biosketch/suggest-pubs`, which ranks the scholar's publications by
   * token overlap and returns the top matches. There is NO model call and nothing is drafted —
   * the endpoint just scores grounded pmids — so this needs no progress stream, cost line, or
   * AI-content warning. Errors surface in a dedicated alert.
   */
  async function suggestPubs() {
    if (isSuggesting) return;
    setIsSuggesting(true);
    setSuggestError(null);
    setSuggestions(null);
    try {
      const res = await fetch("/api/edit/biosketch/suggest-pubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, statement }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; pubs: SuggestedPub[] }
        | { ok: false }
        | null;
      if (!res.ok || !data || data.ok !== true || !Array.isArray(data.pubs)) {
        setSuggestError(SUGGEST_FAILED);
        return;
      }
      setSuggestions(data.pubs);
    } catch {
      setSuggestError(SUGGEST_FAILED);
    } finally {
      setIsSuggesting(false);
    }
  }

  /**
   * #917 v6 follow-up B (superuser only) — fetch the EXACT prompt + FACTS payload the generator
   * would send to Bedrock for the CURRENT steering params, without spending a generation, and
   * download it as JSON. The endpoint is superuser-gated server-side; the button is hidden for
   * everyone else (`canDebug`). Errors surface in the shared error alert.
   */
  async function downloadDebugPayload() {
    if (isDebugLoading || isGenerating) return;
    setIsDebugLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/biosketch/debug-payload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, params }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; promptVersion?: string }
        | { ok: false }
        | null;
      if (!res.ok || !data || data.ok !== true) {
        setError(DEBUG_FAILED);
        return;
      }
      const version = "promptVersion" in data && data.promptVersion ? data.promptVersion : "draft";
      // Filename carries the cwid + version for traceability (a superuser comparing payloads
      // across scholars / versions).
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `biosketch-prompt-${entityId}-${version}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(DEBUG_FAILED);
    } finally {
      setIsDebugLoading(false);
    }
  }

  /**
   * #2654 Clone — prefill the generate form from a saved draft: its steering params (mode, count,
   * emphasis, instructions, prompt version) AND the project title / aims the GET re-seeds into
   * `params` from the row's columns, plus a "(copy)" label. Nothing is sent: the user edits the
   * title and aims for the new application, then generates. Contributions carry over through
   * the params; the Personal Statement and Related products are regenerated by that run. The
   * title field is focused (and its optional-project disclosure opened) so the ask is visible.
   */
  function cloneDraft(gen: BiosketchGenerationItem) {
    if (isGenerating) return;
    setToolMode("generate");
    setParams(normalizeBiosketchParams(gen.params));
    setLabel(gen.label ? `${gen.label} (copy)` : "");
    setClonedFrom(gen);
    setResult(null);
    setNudge(null);
    window.requestAnimationFrame(() => {
      const title = document.getElementById(
        gen.mode === "personal_statement" ? "biosketch-project-title" : "biosketch-related-title",
      );
      const details = title?.closest("details");
      if (details) details.open = true;
      title?.focus();
    });
  }

  /** #2654 New — a blank form: default params, no label, no clone notice, no result. */
  function newDraft() {
    if (isGenerating) return;
    setParams({ ...DEFAULT_BIOSKETCH_PARAMS });
    setLabel("");
    setClonedFrom(null);
    setResult(null);
    setNudge(null);
  }

  /** #2654 — PATCH a row's label (empty clears it). The row updates in place on success. */
  async function saveLabel(gen: BiosketchGenerationItem) {
    if (isSavingLabel) return;
    setIsSavingLabel(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/biosketch/generations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ generationId: gen.id, label: labelDraft }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; label: string | null }
        | { ok: false }
        | null;
      if (!res.ok || !data || data.ok !== true) {
        setError(LABEL_FAILED);
        return;
      }
      const saved = data.label;
      setGenerations((prev) => prev.map((g) => (g.id === gen.id ? { ...g, label: saved } : g)));
      setEditingLabelId(null);
    } catch {
      setError(LABEL_FAILED);
    } finally {
      setIsSavingLabel(false);
    }
  }

  /**
   * #2654 staleness nudge — re-run PRODUCT SUGGESTION ONLY for a draft: POST the draft's own text
   * (title, aims, entries) to the deterministic `/suggest-pubs` ranker, which now sees the
   * publications added since the draft. No model call, nothing regenerated or written; the
   * ranked list renders under the row so the scholar can pick new products for the worksheet.
   */
  async function suggestForDraft(gen: BiosketchGenerationItem) {
    if (nudgingId) return;
    setNudgingId(gen.id);
    setNudge(null);
    setError(null);
    const statement = [
      gen.params.projectTitle,
      gen.params.aims,
      ...gen.entries.map((e) => `${e.title} ${e.body}`),
    ]
      .filter((t) => t && t.trim().length > 0)
      .join("\n");
    try {
      const res = await fetch("/api/edit/biosketch/suggest-pubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, statement }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; pubs: SuggestedPub[] }
        | { ok: false }
        | null;
      if (!res.ok || !data || data.ok !== true || !Array.isArray(data.pubs)) {
        setError(SUGGEST_FAILED);
        return;
      }
      setNudge({ id: gen.id, pubs: data.pubs });
    } catch {
      setError(SUGGEST_FAILED);
    } finally {
      setNudgingId(null);
    }
  }

  /** Show a history row's entries + products as the current result (read-only view). The clone
   *  notice names the row the FORM came from, not the one on screen, so it is cleared here —
   *  otherwise "Cloned from X" would sit above a view of an unrelated draft. */
  function viewDraft(gen: BiosketchGenerationItem) {
    if (isGenerating) return;
    setClonedFrom(null);
    setResult({
      mode: gen.mode,
      entries: gen.entries,
      model: gen.model,
      overflow: [],
      removedCount: 0,
      products: gen.products,
      sources: gen.sources,
      generationId: gen.id,
      viewing: { label: gen.label ?? null, generatedOn: formatGenDate(gen.createdAt) },
    });
    // The result card mounts BELOW the form; the row the reader clicked is above it. Focus the
    // card's heading (which scrolls it into view) so "View draft" visibly does something.
    window.requestAnimationFrame(() =>
      document.getElementById("biosketch-result-heading")?.focus(),
    );
  }

  /**
   * #1992 — prune one run from the history, once the confirm dialog says so. The server
   * hard-deletes the row and audits the deletion, so there is no undo.
   *
   * The row leaves local state immediately (no refetch — the list is already exact), and if the
   * result card is SHOWING that run it is cleared too: a draft on screen that no longer exists
   * would invite a copy out of a record we just said was gone. A 404 takes the same path — the
   * route answers it when the run is ALREADY gone (a retry, a second tab), which is the outcome
   * asked for. Anything else surfaces in the shared error alert and keeps the row.
   */
  async function deleteGeneration(gen: BiosketchGenerationItem) {
    if (isGenerating || isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/biosketch/generations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ generationId: gen.id }),
      });
      if (!res.ok && res.status !== 404) {
        setError(DELETE_FAILED);
        return;
      }
      setGenerations((prev) => prev.filter((g) => g.id !== gen.id));
      setResult((prev) => (prev && prev.generationId === gen.id ? null : prev));
    } catch {
      setError(DELETE_FAILED);
    } finally {
      setIsDeleting(false);
      // Close either way — the error alert lives in the card behind the (modal) dialog, so a
      // failure that left it open would hide the message it just wrote.
      setPendingDelete(null);
    }
  }

  /** One saved-draft row. The list mixes both modes, so a labelled row carries a mode pill
   *  (an unlabelled row's headline already is the mode noun). */
  function renderGenRow(gen: BiosketchGenerationItem) {
    const added = gen.pubsAddedSince ?? 0;
    return (
      <li
        key={gen.id}
        className="flex flex-col gap-2.5 px-4 py-3"
        data-testid={`biosketch-version-${gen.id}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <span className="text-muted-foreground flex min-w-0 flex-col">
            {/* #2654 — the application-name label is the row's headline; inline-editable. */}
            {editingLabelId === gen.id ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveLabel(gen);
                }}
              >
                <Input
                  value={labelDraft}
                  maxLength={LABEL_MAX}
                  disabled={isSavingLabel}
                  placeholder="Application name (e.g. R01 resubmission)"
                  aria-label="Draft label"
                  className="h-8 w-64 max-w-full text-sm"
                  onChange={(e) => setLabelDraft(e.target.value)}
                  data-testid={`biosketch-version-label-input-${gen.id}`}
                />
                <Button
                  type="submit"
                  variant="apollo"
                  size="sm"
                  disabled={isSavingLabel}
                  data-testid={`biosketch-version-label-save-${gen.id}`}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSavingLabel}
                  onClick={() => setEditingLabelId(null)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <span
                  className="text-foreground text-sm font-medium"
                  data-testid={`biosketch-version-label-${gen.id}`}
                >
                  {gen.label ?? genHeadline(gen)}
                </span>
                {gen.label && (
                  <span className="bg-apollo-rail text-muted-foreground rounded-full px-2 text-xs font-semibold">
                    {genHeadline(gen)}
                  </span>
                )}
                <button
                  type="button"
                  className="text-apollo-maroon text-xs underline-offset-2 hover:underline"
                  disabled={isSavingLabel}
                  onClick={() => {
                    setLabelDraft(gen.label ?? "");
                    setEditingLabelId(gen.id);
                  }}
                  aria-label={`${gen.label ? "Rename" : "Label"} the ${describeGen(gen)}`}
                  data-testid={`biosketch-version-label-edit-${gen.id}`}
                >
                  {gen.label ? "Rename" : "Add label"}
                </button>
              </span>
            )}
            {/* ONE wrapped meta line: prompt version, model, entry count, and the audit
              "who ran it" — the accountable human plus the "View as" overlay target when a
              delegate/superuser generated on the scholar's behalf — ending in the date.
              These were four stacked lines, and the date appeared twice, because the
              unlabeled headline was "<noun> generated <date>" and the actor line repeated
              it. The headline is now the noun alone and the date is stated once, here. */}
            <span className="text-xs" data-testid={`biosketch-version-actor-${gen.id}`}>
              {genMetaLine(gen)}
            </span>
          </span>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => viewDraft(gen)}
              disabled={isGenerating}
              data-testid={`biosketch-version-view-${gen.id}`}
            >
              View draft
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => cloneDraft(gen)}
              disabled={isGenerating}
              aria-label={`Clone the ${describeGen(gen)}`}
              data-testid={`biosketch-version-clone-${gen.id}`}
            >
              <Copy className="size-4" />
              Clone
            </Button>
            {/* Demoted: View and Clone are the everyday actions, and Delete was sitting
                beside them at identical weight — an unrecoverable action one slip away from
                the two you reach for. It still opens the confirm dialog. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setPendingDelete(gen)}
              disabled={isGenerating || isDeleting}
              // The row's visible text is a version/model line plus a date — nothing that names
              // the artifact — so the button says what it destroys in its accessible name.
              aria-label={`Delete the ${describeGen(gen)}`}
              data-testid={`biosketch-version-delete-${gen.id}`}
            >
              Delete
            </Button>
          </div>
        </div>
        {/* #2654 — staleness nudge: confirmed publications LINKED to the profile since this draft
                (#2668: `publication_author.created_at`, set once on create), with a one-click
                re-run of the product ranker. */}
        {added > 0 && (
          <div
            className="border-apollo-amber-tint-border bg-apollo-amber-tint flex flex-wrap items-center gap-2.5 rounded-md border px-3 py-2 text-sm"
            data-testid={`biosketch-version-stale-${gen.id}`}
          >
            <span className="text-apollo-amber font-medium">
              {added} {added === 1 ? "publication" : "publications"} added since this draft
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => suggestForDraft(gen)}
              disabled={nudgingId !== null}
              data-testid={`biosketch-version-suggest-${gen.id}`}
            >
              <Search className="size-4" />
              {/* "products" is NIH's word and the API's; the sentence beside this button,
                  the card it opens, and the rest of the tool all say publications. One
                  vocabulary per surface. */}
              {nudgingId === gen.id ? "Finding…" : "Find matching publications"}
            </Button>
          </div>
        )}
        {nudge?.id === gen.id && <BiosketchSuggestedPubsCard pubs={nudge.pubs} />}
      </li>
    );
  }

  // The one mode chooser: the two AI drafts plus the deterministic publication finder.
  const choice: ModeChoice = toolMode === "suggest" ? "suggest" : params.mode;
  function pickMode(next: ModeChoice) {
    setShowValidation(false);
    if (next === "suggest") {
      setToolMode("suggest");
      return;
    }
    setToolMode("generate");
    setParams((p) => ({ ...p, mode: next }));
  }

  // Output-first: while a draft runs, or one is on screen, the setup form steps aside. The
  // result bar's buttons bring it back (with the settings intact) or start a blank one.
  const showSetup = !isGenerating && !result;
  const isStatement = params.mode === "personal_statement";

  return (
    <EditPanel
      slot="biosketch-tool"
      heading="NIH biosketch"
      description="Draft the narrative sections of an NIH biosketch from your Scholars record: Contributions to Science, or a Personal Statement tailored to one application. Every draft is a starting point you rewrite in your own voice."
    >
      {/* #2654 — saved drafts lead the tool in every mode: newest first, one list, each row
          tagged with what it is. */}
      {generations.length > 0 && (
        <details
          open
          className="group border-apollo-border bg-apollo-surface-2 rounded-md border"
          data-testid="biosketch-versions-panel"
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Saved drafts
            <span className="bg-apollo-rail text-muted-foreground rounded-full px-2 text-xs font-semibold">
              {generations.length}
            </span>
            <span className="text-muted-foreground ml-auto text-xs font-normal">
              Nothing here is saved to your profile
            </span>
          </summary>
          <ul className="border-apollo-border divide-apollo-border flex flex-col divide-y border-t">
            {generations.map(renderGenRow)}
          </ul>
        </details>
      )}

      {showSetup && (
        <fieldset className="flex flex-col gap-2.5" data-testid="biosketch-mode">
          <legend className="text-foreground mb-2.5 text-sm font-semibold">
            What do you want to make?
          </legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
            {MODE_CARDS.map((card) => (
              <label
                key={card.value}
                className={cn(
                  "flex cursor-pointer flex-col gap-1.5 rounded-lg border-[1.5px] px-4 py-3.5",
                  "has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2",
                  choice === card.value
                    ? "border-apollo-maroon bg-apollo-surface shadow-[0_0_0_1px_var(--apollo-maroon)]"
                    : "border-apollo-border-strong bg-apollo-surface-2",
                )}
                data-testid={`biosketch-mode-${card.value}`}
              >
                <input
                  type="radio"
                  name="biosketch-mode"
                  value={card.value}
                  checked={choice === card.value}
                  onChange={() => pickMode(card.value)}
                  className="sr-only"
                />
                <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
                  {card.value === "suggest" ? (
                    <Search className="text-apollo-slate size-4" aria-hidden="true" />
                  ) : (
                    <Sparkles className="text-apollo-maroon size-4" aria-hidden="true" />
                  )}
                  {card.label}
                </span>
                <span className="text-muted-foreground text-xs leading-snug">{card.hint}</span>
                {card.value === "suggest" && (
                  <span className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate mt-0.5 w-fit rounded-full border px-2 py-0.5 text-xs font-semibold">
                    No AI · your own words
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {showSetup && toolMode === "generate" && (
        <>
          {clonedFrom && (
            <Alert data-testid="biosketch-cloned-from">
              <AlertDescription>
                Cloned from the {describeGen(clonedFrom)}
                {clonedFrom.label ? ` (${clonedFrom.label})` : ""}. Update the project title and
                aims for the new application, then generate.{" "}
                {clonedFrom.mode === "personal_statement"
                  ? "The statement and related products are drafted fresh."
                  : "The contributions and products are drafted fresh from these settings."}
              </AlertDescription>
            </Alert>
          )}

          <BiosketchGenerateControls
            value={params}
            onChange={setParams}
            disabled={isGenerating}
            canSeeCost={canSeeCost}
            model={model}
            versions={versions}
            canSelectVersion={canSelectVersion}
            invalidFields={showValidation ? missing : []}
            label={label}
            onLabelChange={setLabel}
            labelMax={LABEL_MAX}
            debugAction={
              canDebug ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-fit"
                  onClick={downloadDebugPayload}
                  disabled={isDebugLoading || isGenerating}
                  data-testid="biosketch-debug-payload"
                  title="Download the exact system prompt, user prompt, and FACTS payload these settings would send to the model (superusers only)."
                >
                  <Braces className="size-4" />
                  {isDebugLoading ? "Preparing…" : "View prompt & payload"}
                </Button>
              ) : null
            }
            action={
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3.5">
                  <Button
                    type="button"
                    variant="apollo"
                    onClick={generate}
                    disabled={isGenerating}
                    data-testid="biosketch-generate"
                  >
                    <Sparkles className="size-4" />
                    {isStatement ? "Generate personal statement" : "Generate contributions"}
                  </Button>
                  {showValidation && missing.length > 0 && (
                    <span
                      className="text-destructive text-sm font-medium"
                      data-testid="biosketch-missing-note"
                    >
                      {missing.length === 1
                        ? "One required field above is empty."
                        : `${missing.length} required fields above are empty.`}
                    </span>
                  )}
                  <span className="text-muted-foreground text-sm">Takes about a minute.</span>
                </div>
                {/* #1990 — the full, destructive NIH caution rides with the draft itself
                    (`BiosketchResultCard`), where the text leaves the app. Before there is a
                    draft, one amber line sets the expectation. */}
                <div
                  className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber flex max-w-[86ch] items-start gap-2 rounded-md border px-3.5 py-2.5 text-sm"
                  data-testid="biosketch-ai-note"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    What comes back is an AI first draft, not your words. You will need to rewrite
                    it before it goes near a submission. The full caution sits with the draft
                    itself.
                  </span>
                </div>
              </div>
            }
          />
        </>
      )}

      {showSetup && toolMode === "suggest" && (
        <>
          <div className="flex max-w-[78ch] flex-col gap-1.5">
            <label htmlFor="biosketch-statement" className="text-foreground text-sm font-semibold">
              Your statement or themes
            </label>
            {/* The instruction is helper text, not a placeholder: a placeholder disappears
                the moment you start typing, is the lowest-contrast text on the surface, and
                is not reliably announced. The placeholder keeps only a short example. */}
            <span id="biosketch-statement-help" className="text-muted-foreground text-sm">
              Write or paste the narrative, aims, or themes in your own words. Your publications
              that overlap it are surfaced. This is a grounded, deterministic match against your
              indexed publications, with nothing generated and no text written by AI.
            </span>
            <Textarea
              id="biosketch-statement"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              disabled={isSuggesting}
              rows={6}
              aria-describedby="biosketch-statement-help"
              placeholder="e.g. My work centers on the metabolic rewiring of pancreatic tumors…"
              data-testid="biosketch-statement"
            />
          </div>

          <Button
            type="button"
            variant="apollo"
            className="w-fit"
            onClick={suggestPubs}
            disabled={isSuggesting || statement.trim().length === 0}
            data-testid="biosketch-suggest"
          >
            <Search className="size-4" />
            {isSuggesting ? "Finding…" : "Find publications"}
          </Button>

          {suggestError && (
            <Alert variant="destructive" data-testid="biosketch-suggest-error">
              <AlertDescription>{suggestError}</AlertDescription>
            </Alert>
          )}

          {suggestions && <BiosketchSuggestedPubsCard pubs={suggestions} />}

          {/* Without this the panel is one small card in an empty viewport, which reads as a
              page that failed to load rather than one waiting for input. */}
          {!suggestions && !suggestError && !isSuggesting && (
            <p
              className="border-apollo-border-strong bg-apollo-surface-2 text-muted-foreground rounded-md border border-dashed p-4 text-sm"
              data-testid="biosketch-suggest-empty"
            >
              Your matching publications will appear here, ranked by overlap with what you wrote,
              each with its PMID so you can copy them straight into a worksheet.
            </p>
          )}
        </>
      )}

      {isGenerating && progress && (
        <BiosketchProgress state={progress} mode={params.mode} elapsedMs={elapsedMs} />
      )}

      {error && (
        <Alert variant="destructive" data-testid="biosketch-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <>
          <div
            className="border-apollo-border-strong bg-apollo-surface-2 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-2.5"
            data-testid="biosketch-result-bar"
          >
            <span className="text-sm">{resultSummary(result, params, label)}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setResult(null)}
                data-testid="biosketch-change-settings"
              >
                {result.viewing ? "Close draft" : "Change settings"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={newDraft}
                data-testid="biosketch-new-draft"
              >
                New draft
              </Button>
            </div>
          </div>
          <BiosketchResultCard result={result} />
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this draft?"
        description={
          pendingDelete
            ? `The ${describeGen(pendingDelete)} will be erased. It won't be recoverable — we keep no copy once it's deleted.`
            : ""
        }
        reasonMode="none"
        confirmLabel="Delete draft"
        confirmVariant="destructive"
        onConfirm={() => (pendingDelete ? deleteGeneration(pendingDelete) : Promise.resolve())}
      />
    </EditPanel>
  );
}

/** The row's visible headline when it carries no label: the artifact noun, capitalized.
 *  The DATE is deliberately not here — it is the last thing on the meta line below, and
 *  stating it in both places was the row's most obvious redundancy. */
function genHeadline(gen: BiosketchGenerationItem): string {
  return gen.mode === "personal_statement" ? "Personal statement" : "Contributions draft";
}

/** The result bar's one line: what the draft is and what it was drafted for. */
function resultSummary(
  result: BiosketchGenerateResult,
  params: BiosketchParams,
  label: string,
): string {
  const noun =
    result.mode === "personal_statement" ? "Personal Statement" : "Contributions to Science";
  if (result.viewing) {
    return [noun, result.viewing.label ?? "", `saved ${result.viewing.generatedOn}`]
      .filter(Boolean)
      .join(" · ");
  }
  const detail =
    result.mode === "personal_statement"
      ? [
          params.applicationRole ? BIOSKETCH_APPLICATION_ROLE_LABELS[params.applicationRole] : "",
          params.projectTitle,
        ]
      : [`up to ${params.maxContributions}`];
  return [noun, ...detail, label, params.promptVersion].filter(Boolean).join(" · ");
}

/** The row's single meta line: prompt version · model · entry count · who ran it · when.
 *  Parts that do not apply are dropped rather than rendered empty. */
function genMetaLine(gen: BiosketchGenerationItem): string {
  const version = gen.promptVersion ?? gen.params.promptVersion ?? "";
  const actor = `Generated by ${gen.createdByCwid}${
    gen.impersonatedCwid ? ` (as ${gen.impersonatedCwid})` : ""
  }`;
  return [
    version,
    humanizeModelId(gen.model),
    gen.mode === "contributions"
      ? `${gen.entries.length} ${gen.entries.length === 1 ? "contribution" : "contributions"}`
      : "",
    actor,
    formatGenDate(gen.createdAt),
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** What a history row IS, in words — the noun plus the date. The row's own headline is the
 *  bare noun, so this is what names the artifact in the delete button's accessible
 *  name and in the confirm dialog, where the date disambiguates one draft from another. */
function describeGen(gen: BiosketchGenerationItem): string {
  const noun = gen.mode === "personal_statement" ? "personal statement" : "contributions draft";
  return `${noun} generated ${formatGenDate(gen.createdAt)}`;
}

/** A history row's timestamp as a short, locale date (audit "when"). Falls back
 *  to the raw string if it can't be parsed, so a row never renders "Invalid Date". */
function formatGenDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Map a route error code to a user-facing string. The route's codes:
 *  `insufficient_facts` (422), `rate_limited` (429), `missing_project_inputs`
 *  (400), and `generation_failed` (a streamed `{ ok: false }` body — the generate
 *  response is a 200 stream, so a gateway failure is in-body, not a 5xx status),
 *  plus the authz / shape errors that the client gating already prevents — all of
 *  which fall to the generic message. */
function mapErrorToMessage(code: string): string {
  switch (code) {
    case "insufficient_facts":
      return SPARSE;
    case "rate_limited":
      return RATE_LIMITED;
    case "missing_project_inputs":
      return MISSING_INPUTS;
    case "generation_failed":
    default:
      return FAILED;
  }
}
