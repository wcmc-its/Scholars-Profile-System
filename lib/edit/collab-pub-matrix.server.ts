/**
 * Report 19 loader: the center's programs and the shared attribution
 * (`loadCenterPubAttribution`: members active on the as-of date, program on
 * that date, publications from their WCM tenure) narrowed to the matrix's
 * universe (`matrixUniverse`), each with its inter-institutional flag and
 * journal JIF, counted by `computeCollabPubMatrix`. The caller has passed the
 * unit gate. Server-only (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import { HIGH_IMPACT_THRESHOLD } from "@/lib/edit/cancer-center-publications-report";
import { loadCenterPubAttribution } from "@/lib/edit/center-pub-attribution.server";
import {
  computeCollabPubMatrix,
  matrixUniverse,
  type CollabPubMatrix,
  type CollabPubMatrixParams,
} from "@/lib/edit/collab-pub-matrix";
import { normalizeJournalAbbrev } from "@/lib/journal-abbrev";

export type CollabPubMatrixReport = CollabPubMatrix & {
  /** Every program of the center, for the exclude control (excluded ones too). */
  allPrograms: Array<{ code: string; label: string }>;
  /** Period non-review publications with a member author and no relevance decision yet. */
  notScored: number;
  /** Members active on the as-of date with no known WCM tenure. */
  unknownTenureMembers: number;
};

export async function loadCollabPubMatrix(
  centerCode: string,
  p: CollabPubMatrixParams,
): Promise<CollabPubMatrixReport> {
  const [allPrograms, attribution] = await Promise.all([
    db.read.centerProgram.findMany({
      where: { centerCode },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { code: true, label: true },
    }),
    loadCenterPubAttribution(centerCode, {
      from: `${p.from}-01-01`,
      to: `${p.to}-12-31`,
      asOf: p.asOf,
      membershipType: p.membershipType,
    }),
  ]);
  const pubs = matrixUniverse(attribution.publications, p.confirmedOnly);
  const pmids = pubs.map((x) => x.pmid);
  const [flags, journals] = pmids.length
    ? await Promise.all([
        db.read.centerPublicationRelevance.findMany({
          where: { centerCode, pmid: { in: pmids } },
          select: { pmid: true, externalAuthor: true },
        }),
        db.read.publication.findMany({
          where: { pmid: { in: pmids } },
          select: { pmid: true, journalAbbrev: true },
        }),
      ])
    : [[], []];
  const external = new Map(flags.map((f) => [f.pmid, f.externalAuthor]));
  const abbrevByPmid = new Map(
    journals.map((j) => [j.pmid, j.journalAbbrev ? normalizeJournalAbbrev(j.journalAbbrev) : ""]),
  );

  const abbrevs = [...new Set(abbrevByPmid.values())].filter(Boolean);
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

  const matrix = computeCollabPubMatrix(
    pubs.map((x) => ({
      pmid: x.pmid,
      members: x.members,
      externalAuthor: external.get(x.pmid) ?? null,
      impactScore1: jif.get(abbrevByPmid.get(x.pmid) ?? "") ?? null,
    })),
    allPrograms,
    p.excluded,
    HIGH_IMPACT_THRESHOLD,
  );
  return {
    ...matrix,
    allPrograms,
    notScored: attribution.publications.filter((x) => x.relevant === null && !x.isReview).length,
    unknownTenureMembers: attribution.unknownTenureMembers,
  };
}
