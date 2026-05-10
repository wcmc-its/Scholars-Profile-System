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
 *   4. Wipe existing publication / publication_author / publication_score
 *      rows in a transaction
 *   5. Insert publications and WCM-author rows in bulk (Prisma createMany)
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
import { prisma } from "../../lib/db";
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

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: { source: "ReCiter", status: "running" },
  });

  try {
    // 1. Active scholar CWIDs from our DB
    console.log("Loading active CWIDs from local DB...");
    const ourScholars = await prisma.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));
    const cwidList = Array.from(ourCwidSet);
    console.log(`Querying ReciterDB for ${cwidList.length} active CWIDs...`);

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

    // First-seen authors string per pmid (denormalized, same per row).
    const authorsStringByPmid = new Map<number, string>();
    for (const r of authorRows) {
      const key = Number(r.pmid);
      if (!authorsStringByPmid.has(key) && r.authors) {
        authorsStringByPmid.set(key, r.authors);
      }
    }

    // 4. Reset existing publications data
    console.log("Resetting publication / publication_author / publication_score tables...");
    await prisma.publicationScore.deleteMany();
    await prisma.publicationAuthor.deleteMany();
    await prisma.publication.deleteMany();

    // 5. Bulk insert Publication rows
    const pubRows = Array.from(articleByPmid.values()).map((a) => {
      const authorsString = authorsStringByPmid.get(Number(a.pmid)) ?? null;
      return {
        pmid: String(a.pmid),
        title: a.articleTitle ?? `(untitled, pmid ${a.pmid})`,
        authorsString,
        fullAuthorsString: fullAuthorsByPmid.get(Number(a.pmid)) ?? null,
        journal: a.journalTitleVerbose,
        year: a.articleYear,
        publicationType: a.publicationTypeCanonical,
        citationCount: a.citationCountScopus ?? 0,
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

    console.log(`Inserting ${pubRows.length} publications...`);
    let inserted = 0;
    for (const batch of chunks(pubRows, INSERT_BATCH)) {
      await prisma.publication.createMany({ data: batch, skipDuplicates: true });
      inserted += batch.length;
      if (inserted % (INSERT_BATCH * 10) === 0) {
        console.log(`  ...${inserted}/${pubRows.length}`);
      }
    }

    // 6. Bulk insert PublicationAuthor rows for WCM authorships
    const authorshipRows: Array<{
      pmid: string;
      cwid: string;
      position: number;
      totalAuthors: number;
      isFirst: boolean;
      isLast: boolean;
      isPenultimate: boolean;
      isConfirmed: boolean;
    }> = [];

    for (const r of authorRows) {
      const cwid = r.personIdentifier;
      // Skip authorships whose CWID isn't an active scholar in our DB.
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

    console.log(`Inserting ${authorshipRows.length} WCM authorship rows...`);
    let authInserted = 0;
    for (const batch of chunks(authorshipRows, INSERT_BATCH)) {
      await prisma.publicationAuthor.createMany({ data: batch, skipDuplicates: true });
      authInserted += batch.length;
      if (authInserted % (INSERT_BATCH * 20) === 0) {
        console.log(`  ...${authInserted}/${authorshipRows.length}`);
      }
    }

    await prisma.etlRun.update({
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
    await prisma.etlRun.update({
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

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await closeReciterPool();
  });
