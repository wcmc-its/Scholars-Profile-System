/**
 * ReciterDB ETL — Phase 4b.
 *
 * Pulls publications + WCM authorship from ReciterDB's analysis_summary_*
 * tables, filtering to authorships of currently-active scholars. Note:
 * personIdentifier in ReciterDB is the plain CWID (e.g., `alt2016`) with
 * no prefix; the `cwid_` prefix is DynamoDB-specific.
 *
 * Strategy:
 *   1. Read active CWIDs from our DB; prefix with `cwid_` for ReciterDB lookup
 *   2. Batched query of analysis_summary_author for those personIdentifiers
 *   3. Distinct pmids from result; batched query of analysis_summary_article
 *      for metadata (title, journal, year, type, citation count, dates, DOI)
 *   4. Upsert publications keyed on pmid; scoped delete-then-insert of WCM
 *      PublicationAuthor rows for the source PMID set; full wipe of
 *      PublicationScore (no inbound FK, so wipe is local).
 *   5. End-of-run orphan cleanup: delete publications whose pmid is no longer
 *      in the ReCiter source — cascade to publication_topic / publication_author
 *      / grant_publication / publication_score is intentional for those rows.
 *
 * Issue #247: the prior `publication.deleteMany()` wipe cascaded into
 * publication_topic (onDelete: Cascade), silently emptying a table owned by
 * a different ETL (`ReCiterAI-projection`). Idempotent upsert removes the
 * trigger; only genuinely-removed PMIDs cascade now.
 *
 * Author handling:
 *   - The `authors` string from analysis_summary_author is the full ordered
 *     author list (denormalized — same value for all rows of the same pmid).
 *     We store one copy on Publication.authorsString.
 *   - We insert PublicationAuthor rows only for WCM scholars (where cwid is
 *     known). Profile rendering overlays hyperlinks on matching substrings
 *     in authorsString.
 *   - authorPosition values map to isFirst/isLast/isPenultimate:
 *       'first'                 -> isFirst
 *       'last'                  -> isLast
 *       'first_and_last' / 'sole' -> both
 *       'penultimate'           -> isPenultimate
 *       anything else           -> middle (no flags)
 *
 * Usage: `npm run etl:reciter`
 */
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "../../lib/db";
import { assertPruneVolume, assertSourceVolume } from "../../lib/etl-guard";
import { markTopicRebuildStarted } from "../../lib/etl-state";
import {
  publicationSignature,
  planAuthorshipReconcile,
  type IncomingAuthorship,
} from "./change-detection";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

type AuthorRow = {
  personIdentifier: string;
  pmid: number;
  authorPosition: string | null;
  authors: string | null;
};

type ArticleRow = {
  pmid: number;
  articleTitle: string;
  journalTitleVerbose: string | null;
  articleYear: number | null;
  publicationTypeCanonical: string | null;
  citationCountScopus: number | null;
  datePublicationAddedToEntrez: string | null;
  doi: string | null;
  pmcid: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
};

type AuthorListRow = {
  pmid: number;
  rank: number;
  authorLastName: string | null;
  authorFirstName: string | null;
  personIdentifier: string | null;
};

type JournalAbbrevRow = {
  pmid: number;
  journalTitleISOabbreviation: string | null;
};

type AbstractRow = { pmid: number; abstractVarchar: string | null };

/** #917 v6 — NIH iCite bibliometrics from `reciterdb.analysis_nih` (keyed by pmid).
 *  `relative_citation_ratio` is the field- and time-normalized influence figure used by
 *  the NIH-biosketch impact grounding; `nih_percentile` and the iCite `citation_count`
 *  pair with it. Columns confirmed via `DESCRIBE analysis_nih`. */
type NihRow = {
  pmid: number;
  relative_citation_ratio: number | null;
  nih_percentile: number | null;
  citation_count: number | null;
};

type KeywordRow = { pmid: number; keyword: string; ui: string | null };
type MeshKeyword = { ui: string | null; label: string };

