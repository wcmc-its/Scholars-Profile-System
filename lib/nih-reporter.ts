/**
 * Issue #90 — NIH RePORTER deep-link URL helpers.
 *
 * Centralized so a future RePORTER URL change is a one-line fix.
 * RePORTER has rewritten its frontend more than once; the placeholder
 * hyphen in `/search/-/projects?...` is the empirically stable form
 * as of ship date but should be re-verified periodically.
 */

const REPORTER_BASE = "https://reporter.nih.gov";

/** Outbound link to a PI's NIH RePORTER portfolio (NIH funding only). */
export function nihReporterPiUrl(profileId: number): string {
  return `${REPORTER_BASE}/search/-/projects?pi_profile_ids=${profileId}`;
}

/** Outbound link to a single project's RePORTER detail page, keyed by
 *  `appl_id` (already populated on `Grant.applId` for matched NIH grants). */
export function nihReporterProjectUrl(applId: number): string {
  return `${REPORTER_BASE}/project-details/${applId}`;
}
