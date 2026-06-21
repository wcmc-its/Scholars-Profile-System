/**
 * `BiosketchProgress` — the generation progress indicator (#917 follow-up A). A determinate-by-PHASE
 * shadcn `Progress` bar driven by the real phase events the generate stream emits (drafting →
 * faithfulness → products → sources → done), NOT a fake timer, with a rotating phase label, an
 * elapsed counter, and a soft "usually …" hint. The faithfulness phase advances per contribution,
 * which is the increment that makes the bar feel alive during the longest part of the fan-out.
 */
"use client";

import * as React from "react";

import { Progress } from "@/components/ui/progress";
import type { BiosketchMode } from "@/lib/edit/biosketch-params";
import type { BiosketchProgressState } from "@/lib/edit/biosketch-stream";

const PHASE_LABELS: Record<string, string> = {
  drafting: "Drafting your contributions…",
  faithfulness: "Fact-checking each line against your records…",
  products: "Selecting key publications…",
  sources: "Linking the source papers…",
  done: "Finishing up…",
};

/**
 * Map a phase event to a percentage. Phase-weighted milestones: drafting climbs toward 40,
 * faithfulness 40→75 (per contribution), products ~80, sources ~90, done 100. Cosmetic — the bar's
 * honesty comes from advancing only on real events; the elapsed timer carries liveness within a phase.
 */
export function biosketchPhasePercent({ phase, done, total }: BiosketchProgressState): number {
  switch (phase) {
    case "drafting":
      return 15;
    case "faithfulness":
      return total > 0 ? Math.min(75, 40 + Math.round((35 * done) / total)) : 40;
    case "products":
      return 80;
    case "sources":
      return 90;
    case "done":
      return 100;
    default:
      return 5;
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function BiosketchProgress({
  state,
  mode,
  elapsedMs,
}: {
  state: BiosketchProgressState;
  mode: BiosketchMode;
  elapsedMs: number;
}) {
  const pct = biosketchPhasePercent(state);
  const label =
    state.phase === "drafting" && mode === "personal_statement"
      ? "Drafting your statement…"
      : (PHASE_LABELS[state.phase] ?? "Working…");
  // A soft range, not a promise — derived from the mode's phase count, not a live countdown.
  const hint = mode === "personal_statement" ? "usually 30–60 seconds" : "usually 60–90 seconds";

  return (
    <div
      className="flex flex-col gap-2"
      data-slot="biosketch-progress"
      data-testid="biosketch-progress"
    >
      <Progress value={pct} aria-label="Biosketch generation progress" />
      <div
        className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"
        aria-live="polite"
      >
        <span data-testid="biosketch-progress-label">{label}</span>
        <span className="tabular-nums" data-testid="biosketch-progress-elapsed">
          {formatElapsed(elapsedMs)} · {hint}
        </span>
      </div>
    </div>
  );
}
