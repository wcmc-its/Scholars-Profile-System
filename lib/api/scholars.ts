/**
 * Pure-function handlers for the Scholar API. Route files in `app/api/*` are
 * thin delegators to these. Production architecture (single Next.js deploy vs
 * separate Node service) is reversible because these functions have no Next.js
 * dependency — see `Phase 1 Design Decisions - 2026-04-29.md` § decision #1.
 */
import { prisma } from "@/lib/db";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";

/**
 * Public shape returned to API consumers: just enough to resolve a CWID to its
 * profile URL. Profile content stays off this endpoint on purpose; its visibility
 * rules live in `lib/api/profile.ts` and must not be duplicated here.
 */
export type ScholarPayload = {
  cwid: string;
  slug: string;
  preferredName: string;
};

/**
 * Look up a scholar by CWID. Excludes soft-deleted and suppressed scholars.
 * Returns `null` if not found (caller maps to 404).
 *
 * #2221 — ALSO excludes the #536 hidden identity classes (doctoral students,
 * alumni). This endpoint is public and unauthenticated, and it gated on
 * `deletedAt` + `status` only. Against the prod data shape (690 scholars with a
 * bare `doctoral_student` role and `deleted_at IS NULL`) neither of those gates
 * fires, so the role carve is the only one that does. `null` is returned for a
 * hidden scholar and a nonexistent CWID alike, so the 404 is identical and the
 * endpoint is not an existence oracle.
 *
 * NOTE: this lookup does NOT chase cwid_aliases. The HTML route
 * `/scholars/by-cwid/:cwid` chases aliases via lib/url-resolver and emits 301s.
 * The API endpoint is identity-stable and does not redirect — clients should
 * call `/api/scholars/:current_cwid` after a redirect resolution if they need
 * to follow CWID changes.
 */
export async function getScholarByCwid(cwid: string): Promise<ScholarPayload | null> {
  const scholar = await prisma.scholar.findFirst({
    // Query layer, not post-filter — an anonymous boundary's where-clause IS its
    // access control. `publicRoleWhere()` admits `role_category IS NULL`
    // explicitly (a bare `notIn` drops NULLs and would 404 un-backfilled rows).
    where: { cwid, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { cwid: true, slug: true, preferredName: true, roleCategory: true },
  });
  if (!scholar) return null;
  // Belt-and-braces on the RAW column: Prisma can't express the
  // `doctoral_student*` prefix the predicate matches, and the predicate fails
  // closed on roles the enumeration hasn't caught up with.
  if (!isPubliclyDisplayed(scholar.roleCategory)) return null;

  return {
    cwid: scholar.cwid,
    slug: scholar.slug,
    preferredName: scholar.preferredName,
  };
}
