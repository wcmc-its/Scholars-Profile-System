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
