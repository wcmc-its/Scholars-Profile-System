/**
 * Clinical-citations import, the part with no command line: its two sources
 * are passed in, so it is tested against an in-memory client
 * (tests/unit/clinical-citations.test.ts). index.ts supplies reciterdb and
 * PubMed.
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { Prisma } from "@/lib/generated/prisma/client";
import type { CitingDoc, PubmedSummary } from "../policy-citations/shape";
import { CLINICAL_COUNT_SQL, CLINICAL_LEVEL, clinicalAction, clinicalDoc, isOwnWork, OWN_WORK } from "./shape";

const CITED_BATCH = 500;
const SUMMARY_BATCH = 200;
const INSERT_BATCH = 2000;
const UPDATE_BATCH = 100;
/** PubMed batches fetched between writes: what a killed run loses at most. */
const WRITE_EVERY = 5;

export type ClinicalSources = {
  /** `[cited, citing]` for each cited PMID given, from `analysis_nih_cites_clin`. Throws on a failed read. */
  readLinks: (cited: string[]) => Promise<Array<[number, number]>>;
  /** PubMed summaries by PMID. Throws on a failed read; a deleted record is simply absent. */
  summaries: (pmids: number[]) => Promise<Map<string, PubmedSummary>>;
  now?: () => number;
};

export type ClinicalSummary = {
  /** Citation links the source holds for these publications. */
  links: number;
  citing: { stored: number; atAnotherLevel: number; fresh: number; fetched: number; noRecord: number; waiting: number };
  linksAdded: number;
  ownWork: number;
  rollup: number;
};

