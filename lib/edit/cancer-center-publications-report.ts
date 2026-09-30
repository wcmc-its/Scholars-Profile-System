/**
 * `/edit/reports/3` ("Publications") data layer — per-unit publications ×
 * Journal Impact Factor report (`etl/journal-impact-factor` mirrors the
 * source table weekly into `JournalImpactFactor`). Genericized off its
 * original center-only shape (org-unit publications reports plan,
 * 2026-08-16) to also serve department and division units — the catalog
 * blurb's old "cancer-relevance tagging" claim was never true of this code
 * either way; see that plan's item 4.
 *
 * MEMBERSHIP-BASED for the three classic org units, USAGE-BASED for a core —
 * see `resolvePublicationScope` for why. `center`:
 * `loadActiveCenterMemberCwids` (`lib/api/centers.ts`). `division`:
 * `loadDivisionMemberCwids` (`lib/api/divisions.ts`). `department`: the same
 * `scholar: { deptCode, deletedAt: null, status: "active" }` predicate
 * `getDeptPublicationsListUncached` (`lib/api/dept-lists.ts`) uses. In all
 * three, publications are a confirmed-authorship fan-out across the member
 * set, the same `authors: { some: { isConfirmed, cwid: { in } } }` relation
 * filter `getCenterPublicationsListUncached` (`lib/api/centers.ts`) and
 * `etl/cancer-center-collab-report` use. `core`: no membership table exists,
 * so the set is the core's CONFIRMED `publication_core` usages
 * (`loadConfirmedCorePmidsByCore`, `lib/api/cores.ts`).
 *
 * This is an internal `/edit` review surface, not a public one, so — like the
 * collab-report precompute — it does NOT layer the public-surface
 * suppression/darkness overlay (`lib/api/manual-layer.ts`); a curator
 * reviewing coverage needs to see the unit's full set, hidden-from-public or
 * not.
 *
 * ponytail: exact-match join on normalized journalAbbrev — publications in a
 * journal not in journal_impact_alternative, or with inconsistent
 * abbreviation formatting, won't match. Upgrade path if match rate proves too
 * low: a curated ISSN/name crosswalk, not a fuzzy-match library.
 */
import { db } from "@/lib/db";
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { loadConfirmedCorePmidsByCore } from "@/lib/api/cores";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";
import type { ReportableUnitKind } from "@/lib/edit/cancer-center-reports";
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
   *  lack one — a journal just added to WoS tracking). Secondary sort key —
   *  see `PublicationsReport.rows`. */
  impactScore1: number | null;
  /** 5-year Journal Impact Factor, or null (more commonly absent than
   *  impactScore1 — needs 5 years of citation history to compute). */
  impactScore2: number | null;
  /** Parsed from `JournalImpactFactor.category` (e.g. "ONCOLOGY|Q1|1/322"). */
  categoryName: string | null;
  quartile: string | null;
  categoryRank: string | null;
  /** `Publication.impactScore` — the paper-level GPT-rubric impact score
   *  (0-100). The report's PRIMARY sort key (org-unit publications reports
   *  plan, "Ranking"): a paper-level signal, paired with `impactJustification`
   *  below, over the journal-level `impactScore1` that used to rank this
   *  report alone. Null for a pub the ReciterAI impact-scoring ETL hasn't
   *  reached yet. */
  impactScore: number | null;
  /** `Publication.impactJustification` — GPT-generated rationale for
   *  `impactScore` (novelty / methodology / influence / translational
   *  relevance). Surfaced as a tooltip on the Impact score cell. Null
   *  whenever `impactScore` is null. */
  impactJustification: string | null;
  /** `Publication.synopsis` — one-line plain-language summary. Surfaced as a
   *  secondary line under the title when present; null for many older or
   *  non-research pubs the ReciterAI synopsis ETL hasn't reached. */
  synopsis: string | null;
  /** Distinct, non-null `Scholar.roleCategory` values among this pub's
   *  CONFIRMED unit-member authors — the Person-type filter rail's key.
   *  `[]` when every confirmed member-author's Scholar row has a null
   *  roleCategory (rare).
   *
   *  For a CORE the key is every CONFIRMED WCM author of the core's confirmed
   *  publications, since "member" has no meaning for a core: a core's users
   *  are exactly the people on the bylines of the work it enabled. Keying it
   *  on members instead would leave the rail permanently empty. */
  authorRoleCategories: ReadonlyArray<string>;
};

