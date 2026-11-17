/**
 * Research security ETL — reciterdb's watch-list screen → the four
 * `research_security_*` tables behind `/edit/research-security`.
 *
 *   reciterdb.watchlist_match + watchlist_funding_flag   (rebuilt nightly by
 *     ReCiterDB update/collectAffiliations.py; EVERY stored article)
 *   ⨝ current authorship: analysis_summary_author (confirmed), person_article
 *     with an empty/PENDING assertion (pending), authorship_review status
 *     'open' (review queue)
 *   → research_security_article / _person / _match / _funding_flag
 *
 * Only articles with a match or funding flag AND one of our people attached
 * are copied. Person rows are denormalized, so a Cornell (Ithaca) person needs
 * no `scholar` row. Non-PubMed articles are joined on `article_id`, never the
 * nightly-renumbered negative pmid. The rules live in `./build.ts`.
 *
 * Full replace in ONE transaction, so a reader never sees an empty or
 * half-loaded set. An empty or implausibly small source (the reciterdb match
 * tables mid-rebuild, or never loaded) throws BEFORE the replace: yesterday's
 * copy stays and the step fails.
 *
 * Writes only when RESEARCH_SECURITY_ETL is exactly "on"; otherwise it reads
 * nothing and logs that it was skipped. The rows are sensitive and per-person:
 * this script logs counts only, never a name, an id or an affiliation string.
 *
 * Usage: `npm run etl:research-security`
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import {
  EXTERNAL_COHORT_SQL,
  assertPlausibleSource,
  attachPeople,
  buildArticles,
  ci,
  ithacaCwids,
  joinCwids,
  nameKeysByCwid,
  ourAuthorCwids,
  type AcceptedRow,
  type ArticleFact,
  type PendingRow,
  type PersonFact,
  type ReviewRow,
} from "./build";

const READ_BATCH = 1000;
const INSERT_BATCH = 1000;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type MatchRow = {
  articleId: string;
  listCode: string;
  category: string;
  listNo: number | null;
  entity: string;
  authorRank: number;
  authorName: string | null;
  affiliation: string | null;
  isInstitutionAuthor: number | boolean;
};
type FlagRow = { articleId: string; program: string; agency: string | null; grantId: string | null };

const ARTICLE_FACT_COLUMNS = `
  pmid, article_id AS articleId, articleTitle AS title, journalTitleVerbose AS journal,
  COALESCE(CAST(pubDate AS CHAR), publicationDateStandardized) AS publicationDate,
  publicationTypeCanonical AS publicationType, doi`;

async function main(): Promise<number> {
  if (process.env.RESEARCH_SECURITY_ETL !== "on") {
    console.log('research-security: SKIPPED (RESEARCH_SECURITY_ETL is not "on"); nothing read or written.');
    return 0;
  }
  const now = new Date();

  const source = await withReciterConnection(async (conn) => {
    const matches = (await conn.query(`
      SELECT article_id AS articleId, list_code AS listCode, category, list_no AS listNo, entity,
             \`rank\` AS authorRank, author_name AS authorName, affiliation,
             is_institution_author AS isInstitutionAuthor
        FROM watchlist_match`)) as MatchRow[];
    const flags = (await conn.query(`
      SELECT article_id AS articleId, program, agency, grant_id AS grantId
        FROM watchlist_funding_flag`)) as FlagRow[];
    const accepted = (await conn.query(
      `SELECT a.personIdentifier AS cwid, r.pmid, r.article_id AS articleId, r.doi
         FROM analysis_summary_author a
         JOIN analysis_summary_article r ON r.pmid = a.pmid
        WHERE a.personIdentifier NOT REGEXP ?`,
      [EXTERNAL_COHORT_SQL],
    )) as AcceptedRow[];
    const pending = (await conn.query(
      `SELECT personIdentifier AS cwid, pmid, doi, userAssertion,
              authorshipLikelihoodScore AS score
         FROM person_article
        WHERE COALESCE(userAssertion, '') IN ('', 'PENDING') AND pmid > 0
          AND personIdentifier NOT REGEXP ?`,
      [EXTERNAL_COHORT_SQL],
    )) as PendingRow[];
    const review = (await conn.query(
      `SELECT top_cwid AS cwid, pmid, doi, source, external_id AS externalId, status,
              top_fg_score AS score, wcm_author AS author, author_affiliation AS affiliation,
              title, journal, pub_type AS pubType, entrez_date AS entrezDate
         FROM authorship_review
        WHERE status = 'open' AND (top_cwid IS NULL OR top_cwid NOT REGEXP ?)`,
      [EXTERNAL_COHORT_SQL],
    )) as ReviewRow[];
    const persons = (await conn.query(
      `SELECT personIdentifier AS cwid, firstName, lastName, title,
              primaryOrganizationalUnit AS department
         FROM person`,
    )) as PersonFact[];
    // The publishing name, which can differ from `person`'s HR legal name:
    // reciterdb's is_institution_author is computed from both.
    const identities = (await conn.query(
      `SELECT cwid, givenName AS first, surname AS last FROM identity`,
    )) as Array<{ cwid: string | null; first: string | null; last: string | null }>;
    // The collation makes this comparison case- and pad-insensitive; the exact
    // rule is applied to the returned rows by `ithacaCwids`.
    const personTypes = (await conn.query(
      `SELECT personIdentifier AS cwid, personType FROM person_person_type
        WHERE personType = 'cornell-ithaca'`,
    )) as Array<{ cwid: string | null; personType: string | null }>;
    return { matches, flags, accepted, pending, review, persons, identities, personTypes };
  });
  console.log(
    `research-security: read ${source.matches.length} match rows, ${source.flags.length} funding flags, ` +
      `${source.accepted.length} confirmed, ${source.pending.length} pending, ${source.review.length} review-queue rows.`,
  );

  const persons = new Map<string, PersonFact>();
  // `person` can hold a cwid twice; the first row wins.
  for (const p of source.persons) {
    const k = p.cwid?.trim().toLowerCase();
    if (k && !persons.has(k)) persons.set(k, p);
  }
  const ithaca = ithacaCwids(source.personTypes);
  // Every `person` row, not only the first per cwid, plus `identity`.
  const names = nameKeysByCwid([
    ...source.persons.map((p) => ({ cwid: p.cwid, first: p.firstName, last: p.lastName })),
    ...source.identities,
  ]);

  const { people, reviewFacts } = attachPeople({
    flaggedIds: [...source.matches.map((m) => m.articleId), ...source.flags.map((f) => f.articleId)],
    accepted: source.accepted,
    pending: source.pending,
    review: source.review,
    persons,
    ithaca,
    names,
  });
  const keep = new Set(people.map((p) => p.articleId));
  const cwidsOn = new Map<string, string[]>();
  for (const p of people) {
    if (p.cwid) cwidsOn.set(p.articleId, [...(cwidsOn.get(p.articleId) ?? []), p.cwid]);
  }

  // Article facts and author counts for the kept articles only.
  const facts = new Map<string, ArticleFact>();
  const nAuthors = new Map<string, number>();
  const pmids = [...keep].filter((id) => /^\d+$/.test(id)).map(Number);
  const others = [...keep].filter((id) => !/^\d+$/.test(id));
  await withReciterConnection(async (conn) => {
    const put = (rows: ArticleFact[], key: (r: ArticleFact) => string | null) => {
      for (const r of rows) {
        const k = key(r);
        if (k && !facts.has(ci(k))) facts.set(ci(k), r);
      }
    };
    for (const batch of chunks(pmids, READ_BATCH)) {
      put(
        (await conn.query(
          `SELECT ${ARTICLE_FACT_COLUMNS} FROM analysis_summary_article WHERE pmid IN (?)`,
          [batch],
        )) as ArticleFact[],
        (r) => String(r.pmid),
      );
    }
    for (const batch of chunks(others, READ_BATCH)) {
      put(
        (await conn.query(
          `SELECT ${ARTICLE_FACT_COLUMNS} FROM analysis_summary_article WHERE article_id IN (?)`,
          [batch],
        )) as ArticleFact[],
        (r) => r.articleId,
      );
    }
    // A paper nobody is confirmed on yet has no analysis_summary_article row.
    const pendingOnly = pmids.filter((p) => !facts.has(String(p)));
    for (const batch of chunks(pendingOnly, READ_BATCH)) {
      put(
        (await conn.query(
          `SELECT pmid, NULL AS articleId, MAX(articleTitle) AS title,
                  MAX(journalTitleVerbose) AS journal,
                  MAX(publicationDateStandardized) AS publicationDate,
                  MAX(publicationTypeCanonical) AS publicationType, MAX(doi) AS doi
             FROM person_article WHERE pmid IN (?) GROUP BY pmid`,
          [batch],
        )) as ArticleFact[],
        (r) => String(r.pmid),
      );
    }
    for (const batch of chunks([...keep], READ_BATCH)) {
      const rows = (await conn.query(
        `SELECT article_id AS articleId, n_authors AS n FROM article_affiliation_state
          WHERE article_id IN (?)`,
        [batch],
      )) as Array<{ articleId: string; n: number }>;
      for (const r of rows) nAuthors.set(ci(r.articleId), Number(r.n) || 0);
    }
  });

  const articles = buildArticles(keep, facts, reviewFacts, nAuthors, now);
  const keepCi = new Map([...keep].map((id) => [ci(id), id]));
  const matches = source.matches.flatMap((m) => {
    const articleId = keepCi.get(ci(m.articleId));
    if (!articleId) return [];
    const isInstitutionAuthor = !!m.isInstitutionAuthor;
    return [
      {
        ...m,
        articleId,
        authorName: m.authorName?.slice(0, 255) ?? null,
        isInstitutionAuthor,
        // WHICH of the attached people the name is; reciterdb's bit says only
        // that it is one of the people in scope.
        ourAuthorCwids: isInstitutionAuthor
          ? joinCwids(ourAuthorCwids(m.authorName, cwidsOn.get(articleId) ?? [], names))
          : null,
      },
    ];
  });
  const flags = source.flags.flatMap((f) => {
    const articleId = keepCi.get(ci(f.articleId));
    return articleId ? [{ ...f, articleId }] : [];
  });

  // Throws before anything is written: yesterday's copy stays.
  assertPlausibleSource({
    sourceMatchRows: source.matches.length,
    builtArticles: articles.length,
    existingArticles: await db.write.researchSecurityArticle.count(),
  });

  await db.write.$transaction(
    async (tx) => {
      // Children cascade from the article rows.
      await tx.researchSecurityArticle.deleteMany({});
      for (const b of chunks(articles, INSERT_BATCH)) await tx.researchSecurityArticle.createMany({ data: b });
      for (const b of chunks(people, INSERT_BATCH)) await tx.researchSecurityPerson.createMany({ data: b });
      for (const b of chunks(matches, INSERT_BATCH)) await tx.researchSecurityMatch.createMany({ data: b });
      for (const b of chunks(flags, INSERT_BATCH))
        await tx.researchSecurityFundingFlag.createMany({ data: b, skipDuplicates: true });
    },
    { timeout: 600_000, maxWait: 10_000 },
  );

  console.log(
    `research-security: wrote ${articles.length} articles, ${people.length} people rows, ` +
      `${matches.length} match rows, ${flags.length} funding flags.`,
  );
  return articles.length;
}

// db.write.$disconnect() in .finally, not main(): withEtlRun writes its
// success/failure row after main() returns (see etl/data-sharing/index.ts).
if (!process.env.VITEST) {
  withEtlRun("Research-Security", main)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeReciterPool();
      await db.write.$disconnect();
    });
}