function chunks<T>(a: ReadonlyArray<T>, n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

/**
 * Load the clinical articles citing `pmids`. Writes only ever add documents
 * and links; the one thing rewritten is a link's own-work flag.
 *
 * A link is only written through the id of a `clinical` document already in
 * the table, so there is never a link whose citing article has no metadata
 * row, and never a link to a document stored at a ranked level.
 *
 * `budgetMin` covers the PubMed fetch. When it runs out the documents fetched
 * so far are stored with their links, the rollup runs, and the next run picks
 * up the citing articles still not stored. A failed fetch is the same, except
 * that the run then fails.
 */
export async function loadClinicalCitations(
  pmids: string[],
  opts: { partial: boolean; budgetMin: number },
  src: ClinicalSources,
): Promise<ClinicalSummary> {
  const now = src.now ?? Date.now;

  /** Citing PMID -> the papers of ours it cites. */
  const byCiting = new Map<number, number[]>();
  let scanned = 0;
  for (const batch of chunks(pmids, CITED_BATCH)) {
    for (const [cited, citing] of await src.readLinks(batch)) {
      scanned++;
      const list = byCiting.get(citing);
      if (list) list.push(cited);
      else byCiting.set(citing, [cited]);
    }
  }
  console.log(`${scanned} clinical citation links from ${byCiting.size} citing articles.`);

  const summary: ClinicalSummary = {
    links: scanned,
    citing: { stored: 0, atAnotherLevel: 0, fresh: 0, fetched: 0, noRecord: 0, waiting: 0 },
    linksAdded: 0,
    ownWork: 0,
    rollup: 0,
  };
  if (scanned === 0) {
    // A spot check of a paper no clinical article cites is an answer. Over the
    // whole corpus it is a broken read: stop before the rollup can write zeros.
    if (!opts.partial) throw new Error("analysis_nih_cites_clin returned no citation links for the corpus.");
    return summary;
  }
  if (!opts.partial) {
    assertSourceVolume("clinical-citations:links", {
      incoming: scanned,
      existing: await db.write.publicationCitingDocument.count({
        where: { citingDocument: { level: CLINICAL_LEVEL } },
      }),
      maxDropPct: 50,
    });
  }

  /** Every PubMed document, at any level: the rows this import must not duplicate. */
  const stored = new Map(
    (
      await db.write.citingDocument.findMany({
        where: { source: "pubmed" },
        select: { id: true, externalId: true, level: true },
      })
    ).map((d) => [d.externalId, d]),
  );
  const authors = new Map<string, Set<string>>(); // pmid -> confirmed WCM authors
  for (const a of await db.write.publicationAuthor.findMany({
    where: { isConfirmed: true, cwid: { not: null } },
    select: { pmid: true, cwid: true },
  })) {
    authors.set(a.pmid, (authors.get(a.pmid) ?? new Set()).add(a.cwid!));
  }

  /** "pmid|citingDocumentId" of the own-work links seen this run. */
  const ownKeys = new Set<string>();
  /** Write the links of citing articles stored as `clinical`; `ids` maps PMID to document id. */
  const saveLinks = async (citing: number[], ids: ReadonlyMap<number, number>): Promise<void> => {
    const rows: Array<{ pmid: string; citingDocumentId: number; evidence?: typeof OWN_WORK }> = [];
    for (const c of citing) {
      const citingDocumentId = ids.get(c);
      if (citingDocumentId === undefined) continue;
      const theirs = authors.get(String(c));
      for (const cited of byCiting.get(c)!) {
        const pmid = String(cited);
        if (isOwnWork(authors.get(pmid), theirs)) {
          ownKeys.add(`${pmid}|${citingDocumentId}`);
          rows.push({ pmid, citingDocumentId, evidence: OWN_WORK });
        } else rows.push({ pmid, citingDocumentId });
      }
    }
    for (const batch of chunks(rows, INSERT_BATCH)) {
      summary.linksAdded += (
        await db.write.publicationCitingDocument.createMany({ data: batch, skipDuplicates: true })
      ).count;
    }
  };

  // Articles already stored as clinical: new links only (a new paper of ours
  // they cite). Articles stored at a ranked level are left entirely alone.
  const known: number[] = [];
  const fresh: number[] = [];
  for (const c of byCiting.keys()) {
    const action = clinicalAction(stored.get(String(c))?.level);
    if (action === "link") known.push(c);
    else if (action === "fetch") fresh.push(c);
    else summary.citing.atAnotherLevel++;
  }
  summary.citing.stored = known.length;
  summary.citing.fresh = fresh.length;
  console.log(
    `${known.length} citing articles already stored, ${summary.citing.atAnotherLevel} stored as a guideline, ` +
      `consensus statement or review (left as they are), ${fresh.length} to fetch from PubMed.`,
  );
  await saveLinks(known, new Map(known.map((c) => [c, stored.get(String(c))!.id])));

  // New citing articles, on the time budget. Each group's documents are
  // written before its links, so a run killed mid-fetch leaves documents the
  // next run links, never a link without its document.
  fresh.sort((a, b) => a - b);
  const deadline = now() + opts.budgetMin * 60_000;
  const groups = chunks(chunks(fresh, SUMMARY_BATCH), WRITE_EVERY);
  let asked = 0;
  // A failure here (PubMed gives up after about a minute of retries) comes
  // after earlier groups are stored, so it must not skip the flags and the
  // count below: they run over what was stored, and the run then fails.
  let fetchError: unknown;
  try {
    for (const group of groups) {
      const docs: CitingDoc[] = [];
      for (const batch of group) {
        if (now() >= deadline) break;
        const records = await src.summaries(batch);
        asked += batch.length;
        for (const p of batch) {
          const s = records.get(String(p));
          if (s) docs.push(clinicalDoc(p, s));
          else summary.citing.noRecord++;
        }
      }
      if (docs.length > 0) {
        await db.write.citingDocument.createMany({ data: docs, skipDuplicates: true });
        // Read back, level and all: a row another writer stored at a ranked level
        // in the meantime was not replaced, and gets no links from here.
        const rows = await db.write.citingDocument.findMany({
          where: { source: "pubmed", externalId: { in: docs.map((d) => d.externalId) } },
          select: { id: true, externalId: true, level: true },
        });
        const ids = new Map(
          rows.filter((r) => clinicalAction(r.level) === "link").map((r) => [Number(r.externalId), r.id]),
        );
        summary.citing.fetched += ids.size;
        await saveLinks([...ids.keys()], ids);
        console.log(`  ...PubMed: ${asked}/${fresh.length} citing articles fetched`);
      }
      if (now() >= deadline) break;
    }
  } catch (e) {
    fetchError = e;
    console.error(`The fetch failed with ${asked}/${fresh.length} citing articles asked for; rolling up what is stored.`);
  }
  summary.citing.waiting = fresh.length - asked;
  if (summary.citing.waiting > 0 && !fetchError) {
    console.log(
      `The ${opts.budgetMin}-minute budget ran out with ${summary.citing.waiting} citing articles still to fetch. ` +
        `The next run continues with them; counts are short until then.`,
    );
  }

  // Own-work flags on links that were already stored. Rewritten every run: an
  // authorship can be confirmed, or rejected, later. Only links this run read
  // are cleared, so a partial run leaves the rest alone.
  const flagged = await db.write.publicationCitingDocument.findMany({
    where: { citingDocument: { level: CLINICAL_LEVEL }, evidence: { not: Prisma.DbNull } },
    select: { pmid: true, citingDocumentId: true, citingDocument: { select: { externalId: true } } },
  });
  const flaggedKeys = new Set(flagged.map((l) => `${l.pmid}|${l.citingDocumentId}`));
  const toFlag = [...ownKeys].filter((k) => !flaggedKeys.has(k));
  const lapsed = flagged.filter(
    (l) =>
      !ownKeys.has(`${l.pmid}|${l.citingDocumentId}`) &&
      byCiting.get(Number(l.citingDocument.externalId))?.includes(Number(l.pmid)),
  );
  const updates: Prisma.PublicationCitingDocumentUpdateManyArgs[] = [
    ...toFlag.map((k) => {
      const [pmid, id] = k.split("|");
      return { where: { pmid, citingDocumentId: Number(id) }, data: { evidence: OWN_WORK } };
    }),
    ...lapsed.map(({ pmid, citingDocumentId }) => ({
      where: { pmid, citingDocumentId },
      data: { evidence: Prisma.DbNull },
    })),
  ];
  for (const batch of chunks(updates, UPDATE_BATCH)) {
    await db.write.$transaction(batch.map((u) => db.write.publicationCitingDocument.updateMany(u)));
  }
  summary.ownWork = ownKeys.size;

  // Only this column: this import must not be able to move the ranked counts.
  // The same expression is in the weekly rollup (etl/policy-citations/index.ts).
  summary.rollup = await db.write.$executeRaw`
    UPDATE publication p
      LEFT JOIN (
        SELECT l.pmid, ${CLINICAL_COUNT_SQL} AS cc
          FROM publication_citing_document l
          JOIN citing_document d ON d.id = l.citing_document_id
         WHERE d.level = 'clinical'
         GROUP BY l.pmid
      ) x ON x.pmid = p.pmid
       SET p.clinical_cite_count = COALESCE(x.cc, 0)
     WHERE p.clinical_cite_count <> COALESCE(x.cc, 0)`;
  console.log(
    `Written: ${summary.citing.fetched} citing articles added (${summary.citing.noRecord} with no PubMed record), ` +
      `${summary.linksAdded} links added, ${summary.ownWork} links are the authors' own work ` +
      `(${toFlag.length} newly flagged, ${lapsed.length} no longer); ` +
      `clinical_cite_count changed on ${summary.rollup} publications.`,
  );
  if (fetchError) throw fetchError;
  return summary;
}
