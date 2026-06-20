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
import { Sparkles } from "lucide-react";

import {
  BiosketchGenerateControls,
} from "@/components/edit/biosketch-generate-controls";
import {
  BiosketchResultCard,
  type BiosketchGenerateResult,
} from "@/components/edit/biosketch-result-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_BIOSKETCH_PARAMS,
  missingPersonalStatementInputs,
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";

// User-facing copy, kept as named constants (one place, asserted in tests).
const SPARSE =
  "We don't have enough of your work indexed to draft a biosketch yet. Review My Publications first, then try again.";
const RATE_LIMITED =
  "You've generated several biosketches recently — please try again in a little while.";
const MISSING_INPUTS =
  "Add a proposed project title and specific aims to draft a Personal Statement.";
const FAILED = "We couldn't generate a biosketch just now. Please try again.";

export type BiosketchToolProps = {
  /** The scholar the biosketch is generated for (self cwid or the delegated `[cwid]`). */
  entityId: string;
  /** Whether to render the per-draft cost estimate (superuser / comms-steward / unit-admin). */
  canSeeCost: boolean;
  /** The resolved effective model id — drives the cost estimate display. */
  model: string;
};

export function BiosketchTool({ entityId, canSeeCost, model }: BiosketchToolProps) {
  const [params, setParams] = React.useState<BiosketchParams>(() => ({
    ...DEFAULT_BIOSKETCH_PARAMS,
  }));
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BiosketchGenerateResult | null>(null);

  // Mirror the route's required-input gate so a request it would 400 never fires.
  const missing = missingPersonalStatementInputs(params);
  const disabled = isGenerating || missing.length > 0;

  async function generate() {
    if (isGenerating || missing.length > 0) return;
    setIsGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/biosketch/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, params }),
      });
      const data = (await res.json().catch(() => null)) as
        | ({ ok: true } & BiosketchGenerateResult)
        | { ok: false; error: string }
        | null;
      if (!res.ok || !data || data.ok !== true) {
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
        generationId: data.generationId ?? null,
      });
    } catch {
      setError(FAILED);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-slot="biosketch-tool">
      <BiosketchGenerateControls
        value={params}
        onChange={setParams}
        disabled={isGenerating}
        canSeeCost={canSeeCost}
        model={model}
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
          {isGenerating ? "Generating…" : "Generate biosketch"}
        </Button>
        <span className="text-muted-foreground text-sm">
          Drafted from your Scholars publications, topics, methods, and grants. Review every entry
          before submitting it.
        </span>
      </div>

      {error && (
        <Alert variant="destructive" data-testid="biosketch-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && <BiosketchResultCard result={result} />}
    </div>
  );
}

/** Map a route error code to a user-facing string. The route's codes:
 *  `insufficient_facts` (422), `rate_limited` (429), `missing_project_inputs`
 *  (400), `generation_failed` (502), plus the authz / shape errors that the
 *  client gating already prevents — all of which fall to the generic message. */
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
