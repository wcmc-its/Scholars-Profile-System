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
 */
"use client";

import * as React from "react";
import { Braces, Search, Sparkles } from "lucide-react";

import {
  BiosketchGenerateControls,
} from "@/components/edit/biosketch-generate-controls";
import {
  BiosketchAiWarning,
  BiosketchResultCard,
  BiosketchSuggestedPubsCard,
  type BiosketchGenerateResult,
} from "@/components/edit/biosketch-result-card";
import { BiosketchProgress } from "@/components/edit/biosketch-progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  readBiosketchStream,
  type BiosketchProgressState,
} from "@/lib/edit/biosketch-stream";
import {
  DEFAULT_BIOSKETCH_PARAMS,
  normalizeBiosketchParams,
  missingPersonalStatementInputs,
  type BiosketchEntry,
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";
import { type BiosketchProducts, type SuggestedPub } from "@/lib/edit/biosketch-products";
import { type BiosketchContributionSources } from "@/lib/edit/biosketch-sources";
import { type BiosketchPromptVersionMeta } from "@/lib/edit/biosketch-prompt-versions";
import { humanizeModelId } from "@/lib/edit/overview-prompt-versions";

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

  // #1569 — the two tool modes: the AI generator (default) and the DETERMINISTIC
  // "write your own statement → suggested publications" mode (no model call).
  const [toolMode, setToolMode] = React.useState<"generate" | "suggest">("generate");
  const [statement, setStatement] = React.useState("");
  const [isSuggesting, setIsSuggesting] = React.useState(false);
  const [suggestError, setSuggestError] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<SuggestedPub[] | null>(null);

  // Mirror the route's required-input gate so a request it would 400 never fires.
  const missing = missingPersonalStatementInputs(params);
  const disabled = isGenerating || missing.length > 0;

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
    if (isGenerating || missing.length > 0) return;
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
        body: JSON.stringify({ entityId, params }),
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

  /** Restore a history row's steering params (incl. prompt version) into the controls. */
  function restoreSettings(gen: BiosketchGenerationItem) {
    if (isGenerating) return;
    setParams(normalizeBiosketchParams(gen.params));
  }

  /** Show a history row's entries + products as the current result (read-only view). */
  function viewDraft(gen: BiosketchGenerationItem) {
    if (isGenerating) return;
    setResult({
      mode: gen.mode,
      entries: gen.entries,
      model: gen.model,
      overflow: [],
      removedCount: 0,
      products: gen.products,
      sources: gen.sources,
      generationId: gen.id,
    });
  }

  /** One history row. Shared by both mode sections; the section heading carries the
   *  mode, so only Contributions repeats its entry count here. */
  function renderGenRow(gen: BiosketchGenerationItem) {
    return (
      <li
        key={gen.id}
        className="flex flex-wrap items-start justify-between gap-3"
        data-testid={`biosketch-version-${gen.id}`}
      >
        <span className="text-muted-foreground flex min-w-0 flex-col">
          <span className="text-foreground text-xs">
            {(gen.promptVersion ?? gen.params.promptVersion) ?? ""}
            {(gen.promptVersion ?? gen.params.promptVersion) ? " · " : ""}
            {humanizeModelId(gen.model)}
          </span>
          {gen.mode === "contributions" && (
            <span className="text-xs">
              {gen.entries.length} {gen.entries.length === 1 ? "contribution" : "contributions"}
            </span>
          )}
          {/* Audit "who ran it" — the accountable human, and the "View as" overlay
              target when a delegate/superuser generated on the scholar's behalf. */}
          <span className="text-xs" data-testid={`biosketch-version-actor-${gen.id}`}>
            Generated by {gen.createdByCwid}
            {gen.impersonatedCwid ? ` (as ${gen.impersonatedCwid})` : ""} · {formatGenDate(gen.createdAt)}
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
            onClick={() => restoreSettings(gen)}
            disabled={isGenerating}
            data-testid={`biosketch-version-use-settings-${gen.id}`}
          >
            Use these settings
          </Button>
        </div>
      </li>
    );
  }

  /** A collapsible mode section ("Personal Statements" / "Contributions to Science").
   *  Rendered only when that mode has history, so an actor who has used just one mode
   *  never sees an empty section for the other. */
  function renderGenSection(title: string, items: BiosketchGenerationItem[], testId: string) {
    if (items.length === 0) return null;
    return (
      <details className="group" data-testid={testId}>
        <summary className="text-apollo-maroon w-fit cursor-pointer text-sm font-medium select-none">
          {title} ({items.length})
        </summary>
        <ul className="border-apollo-border bg-apollo-surface-2 mt-3 flex flex-col gap-3 rounded-md border p-4">
          {items.map(renderGenRow)}
        </ul>
      </details>
    );
  }

  // Split history by mode so the two NIH sections never interleave in one list.
  const personalStatements = generations.filter((g) => g.mode === "personal_statement");
  const contributions = generations.filter((g) => g.mode === "contributions");

  return (
    <div className="flex flex-col gap-4" data-slot="biosketch-tool">
      {/* #1569 — switch between the AI generator and the deterministic "suggest pubs from your
          own statement" mode. Two toggle buttons rather than a heavier tab primitive, matching
          the button-driven controls the tool already uses. */}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={toolMode === "generate" ? "apollo" : "outline"}
          size="sm"
          onClick={() => setToolMode("generate")}
          aria-pressed={toolMode === "generate"}
          data-testid="biosketch-mode-generate"
        >
          <Sparkles className="size-4" />
          Generate a draft
        </Button>
        <Button
          type="button"
          variant={toolMode === "suggest" ? "apollo" : "outline"}
          size="sm"
          onClick={() => setToolMode("suggest")}
          aria-pressed={toolMode === "suggest"}
          data-testid="biosketch-mode-suggest"
        >
          <Search className="size-4" />
          Suggest pubs from your statement
        </Button>
      </div>

      {toolMode === "generate" && (
        <>
          <BiosketchGenerateControls
            value={params}
            onChange={setParams}
            disabled={isGenerating}
            canSeeCost={canSeeCost}
            model={model}
            versions={versions}
            canSelectVersion={canSelectVersion}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="apollo"
              onClick={generate}
              disabled={disabled}
              data-testid="biosketch-generate"
            >
              <Sparkles className="size-4" />
              {isGenerating
                ? "Generating…"
                : params.mode === "personal_statement"
                  ? "Generate personal statement"
                  : "Generate biosketch contributions"}
            </Button>
            {canDebug && (
              <Button
                type="button"
                variant="outline"
                onClick={downloadDebugPayload}
                disabled={isDebugLoading || isGenerating}
                data-testid="biosketch-debug-payload"
                title="Download the exact system prompt, user prompt, and FACTS payload these settings would send to the model (superusers only)."
              >
                <Braces className="size-4" />
                {isDebugLoading ? "Preparing…" : "View prompt & payload"}
              </Button>
            )}
            <span className="text-muted-foreground text-sm">
              Drafted from your Scholars publications, topics, methods, and grants. Review every
              entry before submitting it.
            </span>
          </div>

          {/* #1569 — the AI-content warning at the generate action (the second placement is at
              the top of the result card). Shown for the whole generate flow so it is seen before
              any content exists to copy. */}
          <BiosketchAiWarning />

          {isGenerating && progress && (
            <BiosketchProgress state={progress} mode={params.mode} elapsedMs={elapsedMs} />
          )}

          {error && (
            <Alert variant="destructive" data-testid="biosketch-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {result && <BiosketchResultCard result={result} />}

          {generations.length > 0 && (
            <div className="flex flex-col gap-3" data-testid="biosketch-versions-panel">
              {renderGenSection(
                "Earlier personal statements",
                personalStatements,
                "biosketch-versions-personal-statement",
              )}
              {renderGenSection(
                "Earlier contributions to science",
                contributions,
                "biosketch-versions-contributions",
              )}
            </div>
          )}
        </>
      )}

      {toolMode === "suggest" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="biosketch-statement" className="text-foreground text-sm font-medium">
              Your statement or themes
            </label>
            <Textarea
              id="biosketch-statement"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              disabled={isSuggesting}
              rows={6}
              placeholder="Write or paste the narrative, aims, or themes in your own words. We'll surface your publications that overlap it — nothing is generated."
              data-testid="biosketch-statement"
            />
            <span className="text-muted-foreground text-sm">
              A grounded, deterministic match against your indexed publications — no text is
              AI-generated.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="apollo"
              onClick={suggestPubs}
              disabled={isSuggesting || statement.trim().length === 0}
              data-testid="biosketch-suggest"
            >
              <Search className="size-4" />
              {isSuggesting ? "Finding…" : "Suggest publications"}
            </Button>
          </div>

          {suggestError && (
            <Alert variant="destructive" data-testid="biosketch-suggest-error">
              <AlertDescription>{suggestError}</AlertDescription>
            </Alert>
          )}

          {suggestions && <BiosketchSuggestedPubsCard pubs={suggestions} />}
        </div>
      )}
    </div>
  );
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
