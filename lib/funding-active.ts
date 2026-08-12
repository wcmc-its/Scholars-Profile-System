/**
 * Funding "Active" definition (issue #78, decision Q6).
 *
 * A grant is considered active through its end date plus a 12-month
 * no-cost-extension grace window. NCE status isn't reliably present in InfoEd,
 * so we use the most common NIH NCE window as a proxy.
 *
 * Extracted to its own pure (Prisma-free) module so every surface that shows a
 * grant's Active/Past state — the profile (`lib/api/profile.ts`), the funding
 * search index (`lib/api/search-funding.ts`), and the self-edit Funding panel
 * (`lib/api/edit-context.ts`) — derives it from one definition. The edit panel
 * MUST agree with the profile's badge, so it reuses this rather than
 * re-implementing the grace window.
 */
const NCE_GRACE_MS = 365 * 24 * 60 * 60 * 1000;

export function isFundingActive(endDate: Date, now: Date): boolean {
  return endDate.getTime() + NCE_GRACE_MS > now.getTime();
}

/**
 * "Active as of `asOfDate`" — same NCE-grace `isFundingActive` window, plus a
 * lower bound: a grant that hasn't started yet is not active on the chosen
 * date even though its end date (still years off) would clear the grace
 * window on its own. Used by the `/edit/reports/4` "Grants active as of a
 * date" report, which (unlike the profile/search/edit-panel callers of
 * `isFundingActive`) lets the viewer pick a date other than today.
 */
export function isFundingActiveAsOf(
  grant: { startDate: Date; endDate: Date },
  asOfDate: Date,
): boolean {
  return grant.startDate <= asOfDate && isFundingActive(grant.endDate, asOfDate);
}