/**
 * Issue #89 — derive PubMed-style initials ("GA", "JWF") from a full
 * first-name string ("G A", "James W F", "Jean-Marc"). Drops dots and
 * splits on whitespace + hyphens so compound names get one initial per
 * part. Empty input → empty string.
 */
function deriveInitials(firstName: string | null | undefined): string {
  if (!firstName) return "";
  return firstName
    .replace(/\./g, "")
    .split(/[\s\-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Compose PubMed-style author list from per-rank rows. Output:
 * `Lastname I, Lastname IJ, Lastname I` — the format Vancouver expects.
 */
function composeAuthorString(rows: AuthorListRow[]): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  const tokens: string[] = [];
  for (const r of sorted) {
    const last = (r.authorLastName ?? "").trim();
    const initials = deriveInitials(r.authorFirstName);
    if (!last) continue;
    tokens.push(initials ? `${last} ${initials}` : last);
  }
  return tokens.length > 0 ? tokens.join(", ") : null;
}

const IN_BATCH = 500; // batch size for IN (...) clauses
const INSERT_BATCH = 1000;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function classifyPosition(pos: string | null): {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
} {
  if (!pos) return { isFirst: false, isLast: false, isPenultimate: false };
  const p = pos.toLowerCase().trim();
  if (p === "first") return { isFirst: true, isLast: false, isPenultimate: false };
  if (p === "last") return { isFirst: false, isLast: true, isPenultimate: false };
  if (p === "first_and_last" || p === "first-and-last" || p === "sole" || p === "only") {
    return { isFirst: true, isLast: true, isPenultimate: false };
  }
  if (p === "penultimate" || p === "second_to_last" || p === "second-to-last") {
    return { isFirst: false, isLast: false, isPenultimate: true };
  }
  return { isFirst: false, isLast: false, isPenultimate: false };
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  // Common formats in ReciterDB: 'YYYY-MM-DD' or full timestamps. Date constructor handles both.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function countAuthors(authorsString: string | null): number {
  if (!authorsString) return 0;
  // Authors are typically comma-separated. Trim trailing punctuation.
  return authorsString
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * #1052 — which scholars' authorships flow into PublicationAuthor. The active,
 * non-deleted set (existing behavior) UNION every doctoral student, including
 * soft-deleted ones (roleCategory prefix `doctoral_student`). Student author
 * rows must be ingested so non-linked student co-authors still chip on a
 * mentor's profile (#1026), and must survive the scoped per-pmid
 * delete/recreate below.
 *
 * The doctoral-student branch deliberately carries NO `status` gate: the
 * `status` column is corrupt for many students, and gating on it is the #1050
 * bug. This widening grants author rows ONLY — no profile, search, or facet
 * presence keys off this set. Genuine takedowns stay enforced downstream:
 * soft-deleted students remain gated by `deletedAt` + `isPubliclyDisplayed` at
 * display time (#1050).
 */
export const INGESTION_SCHOLAR_WHERE: Prisma.ScholarWhereInput = {
  OR: [
    { deletedAt: null, status: "active" },
    { roleCategory: { startsWith: "doctoral_student" } },
  ],
};

export type AuthorshipRow = {
  pmid: string;
  cwid: string;
  position: number;
  totalAuthors: number;
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
  isConfirmed: boolean;
};

/**
 * Build the PublicationAuthor rows from ReciterDB authorship rows, keeping only
 * authorships whose CWID is in the ingestion set (see INGESTION_SCHOLAR_WHERE).
 * Pure — no DB access — so the #1052 invariant (a soft-deleted doctoral-student
 * co-author in `ourCwidSet` still yields an author row) is unit-testable.
 */
export function buildAuthorshipRows(
  authorRows: AuthorRow[],
  ourCwidSet: Set<string>,
  rankByPmidCwid: Map<string, number>,
  totalAuthorsByPmidFromList: Map<number, number>,
): AuthorshipRow[] {
  const authorshipRows: AuthorshipRow[] = [];

  for (const r of authorRows) {
    const cwid = r.personIdentifier;
    // Skip authorships whose CWID isn't in the ingestion set.
    if (!ourCwidSet.has(cwid)) continue;

    const flags = classifyPosition(r.authorPosition);
    // Issue #132 — prefer the per-pmid rank from analysis_summary_author_list
    // (1..N, matches PubMed author position). Fall back to the categorical
    // authorPosition in analysis_summary_author when no list row is matched
    // (very rare; produces middle-author position=0 like the old code path).
    const totalFromList = totalAuthorsByPmidFromList.get(Number(r.pmid));
    const total = totalFromList ?? (countAuthors(r.authors) || 1);
    const rank = rankByPmidCwid.get(`${r.pmid}|${cwid}`);
    const position = rank
      ?? (flags.isFirst ? 1 : flags.isLast ? total : flags.isPenultimate ? Math.max(1, total - 1) : 0);
    const isFirst = rank !== undefined ? rank === 1 : flags.isFirst;
    const isLast = rank !== undefined ? rank === total : flags.isLast;
    const isPenultimate =
      rank !== undefined ? total >= 2 && rank === total - 1 : flags.isPenultimate;

    authorshipRows.push({
      pmid: String(r.pmid),
      cwid,
      position,
      totalAuthors: total,
      isFirst,
      isLast,
      isPenultimate,
      isConfirmed: true,
    });
  }

  return authorshipRows;
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "ReCiter", status: "running" },
  });

  // #118 — open the reciter→dynamodb consistency window. The publication
  // rewrite below leaves topic data transiently incomplete until the dynamodb
  // ETL finishes; the profile Topics section masks it with a placeholder.
  await markTopicRebuildStarted();

  try {
    // 1. Ingestion scholar CWIDs from our DB (active scholars + all doctoral
    //    students incl. soft-deleted — see INGESTION_SCHOLAR_WHERE / #1052).
    console.log("Loading ingestion CWIDs from local DB...");
    const ourScholars = await db.write.scholar.findMany({
      where: INGESTION_SCHOLAR_WHERE,
      select: { cwid: true },
    });
    const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));
    const cwidList = Array.from(ourCwidSet);
    console.log(`Querying ReciterDB for ${cwidList.length} ingestion CWIDs...`);

    // 2. Batched fetch of authorship rows for our scholars
    const authorRows: AuthorRow[] = [];
    for (const batch of chunks(cwidList, IN_BATCH)) {
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT personIdentifier, pmid, authorPosition, authors
           FROM analysis_summary_author
           WHERE personIdentifier IN (?)`,
          [batch],
        )) as AuthorRow[];
        authorRows.push(...rows);
      });
    }
    console.log(`Got ${authorRows.length} authorship rows.`);

    // 3. Distinct pmids; batched fetch of article metadata
    const distinctPmids = Array.from(new Set(authorRows.map((r) => Number(r.pmid))));
    console.log(`Distinct pmids: ${distinctPmids.length}; fetching article metadata...`);

    const articleByPmid = new Map<number, ArticleRow>();
    for (const batch of chunks(distinctPmids, IN_BATCH)) {
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT pmid, articleTitle, journalTitleVerbose, articleYear,
                  publicationTypeCanonical, citationCountScopus,
                  datePublicationAddedToEntrez, doi, pmcid,
                  volume, issue, pages
           FROM analysis_summary_article
           WHERE pmid IN (?)`,
          [batch],
        )) as ArticleRow[];
        for (const a of rows) articleByPmid.set(Number(a.pmid), a);
      });
    }
    console.log(`Got ${articleByPmid.size} article rows.`);

    // ReciterDB's analysis_summary_* tables are themselves rebuilt nightly; a
    // read overlapping that rebuild (or an auth-scope change) succeeds with a
    // truncated set. The corpus only grows in normal operation, so a >20%
    // shrink vs what we already hold means a bad read — abort before the
    // publication_score wipe / authorship rewrite / orphan prune below.
    assertSourceVolume("reciter:publications", {
      incoming: articleByPmid.size,
      existing: await db.write.publication.count(),
      maxDropPct: 20,
    });

    // Issue #21 — pull abstracts for the same pmid set so the search-index
    // ETL can emit a `publicationAbstracts` field on each people document.
    // We use `abstractVarchar` (already capped at 15000 chars at the
    // source) rather than the unbounded `abstract` blob.
    const abstractByPmid = new Map<number, string>();
    for (const batch of chunks(distinctPmids, IN_BATCH)) {
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT pmid, abstractVarchar
           FROM reporting_abstracts
           WHERE pmid IN (?) AND abstractVarchar IS NOT NULL AND abstractVarchar <> ''`,
          [batch],
        )) as AbstractRow[];
        for (const a of rows) {
          if (a.abstractVarchar) abstractByPmid.set(Number(a.pmid), a.abstractVarchar);
        }
      });
    }
    console.log(`Got ${abstractByPmid.size} abstracts.`);

    // Empty-but-reachable secondary tables would mass-null their enrichment
    // column via the unconditional upsert below (same truncated-read fragility
    // as the primary guard above). Compare each map against the rows whose
    // value it is about to overwrite; bootstrap (0 existing) passes.
    assertSourceVolume("reciter:abstracts", {
      incoming: abstractByPmid.size,
      existing: await db.write.publication.count({ where: { abstract: { not: null } } }),
      maxDropPct: 30,
    });

    // #917 v6 — NIH iCite bibliometrics (RCR / NIH percentile / iCite citation count) for the
    // same pmid set, from `reciterdb.analysis_nih`. Rides this weekly refresh so the biosketch
    // impact grounding has the field-normalized figure. Best-effort per batch: a missing or
    // empty `analysis_nih` simply leaves the columns null (the biosketch then grounds impact on
    // the Scopus `citationCount` it already has), so a sparse source never breaks the run.
    const nihByPmid = new Map<number, NihRow>();
    for (const batch of chunks(distinctPmids, IN_BATCH)) {
      try {
        await withReciterConnection(async (conn) => {
          const rows = (await conn.query(
            `SELECT pmid, relative_citation_ratio, nih_percentile, citation_count
             FROM analysis_nih
             WHERE pmid IN (?)`,
            [batch],
          )) as NihRow[];
          for (const n of rows) nihByPmid.set(Number(n.pmid), n);
        });
      } catch (err) {
        console.warn(
          `analysis_nih fetch failed for a batch (continuing without RCR for it): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    console.log(`Got ${nihByPmid.size} NIH iCite rows.`);

    // The best-effort per-batch catch above means a dead or emptied
    // analysis_nih arrives here as a near-empty map — which would null
    // RCR / nihPercentile / citedByCount corpus-wide. Guard on volume.
    assertSourceVolume("reciter:nih-bibliometrics", {
      incoming: nihByPmid.size,
      existing: await db.write.publication.count({
        where: { relativeCitationRatio: { not: null } },
      }),
      maxDropPct: 30,
    });

    // Issue #89 — full author list for the Word bibliography. We pull
    // structured per-rank rows from analysis_summary_author_list (which
    // has full first names like "Gregory A") so we can derive proper
    // PubMed initials ("GA") rather than relying on the truncated
    // single-letter form in analysis_summary_author_all.
    const authorRowsByPmid = new Map<number, AuthorListRow[]>();
    for (const batch of chunks(distinctPmids, IN_BATCH)) {
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT pmid, rank, authorLastName, authorFirstName, personIdentifier
             FROM analysis_summary_author_list
            WHERE pmid IN (?)`,
          [batch],
        )) as AuthorListRow[];
        for (const r of rows) {
          const key = Number(r.pmid);
          const list = authorRowsByPmid.get(key) ?? [];
          list.push(r);
          authorRowsByPmid.set(key, list);
        }
      });
    }
    // Issue #132 — analysis_summary_author only carries a categorical
    // authorPosition ('first' / 'last' / 'penultimate' / NULL), so middle
    // authors all collapse to position=0 and chip rows can't be ordered by
    // PubMed rank. analysis_summary_author_list carries the real numeric
    // rank (1..N) plus personIdentifier for matched WCM authors, so we
    // build a (pmid, cwid) → rank map and a totalAuthors-per-pmid count
    // to drive PublicationAuthor.position downstream.
    const rankByPmidCwid = new Map<string, number>();
    const totalAuthorsByPmidFromList = new Map<number, number>();
    for (const [pmid, rows] of authorRowsByPmid) {
      totalAuthorsByPmidFromList.set(pmid, rows.length);
      for (const r of rows) {
        const cwid = (r.personIdentifier ?? "").trim();
        if (!cwid) continue;
        const key = `${pmid}|${cwid}`;
        const prior = rankByPmidCwid.get(key);
        if (prior === undefined || (typeof r.rank === "number" && r.rank < prior)) {
          rankByPmidCwid.set(key, r.rank);
        }
      }
    }
    const fullAuthorsByPmid = new Map<number, string>();
    for (const [pmid, rows] of authorRowsByPmid) {
      const composed = composeAuthorString(rows);
      if (composed) fullAuthorsByPmid.set(pmid, composed);
    }
    console.log(`Got ${fullAuthorsByPmid.size} full-author strings.`);

    // An empty analysis_summary_author_list would null fullAuthorsString everywhere.
    assertSourceVolume("reciter:full-author-lists", {
      incoming: fullAuthorsByPmid.size,
      existing: await db.write.publication.count({
        where: { fullAuthorsString: { not: null } },
      }),
      maxDropPct: 30,
    });

    // Issue #89 — NLM journal abbreviation. person_article carries the
    // ISO abbreviation per pmid (despite the name, it's the NLM-style
    // form: "Proc Natl Acad Sci U S A"). Distinct per pmid; pick first
    // non-null sighting.
    const journalAbbrevByPmid = new Map<number, string>();
    for (const batch of chunks(distinctPmids, IN_BATCH)) {
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT DISTINCT pmid, journalTitleISOabbreviation
             FROM person_article
            WHERE pmid IN (?) AND journalTitleISOabbreviation IS NOT NULL
                  AND journalTitleISOabbreviation <> ''`,
          [batch],
        )) as JournalAbbrevRow[];
        for (const r of rows) {
          const key = Number(r.pmid);
          if (journalAbbrevByPmid.has(key)) continue;
          if (r.journalTitleISOabbreviation) {
            journalAbbrevByPmid.set(key, r.journalTitleISOabbreviation);
          }
        }
      });
    }
    console.log(`Got ${journalAbbrevByPmid.size} journal abbreviations.`);

    // An empty person_article would null journalAbbrev everywhere.
    assertSourceVolume("reciter:journal-abbrevs", {
      incoming: journalAbbrevByPmid.size,
      existing: await db.write.publication.count({ where: { journalAbbrev: { not: null } } }),
      maxDropPct: 30,
    });

    // Issue #73 — pull MeSH keywords for the same pmid set so the profile
    // loader can derive the Topics section without a runtime join. Keywords
    // are per-PMID, not per-(person, pmid) — verified that all persons
    // sharing a pmid have identical keyword sets — so we drop the
    // personIdentifier dimension here. Join `mesh.Label` to attach the
    // descriptor UI; ~1 in 1000 labels don't resolve and are stored with
    // ui = null.
    const keywordsByPmid = new Map<number, MeshKeyword[]>();
    for (const batch of chunks(distinctPmids, IN_BATCH)) {
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT DISTINCT k.pmid, k.keyword, m.DescriptorUI AS ui
             FROM person_article_keyword k
             LEFT JOIN mesh m ON m.Label = k.keyword
            WHERE k.pmid IN (?)`,
          [batch],
        )) as KeywordRow[];
        for (const r of rows) {
          const key = Number(r.pmid);
          const list = keywordsByPmid.get(key) ?? [];
          list.push({ ui: r.ui ?? null, label: r.keyword });
          keywordsByPmid.set(key, list);
        }
      });
    }
    console.log(`Got keywords for ${keywordsByPmid.size} pmids.`);

    // An empty person_article_keyword would wipe meshTerms (→ DbNull) everywhere.
    assertSourceVolume("reciter:mesh-keywords", {
      incoming: keywordsByPmid.size,
      existing: await db.write.publication.count({
        where: { meshTerms: { not: Prisma.AnyNull } },
      }),
      maxDropPct: 30,
    });

    // First-seen authors string per pmid (denormalized, same per row).
    const authorsStringByPmid = new Map<number, string>();
    for (const r of authorRows) {
      const key = Number(r.pmid);
      if (!authorsStringByPmid.has(key) && r.authors) {
        authorsStringByPmid.set(key, r.authors);
      }
    }

    // 4. Build the source publication set. Issue #247: we no longer wipe the
    //    publication table — that cascaded into publication_topic (owned by
    //    the ReCiterAI-projection ETL). PublicationScore is still safe to wipe
    //    because nothing FKs to it.
    console.log("Wiping publication_score (no inbound FK)...");
    await db.write.publicationScore.deleteMany();

    const pubRows = Array.from(articleByPmid.values()).map((a) => {
      const authorsString = authorsStringByPmid.get(Number(a.pmid)) ?? null;
      const nih = nihByPmid.get(Number(a.pmid));
      return {
        pmid: String(a.pmid),
        title: a.articleTitle ?? `(untitled, pmid ${a.pmid})`,
        authorsString,
        fullAuthorsString: fullAuthorsByPmid.get(Number(a.pmid)) ?? null,
        journal: a.journalTitleVerbose,
        year: a.articleYear,
        publicationType: a.publicationTypeCanonical,
        citationCount: a.citationCountScopus ?? 0,
        // #917 v6 — NIH iCite bibliometrics for the biosketch impact grounding (null when the
        // pmid has no analysis_nih row yet). Spread into the upsert with the rest of pubRows.
        relativeCitationRatio: nih?.relative_citation_ratio ?? null,
        nihPercentile: nih?.nih_percentile ?? null,
        citedByCount: nih?.citation_count ?? null,
        dateAddedToEntrez: parseDate(a.datePublicationAddedToEntrez),
        doi: a.doi,
        pmcid: a.pmcid,
        volume: a.volume,
        issue: a.issue,
        pages: a.pages,
        journalAbbrev: journalAbbrevByPmid.get(Number(a.pmid)) ?? null,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`,
        abstract: abstractByPmid.get(Number(a.pmid)) ?? null,
        meshTerms: keywordsByPmid.get(Number(a.pmid)) ?? Prisma.DbNull,
        source: "ReciterDB",
      };
    });
    const sourcePmids = pubRows.map((p) => p.pmid);
    const sourcePmidsSet = new Set(sourcePmids);

    // 5. Upsert publications keyed on pmid. Parallel-chunk pattern mirrors
    //    etl/dynamodb/index.ts:300-336.
    console.log(`Upserting ${pubRows.length} publications (change-detection)...`);
    // The reciter-written fields only — the same set publicationSignature reads.
    // `synopsis` / `impact*` / `topTopicId` are owned by other ETLs; excluding
    // them keeps this comparison from ever thinking another ETL's write is a
    // reciter change (and vice versa).
    const PUB_SELECT = {
      pmid: true,
      title: true,
      authorsString: true,
      fullAuthorsString: true,
      journal: true,
      year: true,
      publicationType: true,
      citationCount: true,
      relativeCitationRatio: true,
      nihPercentile: true,
      citedByCount: true,
      dateAddedToEntrez: true,
      doi: true,
      pmcid: true,
      volume: true,
      issue: true,
      pages: true,
      journalAbbrev: true,
      pubmedUrl: true,
      abstract: true,
      meshTerms: true,
      source: true,
    } as const;
    let pubCreated = 0;
    let pubUpdated = 0;
    let pubUnchanged = 0;
    for (const batch of chunks(pubRows, INSERT_BATCH)) {
      const existingRows = await db.write.publication.findMany({
        where: { pmid: { in: batch.map((p) => p.pmid) } },
        select: PUB_SELECT,
      });
      const existingSig = new Map(
        existingRows.map((r) => [r.pmid, publicationSignature(r)]),
      );
      // Only new / content-changed rows are written (and their lastRefreshedAt
      // bumped); an unchanged row is skipped so the corpus isn't rewritten
      // wholesale every night (100k+ full-row upserts incl. 15KB abstracts).
      const changed = batch.filter((p) => {
        const prev = existingSig.get(p.pmid);
        if (prev === undefined) {
          pubCreated += 1;
          return true;
        }
        if (prev !== publicationSignature(p)) {
          pubUpdated += 1;
          return true;
        }
        pubUnchanged += 1;
        return false;
      });
      await Promise.all(
        changed.map((p) => {
          const { pmid, ...rest } = p;
          return db.write.publication.upsert({
            where: { pmid },
            create: { pmid, ...rest, lastRefreshedAt: new Date() },
            update: { ...rest, lastRefreshedAt: new Date() },
          });
        }),
      );
    }
    console.log(
      `publications: ${pubCreated} created, ${pubUpdated} updated, ` +
        `${pubUnchanged} unchanged (skipped).`,
    );

    // 6. Reconcile PublicationAuthor rows by (pmid, cwid) instead of wiping and
    //    reinserting the whole corpus every night. The old wipe re-stamped
    //    lastRefreshedAt (@default(now())) on EVERY row, which defeated
    //    etl/coi-gap's incremental watermark (it selects
    //    publicationAuthor.lastRefreshedAt > watermark, so every run became a
    //    full-cohort recompute). Keyed reconcile touches only real deltas —
    //    create new authorships, update changed ones (+bump lastRefreshedAt),
    //    delete stale ones — and LEAVES unchanged rows untouched so their
    //    timestamp is preserved. Per-pmid-batch transactions keep each
    //    publication's author set atomically consistent (no author-less window)
    //    without holding one multi-minute corpus-wide transaction. (Supersedes
    //    #1511c's single-transaction wipe+reinsert, which fixed atomicity but
    //    still re-stamped every row.)
    const authorshipRows = buildAuthorshipRows(
      authorRows,
      ourCwidSet,
      rankByPmidCwid,
      totalAuthorsByPmidFromList,
    );
    const incomingByPmid = new Map<string, IncomingAuthorship[]>();
    for (const r of authorshipRows) {
      const arr = incomingByPmid.get(r.pmid) ?? [];
      arr.push(r);
      incomingByPmid.set(r.pmid, arr);
    }
    console.log(
      `Reconciling WCM authorships for ${sourcePmids.length} source PMIDs ` +
        `(${authorshipRows.length} incoming)...`,
    );
    let authCreated = 0;
    let authUpdated = 0;
    let authDeleted = 0;
    let authUnchanged = 0;
    for (const batch of chunks(sourcePmids, IN_BATCH)) {
      const existing = await db.write.publicationAuthor.findMany({
        where: { pmid: { in: batch } },
        select: {
          id: true,
          pmid: true,
          cwid: true,
          position: true,
          totalAuthors: true,
          isFirst: true,
          isLast: true,
          isPenultimate: true,
          isConfirmed: true,
        },
      });
      const incoming = batch.flatMap((pmid) => incomingByPmid.get(pmid) ?? []);
      const plan = planAuthorshipReconcile(existing, incoming);
      authUnchanged += plan.unchanged;
      if (
        plan.toCreate.length === 0 &&
        plan.toUpdate.length === 0 &&
        plan.toDeleteIds.length === 0
      ) {
        continue; // steady-state batch — no writes, timestamps preserved
      }
      await db.write.$transaction(
        async (tx) => {
          for (const idBatch of chunks(plan.toDeleteIds, IN_BATCH)) {
            await tx.publicationAuthor.deleteMany({ where: { id: { in: idBatch } } });
          }
          if (plan.toCreate.length > 0) {
            await tx.publicationAuthor.createMany({
              data: plan.toCreate.map((r) => ({
                pmid: r.pmid,
                cwid: r.cwid,
                position: r.position,
                totalAuthors: r.totalAuthors,
                isFirst: r.isFirst,
                isLast: r.isLast,
                isPenultimate: r.isPenultimate,
                isConfirmed: r.isConfirmed,
              })),
            });
          }
          for (const u of plan.toUpdate) {
            await tx.publicationAuthor.update({
              where: { id: u.id },
              data: {
                position: u.row.position,
                totalAuthors: u.row.totalAuthors,
                isFirst: u.row.isFirst,
                isLast: u.row.isLast,
                isPenultimate: u.row.isPenultimate,
                isConfirmed: u.row.isConfirmed,
                lastRefreshedAt: new Date(),
              },
            });
          }
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      authCreated += plan.toCreate.length;
      authUpdated += plan.toUpdate.length;
      authDeleted += plan.toDeleteIds.length;
    }
    console.log(
      `WCM authorships: ${authCreated} created, ${authUpdated} updated, ` +
        `${authDeleted} deleted, ${authUnchanged} unchanged.`,
    );

    // 7. Orphan cleanup — delete publications whose pmid is no longer in the
    //    ReCiter source. Cascade to publication_topic / publication_author /
    //    grant_publication / publication_score IS intentional for these rows:
    //    a genuinely-removed PMID should not leave dangling projections.
    console.log("Computing orphan publications (in DB but not in ReCiter source)...");
    const existingPmids = (
      await db.write.publication.findMany({ select: { pmid: true } })
    ).map((p) => p.pmid);
    const orphanPmids = existingPmids.filter((pmid) => !sourcePmidsSet.has(pmid));
    // Orphan churn is normally a trickle (retractions, disambiguation fixes).
    // A large orphan set means the source read was truncated — deleting would
    // cascade into publication_topic / publication_author / grant_publication.
    assertPruneVolume("reciter:orphan-prune", {
      pruning: orphanPmids.length,
      of: existingPmids.length,
      maxPct: 5,
    });
    if (orphanPmids.length > 0) {
      console.log(
        `Deleting ${orphanPmids.length} orphan publication(s) ` +
          `(cascade fires for publication_topic / publication_author / grant_publication / publication_score)...`,
      );
      let orphanDeleted = 0;
      for (const batch of chunks(orphanPmids, IN_BATCH)) {
        await db.write.publication.deleteMany({ where: { pmid: { in: batch } } });
        orphanDeleted += batch.length;
      }
      console.log(`  ...deleted ${orphanDeleted} orphan publications.`);
    } else {
      console.log("No orphan publications.");
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: pubRows.length + authorshipRows.length,
      },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `ReciterDB ETL complete in ${elapsed}s: publications=${pubRows.length}, authorships=${authorshipRows.length}`,
    );
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// Run the ETL only when this file is executed as a script — never when it is
// imported (a unit test importing `buildAuthorshipRows` / `INGESTION_SCHOLAR_WHERE`
// must not trigger a full ReciterDB sync inside the vitest worker). Mirrors the
// guard in `etl/ed/index.ts` and `etl/search-index/index.ts`.
if (!process.env.VITEST) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
      await closeReciterPool();
    });
}
