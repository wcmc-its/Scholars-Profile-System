/**
 * Report 19 loader: the center's programs, its members of the chosen type,
 * and the period's publications with ≥1 confirmed such author, each with its
 * `center_publication_relevance` decision and journal JIF, counted by
 * `computeCollabPubMatrix`. The caller has passed the unit gate. Server-only
 * (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/edit/cancer-center-publications-report";
import {
  computeCollabPubMatrix,
  type CollabPubMatrix,
  type CollabPubMatrixParams,
  type MatrixPub,
} from "@/lib/edit/collab-pub-matrix";
import { normalizeJournalAbbrev } from "@/lib/journal-abbrev";

export type CollabPubMatrixReport = CollabPubMatrix & {
  /** Every program of the center, for the exclude control (excluded ones too). */
  allPrograms: Array<{ code: string; label: string }>;
  /** Period publications with a member author and no relevance decision yet. */
  notScored: number;
};

export async function loadCollabPubMatrix(
  centerCode: string,
  p: CollabPubMatrixParams,
): Promise<CollabPubMatrixReport> {
  const [allPrograms, members] = await Promise.all([
    db.read.centerProgram.findMany({
      where: { centerCode },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { code: true, label: true },
    }),
    db.read.centerMembership.findMany({
      where: {
        centerCode,
        ...(p.membershipType === "any" ? {} : { membershipType: p.membershipType }),
      },
      select: {
        cwid: true,
        programCode: true,
        startDate: true,
        endDate: true,
        membershipRoleKey: true,
      },
    }),
  ]);
  const cwids = members.map((m) => m.cwid);
  const pubs = cwids.length
    ? await db.read.publication.findMany({
        where: {
          year: { gte: p.from, lte: p.to },
          authors: { some: { isConfirmed: true, cwid: { in: cwids } } },
        },
        select: {
          pmid: true,
          year: true,
          dateAddedToEntrez: true,
          journalAbbrev: true,
          authors: { where: { isConfirmed: true, cwid: { in: cwids } }, select: { cwid: true } },
        },
      })
    : [];
  const decided = pubs.length
    ? await db.read.centerPublicationRelevance.findMany({
        where: { centerCode, pmid: { in: pubs.map((x) => x.pmid) } },
        select: { pmid: true, relevant: true, source: true, externalAuthor: true },
      })
    : [];
  const byPmid = new Map(decided.map((d) => [d.pmid, d]));

  const abbrevs = [
    ...new Set(
      pubs
        .map((x) => (x.journalAbbrev ? normalizeJournalAbbrev(x.journalAbbrev) : ""))
        .filter(Boolean),
    ),
  ];
  const jif = abbrevs.length
    ? new Map(
        (
          await db.read.journalImpactFactor.findMany({
            where: { journalAbbrev: { in: abbrevs } },
            select: { journalAbbrev: true, impactScore1: true },
          })
        ).map((j) => [j.journalAbbrev, j.impactScore1 === null ? null : Number(j.impactScore1)]),
      )
    : new Map<string, number | null>();

  const universe: MatrixPub[] = [];
  for (const x of pubs) {
    const d = byPmid.get(x.pmid);
    if (!d?.relevant || (p.confirmedOnly && d.source !== "human")) continue;
    universe.push({
      pmid: x.pmid,
      // No full publication date is stored; the PubMed entry date stands in.
      pubDate: x.dateAddedToEntrez?.toISOString().slice(0, 10) ?? `${x.year}-01-01`,
      memberCwids: x.authors.map((a) => a.cwid as string),
      externalAuthor: d.externalAuthor,
      impactScore1: x.journalAbbrev
        ? (jif.get(normalizeJournalAbbrev(x.journalAbbrev)) ?? null)
        : null,
    });
  }

  return {
    ...computeCollabPubMatrix(universe, members, allPrograms, p.excluded, HIGH_IMPACT_THRESHOLD),
    allPrograms,
    notScored: pubs.filter((x) => !byPmid.has(x.pmid)).length,
  };
}
