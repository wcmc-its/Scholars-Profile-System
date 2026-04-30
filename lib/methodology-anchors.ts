/**
 * Anchor IDs on /about/methodology referenced by the four algorithmic
 * surfaces. Hard-coded here so surface components and the methodology
 * page cannot drift (RESEARCH.md §Pitfall 6).
 *
 * Source of truth: 02-CONTEXT.md D-04 — locked anchor IDs.
 */
export const METHODOLOGY_ANCHORS = {
  recentContributions: "recent-contributions",
  selectedResearch: "selected-research",
  topScholars: "top-scholars",
  recentHighlights: "recent-highlights",
} as const;

export const METHODOLOGY_BASE = "/about/methodology" as const;

/** Ergonomic helper: build a full deeplink for a given surface anchor. */
export function methodologyHref(
  anchor: keyof typeof METHODOLOGY_ANCHORS,
): string {
  return `${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS[anchor]}`;
}
