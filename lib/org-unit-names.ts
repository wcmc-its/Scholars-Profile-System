/**
 * Display-name resolution for org units (departments + centers).
 *
 * Two curated columns layer on top of the canonical `name`:
 *   - officialName — full / ceremonial form (headings, profile affiliation,
 *     browse cards, search-result discovery surfaces).
 *   - compactName  — short / common form (facet chips, tight roster panels).
 *
 * Both are nullable; each resolver coalesces to a sensible fallback so callers
 * never branch. A non-curated unit (officialName/compactName both NULL) renders
 * its `name` everywhere — identical to today's behaviour.
 *
 * See docs/org-unit-curation-spec.md.
 */

/** The minimal shape any org-unit row/view must expose to resolve names. */
export type OrgUnitNameFields = {
  name: string;
  officialName?: string | null;
  compactName?: string | null;
};

/**
 * Full / official display name. Used on prominent surfaces: profile affiliation,
 * center/department page headings, browse cards, search-result cards.
 *
 * Falls back to `name` when no official override is set. For centers, `name`
 * already IS the official name (no ETL clobbers it), so they typically leave
 * `officialName` NULL and this returns `name`.
 */
export function officialUnitName(u: OrgUnitNameFields): string {
  return u.officialName?.trim() || u.name;
}

/**
 * Compact display name. Used on space-constrained surfaces: search facet chips,
 * the center-roster org-unit facet.
 *
 * Falls back to the official name, then `name`, so a unit with only an official
 * override still gets a sensible compact label.
 */
export function compactUnitName(u: OrgUnitNameFields): string {
  return u.compactName?.trim() || u.officialName?.trim() || u.name;
}
