/**
 * #2238 / #2239 — the ONE definition of "a grant" for a scholar's own funding
 * count: a funding PROJECT, i.e. award rows grouped by NIH core project number
 * (`coreProjectNum(awardNumber)`, renewal years and supplements collapse into
 * one), with every award that has no core project number standing alone.
 *
 * This is the same project-vs-award decision #2066/#2080 made for the
 * department/division totals (`lib/api/unit-grant-projects.ts`), applied to the
 * per-scholar surfaces:
 *
 *   - the profile Funding header count and its role chips
 *     (`components/profile/profile-view.tsx`, `components/profile/grants-section.tsx`),
 *     whose list below renders one row per project; and
 *   - the people-search card's "N grants" (`grantCount` in the people index,
 *     `lib/search-index-docs.ts`).
 *
 * Both used to count raw award rows (`grants.length`), so a scholar with five
 * renewal years of one R01 read "9 grants" over five rows, and the card and the
 * profile disagreed besides because the index also counted a different
 * population. The population half lives here too
 * ({@link profileFundingRows}), so neither surface can drift from the other.
 *
 * Pure and dependency-light on purpose: `grants-section.tsx` is a client
 * component, and the index builder runs in the ETL.
 */
import { coreProjectNum } from "@/lib/award-number";

/** The one field the project key reads. */
export type ProjectKeyedGrant = { awardNumber: string | null | undefined };

/**
 * The funding-project key for one award row, or null when the row has no NIH
 * core project number and therefore forms a project of its own.
 */
export function grantProjectKey(g: ProjectKeyedGrant): string | null {
  return coreProjectNum(g.awardNumber);
}

/**
 * Number of funding projects in `grants`: distinct core project numbers plus
 * one per row without one. Equals the number of rows the profile Funding list
 * renders for the same input.
 */
export function countGrantProjects(grants: readonly ProjectKeyedGrant[]): number {
  const keys = new Set<string>();
  let singletons = 0;
  for (const g of grants) {
    const key = grantProjectKey(g);
    if (key === null) singletons += 1;
    else keys.add(key);
  }
  return keys.size + singletons;
}

/**
 * The award rows the profile Funding section renders for a scholar: nothing when
 * the scholar hid the section (`hideFunding`), otherwise every row (InfoEd AND
 * prior-institution RePORTER) except a #160-suppressed one. Shared by the
 * profile loader and the people-index builder so the search card counts the
 * same population the profile shows.
 */
export function profileFundingRows<T extends { externalId?: string | null }>(
  grants: readonly T[],
  opts: { hideFunding: boolean; suppressedGrantIds: ReadonlySet<string> },
): T[] {
  if (opts.hideFunding) return [];
  return grants.filter((g) => !(g.externalId && opts.suppressedGrantIds.has(g.externalId)));
}
