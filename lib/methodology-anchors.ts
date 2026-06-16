/**
 * Section / row anchors on /about referenced by the algorithmic surfaces (the
 * (i) info buttons and "how this works" links). Hard-coded here so surface
 * components and the /about page cannot drift (RESEARCH.md §Pitfall 6).
 *
 * History: these used to point at a standalone /about/methodology page. That
 * page was retired (#573 follow-up) and its content folded into the single
 * /about documentation page; the values below map each surface to the /about
 * anchor that explains it. Surfaces reference these by KEY, so repoints are a
 * values-only change here. `/about/methodology` 308-redirects to `/about`.
 *
 * Anchor granularity rule: a surface deep-links to its own row anchor when the
 * landing section's heading doesn't already name it (Recent contributions,
 * Selected highlights, Recent highlights, Top scholars all live under the
 * "Spotlight & Selected research" heading, so each has a row id). Spotlight and
 * Selected research land on the `showcase` section itself — the heading is
 * literally their name, so a row anchor would be redundant.
 */
export const METHODOLOGY_ANCHORS = {
  // Showcase surfaces — table rows in the #showcase section.
  recentContributions: "recent-contributions",
  selectedHighlights: "selected-highlights",
  recentHighlights: "recent-highlights",
  topScholars: "top-scholars",
  // Spotlight / Selected research — the #showcase heading already names these,
  // so they land on the section rather than a row.
  spotlight: "showcase",
  /**
   * @deprecated Use `spotlight`. Retained so older inbound links resolve to a
   * sensible section. Drop after one release.
   */
  selectedResearch: "showcase",
  // Eligibility carve-outs (which roles appear on algorithmic surfaces) live in
  // the #showcase "Who appears on these surfaces" note.
  eligibilityCarves: "showcase",
  // Aggregate research-area ranking on dept/division/center pages (#176).
  topResearchAreas: "research-areas",
  // Research-area derivation / "why a model assigns this" — the info button.
  whyAi: "research-areas",
  // Publication-type weighting and hard exclusions are described in #impact.
  exclusions: "impact",
  // Refresh cadence is part of the provenance map.
  dataCadence: "provenance",
  // 0–100 impact score surfaced inline (publication modal, search) — #285.
  impact: "impact",
} as const;

export const METHODOLOGY_BASE = "/about" as const;

/** Ergonomic helper: build a full deeplink for a given surface anchor. */
export function methodologyHref(
  anchor: keyof typeof METHODOLOGY_ANCHORS,
): string {
  return `${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS[anchor]}`;
}
