/**
 * Policy-citations ETL: which clinical guidelines, consensus statements,
 * systematic reviews and health-authority documents cite our publications.
 *
 * Two passes, then a rollup:
 *
 *   1. PubMed. Harvest the PubMed IDs typed as a guideline, a consensus
 *      statement, or a systematic review / meta-analysis, then keep the iCite
 *      citation links (`reciterdb.analysis_nih_cites`, the full citing list for
 *      every paper we hold) whose citing paper is in one of those sets.
 *   2. NCBI Bookshelf. Ask which books cite each paper, and keep those issued
 *      by a listed health authority (lib/citations/issuing-bodies.ts). This
 *      lookup runs at about 30 ms a paper (three calls in flight), so a whole
 *      pass takes about 100 minutes. The budget covers a whole pass, so a new
 *      authority citation shows up within a week. If the pass is cut short it
 *      resumes next run: never-checked papers first, then the oldest checks.
 *   3. Recompute `publication.authority_bodies / guideline_count / review_count`.
 *
 * Writes only ever add: a document or link is inserted if new and left alone
 * otherwise, so `first_seen_at` is the date we first saw a citation and a
 * short read from a source can drop nothing. Every NCBI call returns a whole
 * answer or throws (ncbi.ts).
 *
 * // ponytail: nothing is ever removed. A citation that later disappears at the
 * // source (a corrected reference list, a retyped paper) stays. Add a prune
 * // behind assertPruneVolume if that turns out to happen.
 *
 * Env: SCHOLARS_RECITERDB_* (lib/sources/reciterdb.ts), optional NCBI_API_KEY.
 *
 * The weekly machine's duration alarm (cdk/lib/etl-stack.ts, Weekly maxDuration)
 * is sized for BOOKSHELF_BUDGET_MIN. Raise both together.
 *
 * Usage:
 *   npm run etl:policy-citations
 *   npm run etl:policy-citations -- --bookshelf-minutes 230   # first backfill
 *   npm run etl:policy-citations -- --pmids 24928290          # spot check
 *   npm run etl:policy-citations -- --limit 2000              # smoke test
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { Prisma } from "@/lib/generated/prisma/client";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { bookshelfCiters, esummary, harvestPmids } from "./ncbi";
import {
  authorityBodies,
  bookshelfDoc,
  CITATION_FIELDS,
  pubmedDoc,
  pubmedLevel,
  type CitingDoc,
  type PubmedSummary,
} from "./shape";

/** PubMed publication types behind each level. */
const TYPE_TERMS = {
  guideline: "Practice Guideline[pt] OR Guideline[pt]",
  consensus:
    "Consensus Statement[pt] OR Consensus Development Conference[pt] OR Consensus Development Conference, NIH[pt]",
  review: "Systematic Review[pt] OR Meta-Analysis[pt]",
} as const;

const CITED_BATCH = 500;
const SUMMARY_BATCH = 200;
const INSERT_BATCH = 2000;
/** Bookshelf ELink: ids per call, and calls in flight. Larger calls stall. */
const ELINK_BATCH = 100;
const ELINK_CONCURRENCY = 3;
/**
 * Minutes the Bookshelf pass may run; `--bookshelf-minutes` overrides it. A
 * whole pass over 198,694 papers took about 100 minutes (staging, 2026-11-24).
 * // ponytail: keyless NCBI rate. An NCBI_API_KEY would allow three times the
 * // calls in flight and cut the pass to about 35 minutes.
 */
