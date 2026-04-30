/**
 * Pure-function handlers for the Scholar API. Route files in `app/api/*` are
 * thin delegators to these. Production architecture (single Next.js deploy vs
 * separate Node service) is reversible because these functions have no Next.js
 * dependency — see `Phase 1 Design Decisions - 2026-04-29.md` § decision #1.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";

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
 * NOTE: this lookup does NOT chase cwid_aliases. The HTML route
 * `/scholars/by-cwid/:cwid` chases aliases via lib/url-resolver and emits 301s.
 * The API endpoint is identity-stable and does not redirect — clients should
 * call `/api/scholars/:current_cwid` after a redirect resolution if they need
 * to follow CWID changes.
 */
export async function getScholarByCwid(cwid: string): Promise<ScholarPayload | null> {
  const scholar = await prisma.scholar.findFirst({
    where: { cwid, deletedAt: null, status: "active" },
    include: {
      appointments: {
        orderBy: [{ isPrimary: "desc" }, { endDate: "asc" }, { startDate: "desc" }],
      },
    },
  });
  if (!scholar) return null;

  return {
    cwid: scholar.cwid,
    slug: scholar.slug,
    preferredName: scholar.preferredName,
    fullName: scholar.fullName,
    primaryTitle: scholar.primaryTitle,
    primaryDepartment: scholar.primaryDepartment,
    email: scholar.email,
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
