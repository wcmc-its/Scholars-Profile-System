/**
 * `OverviewProgress` — the overview generation progress indicator (parity with
 * `BiosketchProgress`, #917 follow-up A). A determinate-by-PHASE shadcn `Progress` bar driven by
 * the real phase events the generate stream emits (drafting → faithfulness → done), NOT a fake
 * timer, with a phase label, an elapsed counter, and a soft "usually …" hint.
 *
 * Overview's fan-out is short: the main draft is the long phase, and the faithfulness pass runs only
 * when enabled (off by default), so most runs show "drafting" with the elapsed timer + heartbeat
 * carrying liveness. The bar still gives the run an honest shape and protects the wait UX on a slow
 * Opus-4.8 draft.
 */
"use client";

import * as React from "react";

import { Progress } from "@/components/ui/progress";
import type { OverviewProgressState } from "@/lib/edit/overview-stream";

const PHASE_LABELS: Record<string, string> = {
  drafting: "Drafting your overview…",
  faithfulness: "Fact-checking against your records…",
  done: "Finishing up…",
};

/**
 * Map a phase event to a percentage. Phase milestones: drafting ~35 (the long single call),
 * faithfulness ~80 (only when the grounding pass runs), done 100. Cosmetic — the bar's honesty
 * comes from advancing only on real events; the elapsed timer carries liveness within a phase.
 */
export function overviewPhasePercent({ phase }: OverviewProgressState): number {
  switch (phase) {
    case "drafting":
      return 35;
    case "faithfulness":
      return 80;
    case "done":
      return 100;
    default:
      return 8;
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function OverviewProgress({
  state,
  elapsedMs,
}: {
  state: OverviewProgressState;
  elapsedMs: number;
}) {
  const pct = overviewPhasePercent(state);
  const label = PHASE_LABELS[state.phase] ?? "Working…";

  return (
    <div className="flex flex-col gap-2" data-slot="overview-progress" data-testid="overview-progress">
      <Progress value={pct} aria-label="Overview generation progress" />
      <div
        className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"
        aria-live="polite"
      >
        <span data-testid="overview-progress-label">{label}</span>
        <span className="tabular-nums" data-testid="overview-progress-elapsed">
          {formatElapsed(elapsedMs)} · usually 15–40 seconds
        </span>
      </div>
    </div>
  );
}