const BOOKSHELF_BUDGET_MIN = 120;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function chunks<T>(a: ReadonlyArray<T>, n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

/** Insert new documents, then return the row id for each external id. */
async function saveDocs(source: CitingDoc["source"], docs: CitingDoc[]): Promise<Map<string, number>> {
  for (const batch of chunks(docs, INSERT_BATCH)) {
    await db.write.citingDocument.createMany({ data: batch, skipDuplicates: true });
  }
  const rows = await db.write.citingDocument.findMany({
    where: { source },
    select: { id: true, externalId: true },
  });
  return new Map(rows.map((r) => [r.externalId, r.id]));
}

/**
 * Fill the citation fields on rows saved before those fields existed. Only the
 * citation fields are written: level, title and the dedup key stay as they are.
 */
async function backfillCitations(docs: CitingDoc[]): Promise<void> {
  for (const batch of chunks(docs, 100)) {
    await db.write.$transaction(
      batch.map((d) =>
        db.write.citingDocument.update({
          where: { source_externalId: { source: d.source, externalId: d.externalId } },
          data: Object.fromEntries(CITATION_FIELDS.map((f) => [f, d[f]])),
        }),
      ),
    );
  }
}

async function saveLinks(links: Array<{ pmid: string; citingDocumentId: number }>): Promise<number> {
  let added = 0;
  for (const batch of chunks(links, INSERT_BATCH)) {
    added += (await db.write.publicationCitingDocument.createMany({ data: batch, skipDuplicates: true }))
      .count;
  }
  return added;
}

/** Pass 1: PubMed-indexed guidelines, consensus statements and reviews. */
async function pubmedPass(pmids: string[], partial: boolean): Promise<number> {
  const from = new Date(Date.UTC(1900, 0, 1));
  const to = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 11, 31));
  const sets = {
    guideline: await harvestPmids(TYPE_TERMS.guideline, from, to),
    consensus: await harvestPmids(TYPE_TERMS.consensus, from, to),
    review: await harvestPmids(TYPE_TERMS.review, from, to),
  };
  console.log(
    `PubMed sets: ${sets.guideline.size} guidelines, ${sets.consensus.size} consensus statements, ` +
      `${sets.review.size} systematic reviews.`,
  );

  // [cited, citing] for every link whose citing paper is in one of the sets.
  const links: Array<[number, number]> = [];
  let scanned = 0;
  for (const batch of chunks(pmids, CITED_BATCH)) {
    const rows = await withReciterConnection(
      (conn) =>
        conn.query(
          {
            sql: `SELECT DISTINCT cited_pmid, citing_pmid FROM analysis_nih_cites
                   WHERE cited_pmid IN (${batch.map(() => "?").join(",")})`,
            rowsAsArray: true,
          },
          batch.map(Number),
        ) as Promise<Array<[number, number]>>,
    );
    scanned += rows.length;
    for (const r of rows) if (pubmedLevel(r[1], sets)) links.push([r[0], r[1]]);
  }
  console.log(`Scanned ${scanned} citation links; ${links.length} come from a typed document.`);

  if (scanned === 0) throw new Error("analysis_nih_cites returned no citation links for the corpus.");
  if (!partial) {
    assertSourceVolume("policy-citations:pubmed-links", {
      incoming: links.length,
      existing: await db.write.publicationCitingDocument.count({
        where: { citingDocument: { source: "pubmed" } },
      }),
      maxDropPct: 50,
    });
  }

  const existing = new Map(
    (
      await db.write.citingDocument.findMany({
        where: { source: "pubmed" },
        select: { externalId: true, level: true, journalAbbrev: true },
      })
    ).map((d) => [d.externalId, d]),
  );
  const citing = [...new Set(links.map((l) => l[1]))];
  const fresh = citing.filter((p) => !existing.has(String(p)));
  // Rows saved before the citation fields existed. Every PubMed record has a
  // journal abbreviation, so a NULL one means the row was never filled.
  const unfilled = new Set(citing.filter((p) => existing.get(String(p))?.journalAbbrev === null));
  console.log(
    `${citing.length} distinct citing documents, ${fresh.length} new, ${unfilled.size} missing citation fields.`,
  );

  const docs: CitingDoc[] = [];
  const refill: CitingDoc[] = [];
  for (const batch of chunks([...fresh, ...unfilled], SUMMARY_BATCH)) {
    const summaries = await esummary("pubmed", batch);
    for (const p of batch) {
      const s = summaries.get(String(p));
      if (s) (unfilled.has(p) ? refill : docs).push(pubmedDoc(p, pubmedLevel(p, sets)!, s as PubmedSummary));
    }
  }
  await backfillCitations(refill);

  // A paper indexed as a review can later be typed as a guideline.
  for (const level of ["guideline", "consensus", "review"] as const) {
    const retyped = citing
      .filter((p) => pubmedLevel(p, sets) === level && existing.has(String(p)) && existing.get(String(p))!.level !== level)
      .map(String);
    for (const batch of chunks(retyped, INSERT_BATCH)) {
      await db.write.citingDocument.updateMany({
        where: { source: "pubmed", externalId: { in: batch } },
        data: { level },
      });
    }
  }

  const ids = await saveDocs("pubmed", docs);
  const added = await saveLinks(
    links.flatMap(([cited, citingPmid]) => {
      const id = ids.get(String(citingPmid));
      return id ? [{ pmid: String(cited), citingDocumentId: id }] : [];
    }),
  );
  console.log(`PubMed pass: ${docs.length} documents added, ${added} links added.`);
  return added;
}

