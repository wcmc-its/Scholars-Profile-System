/**
 * Unit Page v2 — which tag row a roster `PersonRow` shows under the overview
 * snippet. The mock ("Unit Page v2", `rowTags` design property) renders ONE tag
 * row: "MeSH terms" (the TOPICS chips, default) or "Methods" (the wrench
 * method-family chips). It is a design-time choice, not a viewer control, so it
 * lives here as a code constant rather than a flag — set it to "methods" to
 * restore the pre-v2 method-chip rows.
 *
 * Client-safe: no imports. `PersonRow` (rendered inside "use client" roster
 * clients) reads these instead of type-importing the server-only loader.
 */
export type RosterRowTags = "mesh" | "methods";

export const ROSTER_ROW_TAGS: RosterRowTags = "mesh";

/** One TOPICS chip — a MeSH descriptor from the people index's `topMeshTerms`.
 *  `ui` is null only for a legacy label-only doc; such a chip renders unlinked. */
export type RosterMeshChip = { ui: string | null; label: string };
