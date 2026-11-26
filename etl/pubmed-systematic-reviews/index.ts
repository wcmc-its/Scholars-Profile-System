/**
 * PubMed systematic review ETL.
 *
 * Records which corpus publications PubMed's own systematic review filter
 * (`systematic[sb]`) matches, in `pubmed_systematic_review`. The table holds
 * only the PMIDs flagged right now. Nothing reads it yet: it exists so a later
 * change can use the flag.
 *
 * Each run asks PubMed about every corpus PMID, 100 per ESearch call, then
 * writes the difference: PMIDs no longer flagged are deleted, newly flagged
 * ones are inserted, and rows already there are left alone so `flagged_at`
 * records when a paper was first flagged. The whole write is one transaction.
 *
 * Guards (select.ts): the run aborts before writing when PubMed flags nothing,
 * or when a table of 100 or more rows would shrink to less than half. A failed
 * ESearch batch throws, so the write never happens from a partial answer.
 *
 * `rowsProcessed` is the total flagged, a volume that stays roughly flat from
 * week to week.
 *
 * Usage: `npm run etl:pubmed-systematic-reviews`
 * Env: optional NCBI_SHARED_API_KEY (the deployed job; a key borrowed from
 * ReCiter, see cdk/lib/etl-stack.ts) or NCBI_API_KEY.
 */
import { db } from "../../lib/db";
import { fetchSystematicReviewPmids } from "./fetcher";
import { assertFlaggedVolume, diffFlagged } from "./select";

const WRITE_BATCH = 1000;
const PROGRESS_EVERY = 500;

function chunks<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "PubMedSystematicReviews", status: "running" },
  });

  try {
    const corpus = await db.write.publication.findMany({ select: { pmid: true } });
    console.log(`Corpus: ${corpus.length} publications.`);

    const { flagged, asked, batches } = await fetchSystematicReviewPmids(
      corpus.map((p) => p.pmid),
      {
        apiKey: process.env.NCBI_SHARED_API_KEY ?? process.env.NCBI_API_KEY,
        onBatch: (done, total) => {
          if (done % PROGRESS_EVERY === 0) console.log(`ESearch batch ${done}/${total}...`);
        },
      },
    );
    console.log(
      `Asked PubMed about ${asked} PMIDs in ${batches} batches; ${flagged.size} match the systematic review filter.`,
    );

    const existing = (
      await db.write.pubmedSystematicReview.findMany({ select: { pmid: true } })
    ).map((r) => r.pmid);
    assertFlaggedVolume(flagged.size, existing.length);

    const { toAdd, toRemove, unchanged } = diffFlagged(existing, flagged);
    let added = 0;
    let removed = 0;
    await db.write.$transaction(
      async (tx) => {
        for (const batch of chunks(toRemove, WRITE_BATCH)) {
          removed += (await tx.pubmedSystematicReview.deleteMany({ where: { pmid: { in: batch } } }))
            .count;
        }
        for (const batch of chunks(toAdd, WRITE_BATCH)) {
          added += (
            await tx.pubmedSystematicReview.createMany({
              data: batch.map((pmid) => ({ pmid })),
              skipDuplicates: true,
            })
          ).count;
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: flagged.size },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `PubMed systematic review ETL complete in ${elapsed}s: corpus=${corpus.length} ` +
        `batches=${batches} flagged=${flagged.size} added=${added} removed=${removed} unchanged=${unchanged}.`,
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

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
