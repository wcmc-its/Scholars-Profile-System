/**
 * Pure-function handlers for the Scholar API. Route files in `app/api/*` are
 * thin delegators to these. Production architecture (single Next.js deploy vs
 * separate Node service) is reversible because these functions have no Next.js
 * dependency — see `Phase 1 Design Decisions - 2026-04-29.md` § decision #1.
 */
import { prisma } from "@/lib/db";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import { identityImageEndpoint } from "@/lib/headshot";
import { isEmailReleaseGateEnabled } from "@/lib/profile/email-visibility-flags";
import { gateEmailForViewer } from "@/lib/profile/email-display-gate";

/** Public shape returned to API consumers. */
export type ScholarPayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
  overview: string | null;
  identityImageEndpoint: string;
  appointments: Array<{
    title: string;
    organization: string;
    startDate: string | null;
    endDate: string | null;
    isPrimary: boolean;
    isInterim: boolean;
  }>;
};

/**
 * Look up a scholar by CWID. Excludes soft-deleted and suppressed scholars.
 * Returns `null` if not found (caller maps to 404).
 *
 * #2221 — ALSO excludes the #536 hidden identity classes (doctoral students,
 * alumni). This endpoint is public and unauthenticated and returns MORE than the
 * popover card named in the issue — full name, title, department, the gated
 * email, the overview and the entire appointment history — and it gated on
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
    include: {
      appointments: {
        orderBy: [{ isPrimary: "desc" }, { endDate: "asc" }, { startDate: "desc" }],
      },
    },
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
    fullName: scholar.fullName,
    primaryTitle: scholar.primaryTitle,
    primaryDepartment: scholar.primaryDepartment,
    // email-visibility-spec § A + Cache-safety. This anonymous-facing endpoint is
    // CloudFront-cacheable by path and is NOT in the #866 origin-request policy
    // (no viewer-address forwarded), so it bakes only the viewer-independent
    // (public) email — never `institution`/`none`. Internal callers obtain
    // institution emails via /api/profile/[cwid]/contact-email. No-op when off.
    email: gateEmailForViewer(
      scholar.email,
      scholar.emailVisibility,
      false,
      isEmailReleaseGateEnabled(),
    ),
    overview: scholar.overview,
    identityImageEndpoint: identityImageEndpoint(scholar.cwid),
    appointments: scholar.appointments.map((a) => ({
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isPrimary: a.isPrimary,
      isInterim: a.isInterim,
    })),
  };
}
