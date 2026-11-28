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
import { shapeScholarInventions, shapeTrialPatentCitations } from "@/lib/citations/trials-patents";
import { OWN_FLAG, ownFlagSql } from "@/lib/edit/downstream-reach-report";
import { loadPatentDataEnd } from "@/lib/edit/patent-citations-report";
import { NEVER_DISPLAY_TYPES } from "@/lib/publication-types";
import {
  buildBibliometricsReport,
  inScope,
  rankPapers,
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
          clinicalCiteCount: true,
          trialCount: true,
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
  return (await loadBibliometrics(cwid, filters, now))?.report ?? null;
}

/** The report, and the research articles in scope it counts (ranked as Most
 *  impactful papers ranks them) for the spreadsheet download. */
export async function loadBibliometrics(
  cwid: string,
  filters: BibliometricsFilters,
  now: Date = new Date(),
): Promise<{ report: BibliometricsReport; articles: BibliometricsPubRow[] } | null> {
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
  // Only the research articles inside the filters, as the report counts them.
  const scoped = visible.filter((p) => p.publicationType === "Academic Article" && inScope(p, filters));
  const citedPmids = scoped
    .filter((p) => p.authorityCount + p.guidelineCount + p.consensusCount + p.reviewCount > 0)
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

  // Distinct clinical studies and registered trials citing the articles in
  // scope, the authors' own left out exactly as the rollups (and report 27)
  // test it.
  const researchPmids = scoped.filter((p) => (p.clinicalCiteCount ?? 0) + (p.trialCount ?? 0) > 0).map((p) => p.pmid);
  if (researchPmids.length > 0) {
    const rows = await db.read.$queryRaw<{ level: string; n: bigint | number }[]>`
      SELECT d.level AS level, COUNT(DISTINCT d.id) AS n
        FROM publication_citing_document l
        JOIN citing_document d ON d.id = l.citing_document_id
       WHERE l.pmid IN (${Prisma.join(researchPmids)})
         AND d.level IN ('clinical', 'trial')
         AND NOT ((d.level = 'clinical' AND ${ownFlagSql("l", OWN_FLAG.clinical!)})
               OR (d.level = 'trial' AND ${ownFlagSql("l", OWN_FLAG.trial!)}))
       GROUP BY d.level`;
    for (const r of rows) if (r.level === "clinical" || r.level === "trial") report.research[r.level].documents = Number(r.n);
  }

  // The inventions citing the scholar's papers, listed on the card and under
  // each listed paper: one patent family citing two papers counts once. The
  // papers come off the rollup column.
  // ponytail: every patent link of the scholar's cited papers is read (the
  // modal reads one paper's, about 2,700 rows at most). Group in SQL if a
  // heavily cited scholar's tab ever shows it in latency.
  const patentPmids = scoped.filter((p) => p.patentFamilyCount > 0).map((p) => p.pmid);
  if (patentPmids.length > 0) {
    const links = await db.read.publicationCitingDocument.findMany({
      where: { pmid: { in: patentPmids }, citingDocument: { level: "patent" } },
      select: {
        pmid: true,
        evidence: true,
        citingDocument: {
          select: { id: true, level: true, externalId: true, title: true, year: true, url: true, dedupKey: true, details: true },
        },
      },
    });
    const all = shapeScholarInventions(links);
    report.patents.inventions = all.total;
    report.patents.list = all.items;
    report.patents.dataEnd = await loadPatentDataEnd();
    for (const p of report.papers.rows) {
      if (p.patents === 0) continue;
      const mine = shapeTrialPatentCitations(links.filter((l) => l.pmid === p.pmid), { trials: false, patents: true });
      p.citingPatents = mine?.inventions ?? null;
    }
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
  return { report, articles: rankPapers(scoped) };
}
