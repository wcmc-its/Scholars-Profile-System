/**
 * Profile-page data assembly. Reads scholar + relations + publications and
 * computes the ranking formulas from `lib/ranking.ts`.
 *
 * Pure-function handler (production-extractable per Q1' refinement). The
 * profile page server component imports this directly for ISR; the equivalent
 * external API endpoint would call the same function.
 */
import { prisma } from "@/lib/db";
import {
  rankForHighlights,
  rankForRecent,
  type ScoredPublication,
} from "@/lib/ranking";

export type CoauthorChip = {
  cwid: string;
  slug: string;
  preferredName: string;
};

export type ProfilePublication = ScoredPublication<{
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  publicationType: string | null;
  citationCount: number;
  dateAddedToEntrez: Date | null;
  doi: string | null;
  pubmedUrl: string | null;
  authorship: { isFirst: boolean; isLast: boolean; isPenultimate: boolean };
  isConfirmed: boolean;
  /** Authors in canonical order. cwid populated only for active WCM scholars. */
  authors: Array<{
    position: number;
    cwid: string | null;
    slug: string | null;
    preferredName: string | null;
    externalName: string | null;
  }>;
}>;

export type ProfilePayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
  headshotUrl: string | null;
  overview: string | null;
  appointments: Array<{
    title: string;
    organization: string;
    startDate: string | null;
    endDate: string | null;
    isPrimary: boolean;
    isInterim: boolean;
    isActive: boolean;
  }>;
  educations: Array<{
    degree: string;
    institution: string;
    year: number | null;
    field: string | null;
  }>;
  grants: Array<{
    title: string;
    role: string;
    funder: string;
    startDate: string;
    endDate: string;
    isActive: boolean;
  }>;
  areasOfInterest: Array<{ topic: string; score: number }>;
  highlights: ProfilePublication[]; // already top-3
  recent: ProfilePublication[]; // full list, sorted by recent_score
};

/**
 * Apply spec line 43 appointment filtering:
 *   - Primary first (drives ordering — but DB also orders by isPrimary desc)
 *   - Active only by default for the public list (callers can show past via expander)
 *   - Interim excluded if any non-interim exists
 *
 * This function returns ALL appointments with `isActive` annotated; the UI
 * decides how to present them.
 */
function annotateAppointments<
  T extends { startDate: Date | null; endDate: Date | null; isInterim: boolean },
>(appts: T[], now: Date) {
  const annotated = appts.map((a) => ({
    ...a,
    isActive: a.endDate === null || a.endDate.getTime() > now.getTime(),
  }));
  // Spec line 46: interim excluded if any non-interim exists.
  const hasNonInterimActive = annotated.some((a) => a.isActive && !a.isInterim);
  if (hasNonInterimActive) {
    return annotated.filter((a) => !(a.isActive && a.isInterim));
  }
  return annotated;
}

export async function getScholarFullProfileBySlug(
  slug: string,
  now: Date = new Date(),
): Promise<ProfilePayload | null> {
  const scholar = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    include: {
      appointments: {
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
      },
      educations: {
        orderBy: [{ year: "desc" }],
      },
      grants: {
        orderBy: [{ endDate: "desc" }, { startDate: "desc" }],
      },
      topicAssignments: {
        orderBy: [{ score: "desc" }],
      },
    },
  });
  if (!scholar) return null;

  // Authorships for this scholar — drives the publications list. Pull author rows
  // for every publication so coauthor chips can be rendered.
  const authorships = await prisma.publicationAuthor.findMany({
    where: { cwid: scholar.cwid, isConfirmed: true },
    include: {
      publication: {
        include: {
          authors: {
            orderBy: { position: "asc" },
            include: {
              scholar: {
                select: {
                  cwid: true,
                  slug: true,
                  preferredName: true,
                  deletedAt: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const rankablePubs = authorships.map((a) => ({
    pmid: a.publication.pmid,
    title: a.publication.title,
    journal: a.publication.journal,
    year: a.publication.year,
    publicationType: a.publication.publicationType,
    citationCount: a.publication.citationCount,
    dateAddedToEntrez: a.publication.dateAddedToEntrez,
    doi: a.publication.doi,
    pubmedUrl: a.publication.pubmedUrl,
    authorship: {
      isFirst: a.isFirst,
      isLast: a.isLast,
      isPenultimate: a.isPenultimate,
    },
    isConfirmed: a.isConfirmed,
    authors: a.publication.authors.map((au) => ({
      position: au.position,
      cwid:
        au.scholar && !au.scholar.deletedAt && au.scholar.status === "active"
          ? au.scholar.cwid
          : null,
      slug:
        au.scholar && !au.scholar.deletedAt && au.scholar.status === "active"
          ? au.scholar.slug
          : null,
      preferredName:
        au.scholar && !au.scholar.deletedAt && au.scholar.status === "active"
          ? au.scholar.preferredName
          : null,
      externalName: au.externalName,
    })),
  }));

  const highlights = rankForHighlights(rankablePubs, now).slice(0, 3);
  const recent = rankForRecent(rankablePubs, now);

  const annotatedAppointments = annotateAppointments(scholar.appointments, now);

  return {
    cwid: scholar.cwid,
    slug: scholar.slug,
    preferredName: scholar.preferredName,
    fullName: scholar.fullName,
    primaryTitle: scholar.primaryTitle,
    primaryDepartment: scholar.primaryDepartment,
    email: scholar.email,
    headshotUrl: scholar.headshotUrl,
    overview: scholar.overview,
    appointments: annotatedAppointments.map((a) => ({
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isPrimary: a.isPrimary,
      isInterim: a.isInterim,
      isActive: a.isActive,
    })),
    educations: scholar.educations.map((e) => ({
      degree: e.degree,
      institution: e.institution,
      year: e.year,
      field: e.field,
    })),
    grants: scholar.grants.map((g) => ({
      title: g.title,
      role: g.role,
      funder: g.funder,
      startDate: g.startDate.toISOString().slice(0, 10),
      endDate: g.endDate.toISOString().slice(0, 10),
      isActive: g.endDate.getTime() > now.getTime(),
    })),
    areasOfInterest: scholar.topicAssignments.map((t) => ({
      topic: t.topic,
      score: t.score,
    })),
    highlights,
    recent,
  };
}

/**
 * Slugs of all active, non-deleted, non-suppressed scholars — used by Next.js
 * `generateStaticParams` to enumerate the profile pages for ISR.
 */
export async function getActiveScholarSlugs(): Promise<string[]> {
  const rows = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { slug: true },
  });
  return rows.map((r) => r.slug);
}

/**
 * Spec line 134-136 sparse-profile threshold:
 *   no overview AND fewer than 3 publications AND no active grants
 * Returns true when the "This profile is being populated" affordance should display.
 */
export function isSparseProfile(p: ProfilePayload): boolean {
  const noOverview = !p.overview || p.overview.trim().length === 0;
  const fewPubs = p.recent.length < 3;
  const noActiveGrants = !p.grants.some((g) => g.isActive);
  return noOverview && fewPubs && noActiveGrants;
}
