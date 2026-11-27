/**
 * Pure shaping for the clinical-citations ETL: no I/O, so it is unit-tested
 * directly (tests/unit/clinical-citations.test.ts).
 */
import { Prisma } from "@/lib/generated/prisma/client";
import { pubmedDoc, type CitingDoc, type PubmedSummary } from "../policy-citations/shape";

export const CLINICAL_LEVEL = "clinical";

/**
 * What to do with a citing clinical article, given the level its PubMed
 * document is stored at (undefined: not stored).
 *
 *   - "fetch": not stored. Its record is fetched from PubMed and stored at
 *     level `clinical`, then its links.
 *   - "link": stored as `clinical`. Only its links are written.
 *   - "skip": stored at any other level (a guideline, consensus statement or
 *     review from etl:policy-citations). The row keeps its level and this
 *     import writes it no links, so the article is counted once, at the ranked
 *     level, and no ranked count can move because of this import.
 */
export function clinicalAction(storedLevel: string | undefined): "fetch" | "link" | "skip" {
  if (storedLevel === undefined) return "fetch";
  return storedLevel === CLINICAL_LEVEL ? "link" : "skip";
}

/** A citing clinical article as a citing document, from its PubMed summary. */
export function clinicalDoc(pmid: number, summary: PubmedSummary): CitingDoc {
  return pubmedDoc(pmid, CLINICAL_LEVEL, summary);
}

/**
 * The authors' own work: the citing article is one of our publications and
 * shares a confirmed WCM author with the paper it cites. "Confirmed" is what
 * the trials pass uses for `ownTrial`: a `publication_author` row with
 * `is_confirmed` and a CWID. A citing article we do not hold has no such rows,
 * so it is never own work.
 */
export function isOwnWork(
  citedAuthors: ReadonlySet<string> | undefined,
  citingAuthors: ReadonlySet<string> | undefined,
): boolean {
  if (!citedAuthors || !citingAuthors) return false;
  for (const cwid of citedAuthors) if (citingAuthors.has(cwid)) return true;
  return false;
}

/** The link's `evidence` for own work. */
export const OWN_WORK = { ownWork: true } as const;

/**
 * `publication.clinical_cite_count`, as an aggregate over `l`
 * (`publication_citing_document`) joined to `d` (`citing_document`), grouped
 * by `l.pmid`: citing documents at level `clinical`, less the authors' own.
 * Counted by document, not by `dedup_key`: the count has to equal the list a
 * reader opens, and that list is one row per article. Used by both writers of
 * the column (load.ts here, and the weekly rollup in etl/policy-citations).
 */
export const CLINICAL_COUNT_SQL = Prisma.sql`COUNT(DISTINCT CASE WHEN d.level = 'clinical'
                     AND COALESCE(JSON_CONTAINS(l.evidence, 'true', '$.ownWork'), 0) = 0 THEN d.id END)`;
