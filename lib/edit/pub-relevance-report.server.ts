/**
 * Report 17 loader: one year of a center's publications with ≥1 confirmed
 * research- or clinical-member author (the set `etl/center-pub-relevance` decides), each
 * with its `center_publication_relevance` row, if any. The caller has passed
 * the unit gate. Server-only (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import type { PubRelevanceRow, PubRelevanceSource } from "@/lib/edit/pub-relevance-report";

export async function loadPubRelevanceReport(
  centerCode: string,
  year: number,
): Promise<PubRelevanceRow[]> {
  const members = await db.read.centerMembership.findMany({
    where: { centerCode, membershipType: { in: ["research", "clinical"] } },
    select: { cwid: true, programCode: true },
  });
  if (members.length === 0) return [];
  const program = new Map(members.map((m) => [m.cwid, m.programCode]));
  const cwids = [...program.keys()];

  const pubs = await db.read.publication.findMany({
    where: { year, authors: { some: { isConfirmed: true, cwid: { in: cwids } } } },
    orderBy: [{ dateAddedToEntrez: "desc" }, { pmid: "desc" }],
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      publicationType: true,
      authors: {
        where: { isConfirmed: true, cwid: { in: cwids } },
        select: { cwid: true, scholar: { select: { preferredName: true } } },
      },
    },
  });
  const decided = pubs.length
    ? await db.read.centerPublicationRelevance.findMany({
        where: { centerCode, pmid: { in: pubs.map((p) => p.pmid) } },
        select: { pmid: true, relevant: true, source: true, reason: true },
      })
    : [];
  const byPmid = new Map(decided.map((d) => [d.pmid, d]));

  return pubs.map((p) => {
    const d = byPmid.get(p.pmid);
    return {
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      year: p.year,
      publicationType: p.publicationType,
      members: p.authors.map((a) => ({
        cwid: a.cwid as string,
        name: a.scholar?.preferredName ?? (a.cwid as string),
        programCode: program.get(a.cwid as string) ?? null,
      })),
      relevant: d?.relevant ?? null,
      source: (d?.source as PubRelevanceSource | undefined) ?? null,
      reason: d?.reason ?? null,
    };
  });
}
