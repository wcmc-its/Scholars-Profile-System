/**
 * OverviewProvenanceNote — the muted "how this bio was produced" line for the
 * overview-statement generator (#742 Phase B, `docs/overview-statement-generator-spec.md`
 * § Provenance line). After a save the card re-reads `OverviewProvenance` for the
 * owner and renders one short line: written by you / generated with {model} /
 * generated then edited. This is an `/edit`-only affordance — provenance is
 * NEVER exposed on the public profile.
 *
 * Pure presentation: the parent (`overview-card.tsx`) fetches and holds the
 * provenance and passes it down. `null` (no provenance row yet — the scholar has
 * never saved a generated draft) renders nothing.
 */
"use client";

import * as React from "react";

import type { OverviewOrigin } from "@/lib/edit/overview-provenance";

type OverviewProvenanceNoteProps = {
  provenance: {
    origin: OverviewOrigin;
    model: string | null;
    updatedAt: string;
  } | null;
};

export function OverviewProvenanceNote({ provenance }: OverviewProvenanceNoteProps) {
  // No provenance row → render nothing (e.g. a bio that predates the generator,
  // or one the owner has never saved a generated draft into).
  if (provenance === null) return null;

  return (
    <p className="text-muted-foreground text-xs" data-testid="overview-provenance-note">
      {describe(provenance.origin, provenance.model)}
    </p>
  );
}

/** The user-facing copy per origin (`overview-statement-generator-spec.md` §
 *  Copy — provenance line). `model` is only used for the generated variants. */
function describe(origin: OverviewOrigin, model: string | null): string {
  switch (origin) {
    case "authored":
      return "Current overview: written by you.";
    case "generated":
      return `Current overview: generated with ${model}.`;
    case "generated_edited":
      return `Current overview: generated with ${model}, then edited by you.`;
  }
}
