/**
 * OverviewProvenanceNote — the muted "how this bio was produced" line for the
 * overview-statement generator (#742 Phase B, `docs/overview-statement-generator-spec.md`
 * § Provenance line). After a save the card re-reads `OverviewProvenance` for the
 * owner and renders one short line: written by you / generated with {model} /
 * generated then edited — each now followed by when the live overview was last
 * updated (#1077). This is an `/edit`-only affordance — provenance is NEVER
 * exposed on the public profile.
 *
 * #1077 — when there is no provenance row but a bio nonetheless exists, that bio
 * is the original VIVO import carried over at launch and never edited here (the
 * legacy profile system, #945). We label it honestly rather than render a blank
 * (reads as a bug) or a fabricated date — we know the content predates Scholars
 * but NOT the legacy last-edit date, so the label makes no date claim.
 *
 * Pure presentation: the parent (`overview-card.tsx`) fetches and holds the
 * provenance and passes it down, along with whether the read has resolved
 * (`loaded`, to gate the imported-bio fallback so it never flashes pre-fetch)
 * and whether a saved overview exists at all (`hasSavedOverview`).
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
  /** True once the provenance read has resolved. Gates the imported-bio
   *  fallback so it never flashes before the fetch completes. Defaults true so
   *  the existing pure-presentation tests need no new prop. */
  loaded?: boolean;
  /** Whether a saved overview exists at all, independent of provenance — drives
   *  the imported-bio label when there is no provenance row. */
  hasSavedOverview?: boolean;
};

export function OverviewProvenanceNote({
  provenance,
  loaded = true,
  hasSavedOverview = false,
}: OverviewProvenanceNoteProps) {
  if (provenance === null) {
    // #1077 — no provenance row. Once the read has resolved, a non-empty bio is
    // the original imported overview (never edited here): label it. An empty bio
    // — or a not-yet-resolved read — renders nothing.
    if (!loaded || !hasSavedOverview) return null;
    return (
      <p className="text-muted-foreground text-xs" data-testid="overview-provenance-note">
        Imported from the previous profile system &mdash; not yet edited here.
      </p>
    );
  }

  return (
    <p className="text-muted-foreground text-xs" data-testid="overview-provenance-note">
      {describe(provenance.origin, provenance.model)}
      {" · Last updated "}
      {formatLastUpdated(provenance.updatedAt)}
    </p>
  );
}

/** The user-facing copy per origin (`overview-statement-generator-spec.md` §
 *  Copy — provenance line). `model` is only used for the generated variants. No
 *  trailing period: the "· Last updated {date}" clause is appended after it. */
function describe(origin: OverviewOrigin, model: string | null): string {
  switch (origin) {
    case "authored":
      return "Current overview: written by you";
    case "generated":
      return `Current overview: generated with ${model}`;
    case "generated_edited":
      return `Current overview: generated with ${model}, then edited by you`;
  }
}

/** Date-with-year for the "last updated" line. Unlike the Versions panel's
 *  intra-session draft timestamps (time-of-day, no year), a saved overview can
 *  be months or years old — the year matters, the time-of-day doesn't. Falls
 *  back to the raw ISO string on an unparseable value. */
function formatLastUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
