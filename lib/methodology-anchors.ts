/**
 * Anchor IDs on /about/methodology referenced by the four algorithmic
 * surfaces. Hard-coded here so surface components and the methodology
 * page cannot drift (RESEARCH.md §Pitfall 6).
 *
 * Source of truth: 02-CONTEXT.md D-04 — locked anchor IDs.
 */
export const METHODOLOGY_ANCHORS = {
  recentContributions: "recent-contributions",
  /**
   * @deprecated Use `spotlight`. Kept so existing inbound links to
   * `/about/methodology#selected-research` resolve. Drop after one release.
   */
  selectedResearch: "selected-research",
  spotlight: "spotlight",
  topScholars: "top-scholars",
  recentHighlights: "recent-highlights",
  // Phase 4 additions — anchor IDs become part of the public URL; must be stable.
  selectedHighlights: "selected-highlights",
  eligibilityCarves: "eligibility-carves",
  exclusions: "exclusions",
  dataCadence: "data-cadence",
  // Issue #176 — aggregate topic ranking shown on dept/division/center pages.
  topResearchAreas: "top-research-areas",
  // Issue #176 — skeptic-oriented intro: what AI does and doesn't do.
  whyAi: "why-ai",
} as const;

export const METHODOLOGY_BASE = "/about/methodology" as const;

/** Ergonomic helper: build a full deeplink for a given surface anchor. */
export function methodologyHref(
  anchor: keyof typeof METHODOLOGY_ANCHORS,
): string {
  return `${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS[anchor]}`;
}
