/**
 * Report 18 loader: the center's publications added to PubMed in the period
 * with ≥1 confirmed author who held a membership of the chosen type ON the
 * publication date, each with its `center_publication_relevance` answer. The
 * caller has passed the unit gate. Server-only (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import {
  investigatorLine,
  programAsOf,
  stintCovers,
  type PubCitationParams,
  type PubCitationRow,
} from "@/lib/edit/pub-citation-report";

export async function loadPubCitationReport(
  centerCode: string,
  params: PubCitationParams,
): Promise<PubCitationRow[]> {
  const stints = await db.read.centerMembership.findMany({
    where: { centerCode },
    select: {
      cwid: true,
      membershipType: true,
      programCode: true,
      startDate: true,
      endDate: true,
      membershipRoleKey: true,
    },
  });
  const stintOf = new Map(stints.map((s) => [s.cwid, s]));
  const eligible = stints
    .filter((s) => params.membership === "all" || s.membershipType === params.membership)
    .map((s) => s.cwid);
  if (eligible.length === 0) return [];

  const pubs = await db.read.publication.findMany({
    where: {
      dateAddedToEntrez: {
        gte: new Date(`${params.start}T00:00:00Z`),
        lte: new Date(`${params.end}T00:00:00Z`),
      },
      authors: { some: { isConfirmed: true, cwid: { in: eligible } } },
    },
    orderBy: [{ dateAddedToEntrez: "desc" }, { pmid: "desc" }],
    select: {
      pmid: true,
      title: true,
      journal: true,
      dateAddedToEntrez: true,
      authors: {
        where: { isConfirmed: true, cwid: { not: null } },
        select: {
          cwid: true,
          position: true,
          isFirst: true,
          isLast: true,
          totalAuthors: true,
          scholar: { select: { fullName: true } },
        },
      },
    },
  });
  const decided = pubs.length
    ? await db.read.centerPublicationRelevance.findMany({
        where: { centerCode, pmid: { in: pubs.map((p) => p.pmid) } },
        select: { pmid: true, relevant: true, reason: true },
      })
    : [];
  const byPmid = new Map(decided.map((d) => [d.pmid, d]));
  const eligibleSet = new Set(eligible);

  const rows: PubCitationRow[] = [];
  for (const p of pubs) {
    const date = p.dateAddedToEntrez!.toISOString().slice(0, 10);
    const authors = p.authors.map((a) => ({ ...a, cwid: a.cwid as string }));
    // In scope only when an eligible author's stint covers the publication date.
    if (!authors.some((a) => eligibleSet.has(a.cwid) && stintCovers(stintOf.get(a.cwid), date)))
      continue;
    const d = byPmid.get(p.pmid);
    const relevant = d?.relevant ?? null;
    if (params.relevance === "yes" && relevant !== true) continue;
    // Byline order. `position` 0 is "middle, rank unknown" (#2227), so it
    // sorts just before the last author rather than first.
    const rank = (a: (typeof authors)[number]) =>
      a.isFirst ? 0 : a.isLast ? Infinity : a.position || a.totalAuthors;
    rows.push({
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      date,
      relevant,
      reason: d?.reason ?? null,
      // Names only, never a CWID: an author without a scholar row is left out.
      investigators: authors
        .filter((a) => a.scholar)
        .sort((a, b) => rank(a) - rank(b))
        .map((a) => ({
          cwid: a.cwid,
          line: investigatorLine(a.scholar!.fullName, programAsOf(stintOf.get(a.cwid), date)),
        })),
    });
  }
  return rows;
}
