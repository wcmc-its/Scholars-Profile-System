/**
 * Loads one scholar's Bibliometrics report (`EDIT_BIBLIOMETRICS`). Everything
 * is computed at read time from rows the profile already uses: one authorship
 * query, the publication suppressions, one grouped count of citing documents,
 * and the citing lists of the ten papers shown. Server-only.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { isAuthorHidden, loadPublicationSuppressions } from "@/lib/api/manual-layer";
import { readPolicyCitations } from "@/lib/api/publication-detail";
import { POLICY_LEVELS } from "@/lib/citations/policy-rollup";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import {
  buildBibliometricsReport,
  type BibliometricsFilters,
  type BibliometricsPubRow,
  type BibliometricsReport,
} from "@/lib/edit/bibliometrics";

const num = (d: { toString(): string } | null): number | null => (d === null ? null : Number(d));

export async function loadBibliometricsReport(
  cwid: string,
  filters: BibliometricsFilters,
  now: Date = new Date(),
): Promise<BibliometricsReport | null> {
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

  const report = buildBibliometricsReport({
    scholar: { cwid, name: scholar.preferredName, hIndex: scholar.hIndex },
    visible,
    all,
    filters,
    now,
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
