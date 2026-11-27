/**
 * Loads one scholar's Bibliometrics report (`EDIT_BIBLIOMETRICS`). Everything
 * is computed at read time from rows the profile already uses: one authorship
 * query, the publication suppressions, one grouped count of citing documents,
 * one count of citing inventions, and the citing lists of the ten papers shown. Server-only.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { isAuthorHidden, loadPublicationSuppressions } from "@/lib/api/manual-layer";
import { readPolicyCitations } from "@/lib/api/publication-detail";
import { resolveSearchPubsTranslationalStageFacet } from "@/lib/api/search-flags";
import { POLICY_LEVELS } from "@/lib/citations/policy-rollup";
import { PATENT_DATA_END } from "@/lib/edit/patent-citations-report";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import {
  buildBibliometricsReport,
  type BibliometricsFilters,
  type BibliometricsPubRow,
  type BibliometricsReport,
} from "@/lib/edit/bibliometrics";

const num = (d: { toString(): string } | null): number | null => (d === null ? null : Number(d));

/**
 * The scholar and their confirmed authorships: `all` of them, and the
 * `visible` ones the profile shows. The report and the patents download both
 * start here, so they cover the same papers. Null for a cwid with no scholar.
 */
export async function loadScholarPublications(cwid: string): Promise<{
  scholar: { cwid: string; preferredName: string; hIndex: number | null };
  all: BibliometricsPubRow[];
  visible: BibliometricsPubRow[];
} | null> {
  const scholar = await db.read.scholar.findUnique({
    where: { cwid },
    select: { cwid: true, preferredName: true, hIndex: true },
  });
  if (!scholar) return null;

  const authorships = await db.read.publicationAuthor.findMany({
    where: { cwid, isConfirmed: true },
    select: {
      position: true,
      isFirst: true,
      isLast: true,
      publication: {
        select: {
          pmid: true,
          title: true,
          authorsString: true,
          journal: true,
          year: true,
          volume: true,
          issue: true,
          pages: true,
          doi: true,
          publicationType: true,
          citationCount: true,
          citedByCount: true,
          nihPercentile: true,
          relativeCitationRatio: true,
          dateAddedToEntrez: true,
          authorityBodies: true,
          authorityCount: true,
          guidelineCount: true,
          consensusCount: true,
          reviewCount: true,
          patentFamilyCount: true,
          translationalStage: true,
          translationalStageConfidence: true,
        },
      },
    },
  });
  const all: BibliometricsPubRow[] = authorships.map(({ publication: p, ...a }) => ({
    ...p,
    ...a,
    nihPercentile: num(p.nihPercentile),
    relativeCitationRatio: num(p.relativeCitationRatio),
  }));

  // The same two filters the profile applies: never-displayed types, and
  // papers the scholar hid or that were taken down whole.
  const suppressions = await loadPublicationSuppressions(
    all.map((p) => p.pmid),
    db.read,
  );
  const never: readonly string[] = NEVER_DISPLAY_TYPES;
  const visible = all.filter(
    (p) =>
      !never.includes(p.publicationType ?? "") &&
      !isAuthorHidden(suppressions, p.pmid, cwid) &&
      !suppressions.darkPmids.has(p.pmid),
  );
  return { scholar, all, visible };
}

export async function loadBibliometricsReport(
  cwid: string,
  filters: BibliometricsFilters,
  now: Date = new Date(),
): Promise<BibliometricsReport | null> {
  const pubs = await loadScholarPublications(cwid);
  if (!pubs) return null;
  const { scholar, all, visible } = pubs;

  const report = buildBibliometricsReport({
    scholar: { cwid, name: scholar.preferredName, hIndex: scholar.hIndex },
    visible,
    all,
    filters,
    now,
    stagesEnabled: resolveSearchPubsTranslationalStageFacet(),
  });

  // Distinct citing documents per level: a guideline citing two of the
  // scholar's papers counts once, which per-paper rollups cannot say.
  const citedPmids = visible
    .filter(
      (p) =>
        p.publicationType === "Academic Article" &&
        p.authorityCount + p.guidelineCount + p.consensusCount + p.reviewCount > 0,
    )
    .map((p) => p.pmid);
  if (citedPmids.length > 0) {
    const rows = await db.read.$queryRaw<{ level: string; body: string | null; n: bigint | number }[]>`
      SELECT d.level AS level, d.issuing_body AS body, COUNT(DISTINCT d.dedup_key) AS n
        FROM publication_citing_document l
        JOIN citing_document d ON d.id = l.citing_document_id
       WHERE l.pmid IN (${Prisma.join(citedPmids)})
         AND d.level IN (${Prisma.join([...POLICY_LEVELS])})
       GROUP BY d.level, d.issuing_body`;
    for (const level of report.policy) {
      const mine = rows.filter((r) => r.level === level.level);
      level.documents = mine.reduce((sum, r) => sum + Number(r.n), 0);
      if (level.level === "authority") {
        level.bodies = mine
          .flatMap((r) => (r.body ? [{ body: r.body, count: Number(r.n) }] : []))
          .sort((a, b) => b.count - a.count || a.body.localeCompare(b.body));
      }
    }
  }

  // Distinct inventions across the scholar's cited papers: one patent family
  // citing two of them counts once. The papers come off the rollup column.
  const patentPmids = visible.filter((p) => p.patentFamilyCount > 0).map((p) => p.pmid);
  if (patentPmids.length > 0) {
    const [row] = await db.read.$queryRaw<{ n: bigint | number }[]>`
      SELECT COUNT(DISTINCT d.dedup_key) AS n
        FROM publication_citing_document l
        JOIN citing_document d ON d.id = l.citing_document_id
       WHERE l.pmid IN (${Prisma.join(patentPmids)})
         AND d.level = 'patent'`;
    report.patents.inventions = Number(row?.n ?? 0);
    report.patents.dataEnd = PATENT_DATA_END.label;
  }

  // The listed papers' WCM authors, for the author chips. Unranked rows
  // (position 0, #2227) go last, not first.
  const coauthors = await db.read.publicationAuthor.findMany({
    where: {
      pmid: { in: report.papers.rows.map((p) => p.pmid) },
      isConfirmed: true,
      scholar: { deletedAt: null },
    },
    select: { pmid: true, position: true, scholar: { select: { cwid: true, preferredName: true } } },
  });
  for (const p of report.papers.rows) {
    p.wcmAuthors = coauthors
      .filter((a) => a.pmid === p.pmid && a.scholar)
      .sort((a, b) => (a.position || Infinity) - (b.position || Infinity))
      .map((a) => ({ cwid: a.scholar!.cwid, name: a.scholar!.preferredName }));
  }

  // ponytail: `readPolicyCitations` lists the 100 most recent reviews per paper
  // and counts the rest, so the Word document inherits that ceiling.
  await Promise.all(
    report.papers.rows
      .filter((p) => p.authority.length + p.guidelines + p.consensus + p.reviews > 0)
      .map(async (p) => {
        const citations = await readPolicyCitations(p.pmid);
        if (citations) {
          p.citing = citations.docs;
          p.reviewTotal = citations.reviewTotal;
        }
      }),
  );
  return report;
}
