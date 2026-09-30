/**
 * Server helpers for the per-scholar publication filter on the topic and
 * method family feeds (`?cwid=`, TAXONOMY_SCHOLAR_CARDS).
 *
 * Both publication routes are anonymous, so these helpers ARE the access
 * control for the filter:
 *   - {@link isPublicScholarCwid} refuses a cwid that is unknown, inactive,
 *     soft-deleted, or a #536 hidden identity class. The loaders answer every
 *     refusal with the same empty feed, so a hidden scholar's cwid is
 *     indistinguishable from one that does not exist.
 *   - {@link loadHiddenAuthorshipPmids} returns the pmids this scholar has a
 *     per-author hide on (ADR-005). "Publications by X" must not list a paper X
 *     removed themselves from, even though the paper stays in the unfiltered feed.
 */
import { prisma } from "@/lib/db";
import { CWID_PATTERN } from "@/lib/cwid";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";

export async function isPublicScholarCwid(cwid: string): Promise<boolean> {
  if (!CWID_PATTERN.test(cwid)) return false;
  const scholar = await prisma.scholar.findFirst({
    // The where-clause is the population gate (#2202)…
    where: { cwid, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { roleCategory: true },
  });
  if (!scholar) return false;
  // …and the raw-column predicate is the fail-closed link gate: it prefix-matches
  // `doctoral_student*`, which the denylist above cannot express.
  return isPubliclyDisplayed(scholar.roleCategory);
}

export async function loadHiddenAuthorshipPmids(cwid: string): Promise<string[]> {
  // Per-request, never cached: suppression is query-time and immediate (ADR-005).
  const rows = await prisma.suppression.findMany({
    where: { entityType: "publication", contributorCwid: cwid, revokedAt: null },
    select: { entityId: true },
  });
  return [...new Set(rows.map((r) => r.entityId))];
}