export type PublicationsReport = {
  /** The unit's whole publication set — ≥1 confirmed unit-member author for a
   *  center/department/division, every confirmed `publication_core` usage for
   *  a core. The denominator for `matchRatePct`. */
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
  /** MATCHED publications only, `impactScore` desc (nulls last) then
   *  `impactScore1` desc (nulls last, secondary — see the field doc) then
   *  pmid asc for a stable order. Unmatched publications are omitted from the
   *  table — the match-rate line above already accounts for them; a row that
   *  can only ever show "no data" for every IF column added no information a
   *  curator could act on. */
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

/** Descending numeric compare with nulls sorted last — shared by the primary
 *  (`impactScore`) and secondary (`impactScore1`) sort keys below. */
function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Active member CWIDs for a MEMBERSHIP-based `kind`, via the SAME resolver
 *  every other unit-wide surface uses — see the module doc comment. Never
 *  called for a core, which has no membership table. */
async function loadUnitMemberCwids(
  kind: Exclude<ReportableUnitKind, "core">,
  code: string,
): Promise<string[]> {
  if (kind === "center") return loadActiveCenterMemberCwids(code);
  if (kind === "division") return loadDivisionMemberCwids(code);
  const rows = await db.read.scholar.findMany({
    where: { deptCode: code, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  return rows.map((r) => r.cwid);
}

/** How this unit's publication set and its Person-type facet key are selected.
 *  `null` = the unit resolves to no publications at all before any publication
 *  query runs (no members, or no confirmed core usages) — the caller returns
 *  `EMPTY_REPORT` without touching `publication`. */
type PublicationScope = {
  /** `where` for the `publication` query — this unit's whole set. */
  pubWhere: NonNullable<Parameters<typeof db.read.publication.findMany>[0]>["where"];
  /** `where` for the nested `authors` select that keys the Person-type rail. */
  authorWhere: { isConfirmed: true; cwid?: { in: string[] } };
};

/**
 * Kind-aware publication-set resolution — the ONE place reports 3 and 6 differ
 * by unit kind.
 *
 * `center` / `department` / `division` are MEMBERSHIP-based, unchanged: resolve
 * the unit's active member CWIDs, then take every publication with ≥1 confirmed
 * member author.
 *
 * A `core` has NO membership table — there is no roster to resolve and there
 * never will be one. Its meaningful publication set is its CONFIRMED
 * `publication_core` usages, resolved through `loadConfirmedCorePmidsByCore`
 * (`lib/api/cores.ts`), which applies the same `CoreClaim`-over-engine-status
 * merge the public core page and the owner's review queue apply — engine
 * `confirmed` minus any human `rejected` claim, plus every human `claimed`
 * override including a manual PMID add. Nothing about that status semantics is
 * re-derived here.
 *
 * The naive alternative — dropping the core exclusion and letting a core fall
 * through the member path — would resolve zero CWIDs for EVERY core and hand
 * every core owner a permanently empty report: "sees the report" while learning
 * nothing. The publications-from-usages test in
 * `tests/unit/cancer-center-publications-report.test.ts` is the assertion that
 * catches that regression.
 *
 * The facet key follows the same split. For the three member kinds it stays the
 * confirmed MEMBER authors (never the full byline, which includes non-member
 * co-authors). For a core it is every confirmed WCM author of the core's
 * confirmed publications — a core's "people" ARE its users, so scoping the rail
 * to members would leave it permanently empty, which is the same failure in
 * miniature.
 */
async function resolvePublicationScope(
  kind: ReportableUnitKind,
  code: string,
): Promise<PublicationScope | null> {
  if (kind === "core") {
    const pmids = (await loadConfirmedCorePmidsByCore([code], db.read)).get(code) ?? [];
    if (pmids.length === 0) return null;
    return { pubWhere: { pmid: { in: pmids } }, authorWhere: { isConfirmed: true } };
  }
  const memberCwids = await loadUnitMemberCwids(kind, code);
  if (memberCwids.length === 0) return null;
  return {
    pubWhere: { authors: { some: { isConfirmed: true, cwid: { in: memberCwids } } } },
    authorWhere: { isConfirmed: true, cwid: { in: memberCwids } },
  };
}

/**
 * Build the report for one unit: resolve its publication set (members for a
 * center/department/division, confirmed core usages for a core — see
 * `resolvePublicationScope`), join each publication to `JournalImpactFactor` by
 * normalized `journalAbbrev`, and compute the match/high-impact stats.
 * Everything downstream of the scope — the JIF join, the summary, the table,
 * the sort — is kind-agnostic and runs unchanged.
 *
 * The `JournalImpactFactor` lookup is scoped to only the abbreviations this
 * unit's publications actually carry (a `findMany({ where: { in: [...] } })`
 * over at most `totalPublications` distinct values), never the full ~21,800-
 * row table.
 */
export async function loadUnitPublicationsReport(
  kind: ReportableUnitKind,
  code: string,
): Promise<PublicationsReport> {
  const scope = await resolvePublicationScope(kind, code);
  if (scope === null) return EMPTY_REPORT;

  const pubs = await db.read.publication.findMany({
    where: scope.pubWhere,
    select: {
      pmid: true,
      title: true,
      journal: true,
      journalAbbrev: true,
      year: true,
      impactScore: true,
      impactJustification: true,
      synopsis: true,
      // The Person-type facet's key — see `resolvePublicationScope`. For a
      // member kind this is only the CONFIRMED MEMBER authors, never the full
      // author list (which includes non-member co-authors); for a core it is
      // every confirmed WCM author of the core's confirmed publications.
      authors: {
        where: scope.authorWhere,
        select: { cwid: true },
      },
    },
  });
  const totalPublications = pubs.length;
  if (totalPublications === 0) return EMPTY_REPORT;

  const facetAuthorCwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid).filter((c): c is string => c !== null))),
  );
  const roleCategoryByCwid =
    facetAuthorCwids.length > 0
      ? new Map(
          (
            await db.read.scholar.findMany({
              where: { cwid: { in: facetAuthorCwids } },
              select: { cwid: true, roleCategory: true },
            })
          ).map((s) => [s.cwid, s.roleCategory]),
        )
      : new Map<string, string | null>();

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
    const impactScore = p.impactScore === null || p.impactScore === undefined ? null : Number(p.impactScore);
    const authorRoleCategories = Array.from(
      new Set(
        p.authors
          .map((a) => (a.cwid ? roleCategoryByCwid.get(a.cwid) : null))
          .filter((r): r is string => !!r),
      ),
    );
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
      impactScore,
      impactJustification: p.impactJustification ?? null,
      synopsis: p.synopsis ?? null,
      authorRoleCategories,
    });
  }
  rows.sort((a, b) => {
    const byImpactScore = compareDescNullsLast(a.impactScore, b.impactScore);
    if (byImpactScore !== 0) return byImpactScore;
    const byJif = compareDescNullsLast(a.impactScore1, b.impactScore1);
    if (byJif !== 0) return byJif;
    return a.pmid.localeCompare(b.pmid);
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
