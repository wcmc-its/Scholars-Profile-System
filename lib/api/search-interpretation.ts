/**
 * Issue #265 Phase 1 — `SearchInterpretation` block.
 *
 * Surfaces, in the publications-tab response, how the engine treated the
 * query. Phase 1 only emits two states: `mesh-expanded` (when a MeSH
 * descriptor resolved via `matchQueryToTaxonomy` / `resolveMeshDescriptor`)
 * and `free-text` (when nothing resolved or the user opted out via
 * `?mesh=off`).
 *
 * Phase 2 will extend the enum with `author`, `journal`, and `ambiguous`.
 * The strict `?searchMode=mesh-only` filter CTA — and the `mesh-only`
 * enum value that goes with it — is carved out to #396, gated on the
 * MEDLINE-indexed-vs-has-MeSH semantic decision.
 *
 * This module is a pure mapper from the existing `MeshResolution` shape
 * to the popover-friendly response block. No new resolver code; the
 * descriptor lookup is already done upstream by #259.
 */
import type { MeshResolution } from "@/lib/api/search-taxonomy";

export type SearchInterpretationMode = "mesh-expanded" | "free-text";

export type SearchInterpretationMeshMatch = {
  /** NLM MeSH descriptor UI (`Dnnnnnnn`). Drives the "View in MeSH browser" link. */
  descriptorId: string;
  /** Human-readable descriptor name (e.g. "Electronic Health Records"). */
  name: string;
  /** Full entry-term list from `mesh_descriptor.entry_terms`. */
  entryTerms: string[];
  /** NLM scope note when present. Null for descriptors without one. */
  scopeNote: string | null;
  /** Whether the query matched the descriptor name verbatim or one of its entry terms. */
  confidence: "exact" | "entry-term";
};

export type SearchInterpretation = {
  mode: SearchInterpretationMode;
  meshMatches: SearchInterpretationMeshMatch[];
};

export function buildSearchInterpretation(
  resolution: MeshResolution | null,
): SearchInterpretation {
  if (resolution === null) {
    return { mode: "free-text", meshMatches: [] };
  }
  return {
    mode: "mesh-expanded",
    meshMatches: [
      {
        descriptorId: resolution.descriptorUi,
        name: resolution.name,
        entryTerms: resolution.entryTerms,
        scopeNote: resolution.scopeNote,
        confidence: resolution.confidence,
      },
    ],
  };
}
