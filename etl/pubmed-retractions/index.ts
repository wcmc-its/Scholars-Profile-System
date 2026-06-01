/**
 * PubMed-retraction ETL — issue #604.
 *
 * Stamps `publication_type = 'Retraction'` on any corpus publication that
 * PubMed marks as a `Retracted Publication`, so the existing read-path filter
 * (`NEVER_DISPLAY_TYPES`, lib/publication-types.ts) hides it everywhere —
 * profile, topic, home, search, and the OpenSearch index — with no schema or
 * read-path change.
 *
 * Why this exists: ReCiter already collapses a retracted original to
 * `publicationType = 'Retraction'`, but only after it re-fetches the paper's
 * PubMed record post-retraction. Papers retracted since ReCiter's last fetch
 * keep their pre-retraction type and leak onto profiles. This step closes that
 * residual gap (measured at ~30 papers corpus-wide, 2026-05-30) directly from
 * PubMed, the source of truth.
 *
 * Ordering (CDK etl-stack nightly chain): runs AFTER `etl:reciter` — whose
 * upsert overwrites `publication_type` from ReciterDB on every row — and
 * BEFORE `search:index`, so the rebuilt index reflects the stamp. Re-applying
 * nightly is intentional: it is how an un-retraction self-heals (reciter
 * restores the real type; this step no longer re-stamps a PMID that has left
 * the retracted set).
 *
 * Idempotent: only rows not already typed 'Retraction' are touched, so a
 * converged corpus updates zero rows.
 *
 * Usage: `npm run etl:pubmed-retractions`
 *
 * Rationale & operator notes: docs/retracted-publications.md
 */
import { db } from "../../lib/db";
import { fetchRetractedPmids } from "./fetcher";
import { RETRACTION_TYPE, selectPmidsToStamp } from "./select";

const UPDATE_BATCH = 1000;

function chunks<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "PubMedRetractions", status: "running" },
  });

  try {
    // Page the full retracted set from PubMed, by publication year so every
    // ESearch call stays under the retstart=9998 ceiling. Fetch all years
    // through next calendar year (a cheap guard against a late-December run
    // missing just-published January records at year roll-over).
    const throughYear = new Date().getFullYear() + 1;
    console.log(`Fetching 'Retracted Publication' PMIDs from PubMed (through ${throughYear})...`);
    const retracted = await fetchRetractedPmids({
      throughYear,
      apiKey: process.env.NCBI_API_KEY,
    });
    console.log(`PubMed retracted set: ${retracted.size} PMIDs.`);
    if (retracted.size === 0) {
      // A zero set almost certainly means a fetch fault, not that PubMed has no
      // retractions. Refuse to proceed rather than no-op on bad data.
      throw new Error("PubMed returned 0 retracted PMIDs — aborting (likely a fetch fault).");
    }

    // Compare against our corpus. publicationType is the canonical type column.
    const corpus = await db.write.publication.findMany({
      select: { pmid: true, publicationType: true },
    });
    console.log(`Corpus: ${corpus.length} publications.`);

    const toStamp = selectPmidsToStamp(corpus, retracted);
    console.log(
      `Retracted papers held: ${corpus.filter((p) => retracted.has(p.pmid)).length}; ` +
        `to stamp (not already '${RETRACTION_TYPE}'): ${toStamp.length}.`,
    );

    let stamped = 0;
    for (const batch of chunks(toStamp, UPDATE_BATCH)) {
      const res = await db.write.publication.updateMany({
        where: { pmid: { in: batch }, publicationType: { not: RETRACTION_TYPE } },
        data: { publicationType: RETRACTION_TYPE },
      });
      stamped += res.count;
    }
    console.log(`Stamped ${stamped} publications as '${RETRACTION_TYPE}'.`);

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: stamped },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`PubMed-retraction ETL complete in ${elapsed}s: stamped=${stamped}.`);
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