/** Pass 2: health-authority documents on NCBI Bookshelf, on a time budget. */
async function bookshelfPass(pmids: string[], budgetMin: number): Promise<number> {
  const deadline = Date.now() + budgetMin * 60_000;
  /** Bookshelf record id -> its book, or null when no listed authority issued it. */
  const books = new Map<string, CitingDoc | null>();
  let checked = 0;
  let added = 0;

  for (const group of chunks(pmids, ELINK_BATCH * ELINK_CONCURRENCY)) {
    if (Date.now() >= deadline) break;
    const citers = new Map<string, string[]>();
    for (const part of await Promise.all(chunks(group, ELINK_BATCH).map((b) => bookshelfCiters(b)))) {
      for (const [pmid, uids] of part) citers.set(pmid, uids);
    }

    const unknown = [...new Set([...citers.values()].flat())].filter((u) => !books.has(u));
    for (const batch of chunks(unknown, SUMMARY_BATCH)) {
      const summaries = await esummary("books", batch);
      for (const u of batch) books.set(u, summaries.has(u) ? bookshelfDoc(summaries.get(u)!) : null);
    }

    const docs = new Map<string, CitingDoc>();
    const pairs = new Set<string>();
    for (const [pmid, uids] of citers) {
      for (const u of uids) {
        const doc = books.get(u);
        if (!doc) continue;
        docs.set(doc.externalId, doc);
        pairs.add(`${pmid}|${doc.externalId}`);
      }
    }
    if (docs.size > 0) {
      const ids = await saveDocs("bookshelf", [...docs.values()]);
      const unfilled = await db.write.citingDocument.findMany({
        where: { source: "bookshelf", externalId: { in: [...docs.keys()] }, publisher: null },
        select: { externalId: true },
      });
      await backfillCitations(unfilled.map((r) => docs.get(r.externalId)!));
      added += await saveLinks(
        [...pairs].map((p) => {
          const [pmid, accession] = p.split("|");
          return { pmid, citingDocumentId: ids.get(accession)! };
        }),
      );
    }
    await db.write.publication.updateMany({
      where: { pmid: { in: group } },
      data: { bookshelfCheckedAt: new Date() },
    });
    checked += group.length;
    if (checked % 6000 === 0) console.log(`  ...Bookshelf: ${checked}/${pmids.length} papers checked`);
  }
  console.log(
    `Bookshelf pass: ${checked} of ${pmids.length} papers checked in the ${budgetMin}-minute budget, ` +
      `${added} links added.`,
  );
  return added;
}

/** Step 3: recompute the three rollup columns from the link tables. */
async function rollup(): Promise<void> {
  // Only rows whose counts changed are written.
  const counts = await db.write.$executeRaw`
    UPDATE publication p
      LEFT JOIN (
        SELECT l.pmid,
               COUNT(DISTINCT CASE WHEN d.level = 'guideline' THEN d.dedup_key END) AS g,
               COUNT(DISTINCT CASE WHEN d.level = 'review' THEN d.dedup_key END) AS r
          FROM publication_citing_document l
          JOIN citing_document d ON d.id = l.citing_document_id
         GROUP BY l.pmid
      ) x ON x.pmid = p.pmid
       SET p.guideline_count = COALESCE(x.g, 0), p.review_count = COALESCE(x.r, 0)
     WHERE p.guideline_count <> COALESCE(x.g, 0) OR p.review_count <> COALESCE(x.r, 0)`;

  const authority = await db.write.publicationCitingDocument.findMany({
    where: { citingDocument: { level: "authority" } },
    select: { pmid: true, citingDocument: { select: { issuingBody: true, dedupKey: true } } },
  });
  const byPmid = new Map<string, Map<string, string>>(); // pmid -> dedupKey -> body
  for (const a of authority) {
    const m = byPmid.get(a.pmid) ?? new Map<string, string>();
    m.set(a.citingDocument.dedupKey, a.citingDocument.issuingBody ?? "");
    byPmid.set(a.pmid, m);
  }
  const current = new Map(
    (
      await db.write.publication.findMany({
        where: { OR: [{ pmid: { in: [...byPmid.keys()] } }, { authorityBodies: { not: Prisma.DbNull } }] },
        select: { pmid: true, authorityBodies: true },
      })
    ).map((p) => [p.pmid, JSON.stringify(p.authorityBodies)]),
  );
  let bodies = 0;
  for (const [pmid, was] of current) {
    const now = byPmid.has(pmid) ? authorityBodies([...byPmid.get(pmid)!.values()]) : null;
    if (JSON.stringify(now) === was) continue;
    await db.write.publication.updateMany({
      where: { pmid },
      data: { authorityBodies: now ?? Prisma.DbNull },
    });
    bodies++;
  }
  console.log(`Rollup: ${counts} publications' counts and ${bodies} publications' authority bodies updated.`);
}

async function main(): Promise<number> {
  const start = Date.now();
  const only = arg("--pmids")?.split(",").filter(Boolean);
  const limit = Number(arg("--limit")) || undefined;
  const budgetMin = Number(arg("--bookshelf-minutes")) || BOOKSHELF_BUDGET_MIN;

  try {
    // MySQL sorts NULL first ascending: never-checked papers, then the oldest checks.
    const corpus = await db.write.publication.findMany({
      where: only ? { pmid: { in: only } } : undefined,
      select: { pmid: true },
      orderBy: [{ bookshelfCheckedAt: "asc" }, { pmid: "asc" }],
    });
    const pmids = corpus.map((p) => p.pmid).filter((p) => /^\d{1,9}$/.test(p)).slice(0, limit);
    console.log(`${pmids.length} publications.`);
    if (pmids.length === 0) throw new Error("No publications to check.");

    const added = (await pubmedPass(pmids, Boolean(only || limit))) + (await bookshelfPass(pmids, budgetMin));
    await rollup();
    console.log(`Done in ${Math.round((Date.now() - start) / 1000)}s: ${added} citation links added.`);
    return added;
  } finally {
    await closeReciterPool();
  }
}

// process.exitCode (not process.exit) so the .finally cleanup still runs; the
// disconnect waits for withEtlRun's trailing etl_run write (see etl/data-sharing).
withEtlRun("PolicyCitations", main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.write.$disconnect());
