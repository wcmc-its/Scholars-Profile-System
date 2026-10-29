/**
 * Loader for `attributeCenterPublications` (`center-pub-attribution.ts`): one
 * center's memberships, its members' WCM appointments, their confirmed
 * publications in the period and the center's relevance rows. Server-only
 * (reads `@/lib/db`); the caller has passed the unit gate.
 */
import { todayIso } from "@/lib/api/center-member-count";
import { db } from "@/lib/db";
import {
  attributeCenterPublications,
  publicationPeriodWhere,
  UNKNOWN_AUTHOR_NAME,
  WCM_TENURE_SOURCES,
  type AttributionMembershipType,
  type CenterPubAttribution,
} from "@/lib/edit/center-pub-attribution";

export async function loadCenterPubAttribution(
  centerCode: string,
  opts: {
    /** Inclusive ISO dates. */
    from: string;
    to: string;
    /** The reporting date; default today. */
    asOf?: string;
    membershipType?: AttributionMembershipType;
  },
): Promise<CenterPubAttribution> {
  const asOf = opts.asOf ?? todayIso();
  const membershipType = opts.membershipType ?? "research";
  const memberships = await db.read.centerMembership.findMany({
    where: { centerCode, membershipType },
    select: {
      cwid: true,
      programCode: true,
      membershipType: true,
      startDate: true,
      endDate: true,
      membershipRoleKey: true,
    },
  });
  const cwids = memberships.map((m) => m.cwid);
  const empty = { memberships, membershipType, asOf, from: opts.from, to: opts.to };
  if (cwids.length === 0)
    return attributeCenterPublications({
      ...empty,
      appointments: [],
      publications: [],
      relevance: new Map(),
    });

  const [appointments, pubs] = await Promise.all([
    db.read.appointment.findMany({
      where: { cwid: { in: cwids }, source: { in: [...WCM_TENURE_SOURCES] } },
      select: { cwid: true, source: true, startDate: true, endDate: true },
    }),
    db.read.publication.findMany({
      // Coarse in SQL; the exact date test is attributeCenterPublications'.
      where: {
        authors: { some: { isConfirmed: true, cwid: { in: cwids } } },
        ...publicationPeriodWhere(opts.from, opts.to),
      },
      orderBy: [{ dateAddedToEntrez: "desc" }, { pmid: "desc" }],
      select: {
        pmid: true,
        title: true,
        journal: true,
        year: true,
        dateAddedToEntrez: true,
        publicationType: true,
        authors: {
          where: { isConfirmed: true, cwid: { in: cwids } },
          select: { cwid: true, scholar: { select: { preferredName: true } } },
        },
      },
    }),
  ]);
  const relevance = pubs.length
    ? await db.read.centerPublicationRelevance.findMany({
        where: { centerCode, pmid: { in: pubs.map((p) => p.pmid) } },
        select: { pmid: true, relevant: true, source: true },
      })
    : [];

  return attributeCenterPublications({
    ...empty,
    appointments,
    publications: pubs.map((p) => ({
      ...p,
      authors: p.authors.map((a) => ({
        cwid: a.cwid as string,
        name: a.scholar?.preferredName ?? UNKNOWN_AUTHOR_NAME,
      })),
    })),
    relevance: new Map(relevance.map((r) => [r.pmid, r])),
  });
}
