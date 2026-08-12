/**
 * `/edit/reports/3` ("Publications") data layer — per-center publications ×
 * Journal Impact Factor report (`etl/journal-impact-factor` mirrors the
 * source table weekly into `JournalImpactFactor`).
 *
 * Membership: the SAME `loadActiveCenterMemberCwids` (`lib/api/centers.ts`)
 * every other center-wide surface uses — never re-derived. Publications:
 * confirmed-authorship fan-out across the member set, the same
 * `authors: { some: { isConfirmed, cwid: { in } } }` relation filter
 * `getCenterPublicationsListUncached` (`lib/api/centers.ts`) and
 * `etl/cancer-center-collab-report` use. This is an internal `/edit` review
 * surface, not a public one, so — like the collab-report precompute — it
 * does NOT layer the public-surface suppression/darkness overlay
 * (`lib/api/manual-layer.ts`); a curator reviewing coverage needs to see the
 * center's full confirmed-authorship set, hidden-from-public or not.
 *
 * ponytail: exact-match join on normalized journalAbbrev — publications in a
 * journal not in journal_impact_alternative, or with inconsistent
 * abbreviation formatting, won't match. Upgrade path if match rate proves too
 * low: a curated ISSN/name crosswalk, not a fuzzy-match library.
 */
import { db } from "@/lib/db";
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { normalizeJournalAbbrev } from "@/lib/journal-abbrev";

/** `impactScore1` (current-year JIF) threshold for the report's "high impact"
 *  headline stat. See the `JournalImpactFactor` schema doc comment for how
 *  impactScore1 vs. impactScore2 was confirmed against known journals. */
export const HIGH_IMPACT_THRESHOLD = 10;

export type PublicationsReportRow = {
  pmid: string;
  title: string;
  /** Full journal name as PubMed carries it — shown when the matched JIF
   *  title differs (rare formatting variants) or as a fallback label. */
  journal: string | null;
  /** `Publication.journalAbbrev` as stored (NLM/Index Medicus style),
   *  unnormalized — the raw value that produced the match. */
  journalAbbrev: string | null;
  year: number | null;
  /** `JournalImpactFactor.journalTitle` for the matched row — the JCR title,
   *  which can read slightly differently than PubMed's `journal`. */
  matchedJournalTitle: string;
  /** Current-year Journal Impact Factor, or null (13 of 21,800 source rows
   *  lack one — a journal just added to WoS tracking). */
  impactScore1: number | null;
  /** 5-year Journal Impact Factor, or null (more commonly absent than
   *  impactScore1 — needs 5 years of citation history to compute). */
  impactScore2: number | null;
  /** Parsed from `JournalImpactFactor.category` (e.g. "ONCOLOGY|Q1|1/322"). */
  categoryName: string | null;
  quartile: string | null;
  categoryRank: string | null;
};

export type PublicationsReport = {
  /** Every publication with ≥1 confirmed center-member author — the
   *  denominator for `matchRatePct`. */
  totalPublications: number;
  /** Publications whose journal matched a `JournalImpactFactor` row. */
  matchedPublications: number;
  /** matchedPublications / totalPublications, 0–100. 0 when totalPublications
   *  is 0 (never a NaN or divide-by-zero). */
  matchRatePct: number;
  /** Among MATCHED publications only: how many are in a journal with
   *  impactScore1 >= HIGH_IMPACT_THRESHOLD. NEVER computed against
   *  totalPublications — see highImpactRatePct. */
  highImpactCount: number;
  /** highImpactCount / matchedPublications, 0–100. 0 when matchedPublications
   *  is 0. This is the number that would silently overstate confidence if a
   *  future edit computed it against totalPublications instead — the whole
   *  reason this field and matchRatePct are separate, explicit numbers rather
   *  than one blended percentage. */
  highImpactRatePct: number;
  /** MATCHED publications only, impactScore1 desc (nulls last) then pmid asc
   *  for a stable order. Unmatched publications are omitted from the table —
   *  the match-rate line above already accounts for them; a row that can only
   *  ever show "no data" for every IF column added no information a curator
   *  could act on. */
  rows: PublicationsReportRow[];
};

const EMPTY_REPORT: PublicationsReport = {
  totalPublications: 0,
  matchedPublications: 0,
  matchRatePct: 0,
  highImpactCount: 0,
  highImpactRatePct: 0,
  rows: [],
};

/** Parse `JournalImpactFactor.category` ("ONCOLOGY|Q1|1/322") into its three
 *  parts. Best-effort: a null, empty, or malformed value yields all-null
 *  fields rather than throwing — this is a report render detail, never worth
 *  failing the whole page over. */
export function parseCategory(raw: string | null): {
  categoryName: string | null;
  quartile: string | null;
  categoryRank: string | null;
} {
  if (!raw) return { categoryName: null, quartile: null, categoryRank: null };
  const [categoryName, quartile, categoryRank] = raw.split("|").map((p) => p.trim());
  return {
    categoryName: categoryName || null,
    quartile: quartile || null,
    categoryRank: categoryRank || null,
  };
}

/**
 * Build the report for one center: resolve active members, pull their
 * confirmed-authorship publications, join each to `JournalImpactFactor` by
 * normalized `journalAbbrev`, and compute the match/high-impact stats.
 *
 * The `JournalImpactFactor` lookup is scoped to only the abbreviations this
 * center's publications actually carry (a `findMany({ where: { in: [...] } })`
 * over at most `totalPublications` distinct values), never the full ~21,800-
 * row table.
 */
export async function loadCancerCenterPublicationsReport(
  centerCode: string,
): Promise<PublicationsReport> {
  const memberCwids = await loadActiveCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) return EMPTY_REPORT;

  const pubs = await db.read.publication.findMany({
    where: { authors: { some: { isConfirmed: true, cwid: { in: memberCwids } } } },
    select: { pmid: true, title: true, journal: true, journalAbbrev: true, year: true },
  });
  const totalPublications = pubs.length;
  if (totalPublications === 0) return EMPTY_REPORT;

  const neededAbbrevs = Array.from(
    new Set(
      pubs
        .map((p) => (p.journalAbbrev ? normalizeJournalAbbrev(p.journalAbbrev) : null))
        .filter((a): a is string => a !== null && a.length > 0),
    ),
  );
  const jifRows =
    neededAbbrevs.length > 0
      ? await db.read.journalImpactFactor.findMany({
          where: { journalAbbrev: { in: neededAbbrevs } },
        })
      : [];
  const jifByAbbrev = new Map(jifRows.map((j) => [j.journalAbbrev, j]));

  const rows: PublicationsReportRow[] = [];
  let highImpactCount = 0;
  for (const p of pubs) {
    const abbrev = p.journalAbbrev ? normalizeJournalAbbrev(p.journalAbbrev) : null;
    const jif = abbrev ? jifByAbbrev.get(abbrev) : undefined;
    if (!jif) continue; // unmatched — omitted from the table, see PublicationsReport.rows doc

    const impactScore1 = jif.impactScore1 === null ? null : Number(jif.impactScore1);
    const impactScore2 = jif.impactScore2 === null ? null : Number(jif.impactScore2);
    if (impactScore1 !== null && impactScore1 >= HIGH_IMPACT_THRESHOLD) highImpactCount++;

    const { categoryName, quartile, categoryRank } = parseCategory(jif.category);
    rows.push({
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      journalAbbrev: p.journalAbbrev,
      year: p.year,
      matchedJournalTitle: jif.journalTitle,
      impactScore1,
      impactScore2,
      categoryName,
      quartile,
      categoryRank,
    });
  }
  rows.sort((a, b) => {
    if (a.impactScore1 === b.impactScore1) return a.pmid.localeCompare(b.pmid);
    if (a.impactScore1 === null) return 1;
    if (b.impactScore1 === null) return -1;
    return b.impactScore1 - a.impactScore1;
  });

  const matchedPublications = rows.length;
  return {
    totalPublications,
    matchedPublications,
    matchRatePct: totalPublications > 0 ? (matchedPublications / totalPublications) * 100 : 0,
    highImpactCount,
    // Denominator is matchedPublications, NEVER totalPublications — see the
    // doc comment on PublicationsReport.highImpactRatePct.
    highImpactRatePct: matchedPublications > 0 ? (highImpactCount / matchedPublications) * 100 : 0,
    rows,
  };
}
