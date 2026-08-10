/**
 * Data-Sharing ETL (direct) — load each scholar's dataset deposits from
 * reciterdb in a single in-process pass.
 *
 * Source of truth chain:
 *   scripts/bulk-data-rule/attribute.py (S-Index spec) → reciterdb.dataset_deposit
 *     (cwid, repository, accessionOrDoi, resourceType, dataType, accessModel,
 *      depositYear, provenance, confidence, authorPosition, citing pmid — the spine)
 *     → dataset_deposit + person_dataset_deposit  (this script)
 *
 * Full-replace each run (the institutional extraction is a batch snapshot).
 *
 * Requires reachability to BOTH reciterdb (read) and the Sps DB (write) from
 * the one runner — true once SPS↔WCM networking lands (#443). While that gap
 * is open the in-VPC task can't reach reciterdb; use the export/import bridge
 * (export.ts + import.ts) instead, which splits the read and write across the
 * two reachable environments.
 *
 * Usage: `npm run etl:data-sharing`
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { closeReciterPool } from "@/lib/sources/reciterdb";
import { withEtlRun } from "@/lib/etl-run";
import { buildDepositsAndLinks, loadScholars, readSourceRows, replaceAll } from "./shared";

async function main() {
  const start = Date.now();
  const now = new Date();

  try {
    console.log("Loading scholars from the Sps DB...");
    const scholars = await loadScholars();
    console.log(`${scholars.size} scholars in our DB.`);

    console.log("Loading dataset_deposit from reciterdb...");
    const rows = await readSourceRows();
    console.log(`Loaded ${rows.length} source rows.`);

    const { deposits, links, stats } = buildDepositsAndLinks(rows, scholars, now);
    console.log(
      `Built ${stats.deposits} deposits and ${stats.links} person links. ` +
        `Skipped ${stats.skippedNoKey} rows w/o a repository/accession key, ` +
        `${stats.skippedUnknownCwid} w/ cwid not in our scholar set.`,
    );

    if (rows.length > 0 && deposits.length === 0) {
      // We read rows but matched none — almost certainly a join/scholar-set
      // problem, not a genuine empty source. Don't wipe good data on a fluke.
      throw new Error(
        `Refusing to full-replace: ${rows.length} source rows read but 0 deposits built.`,
      );
    }

    // The guard above misses the EMPTY-source case (rows.length === 0 →
    // deposits=[] sails through and replaceAll wipes both tables). Volume-check
    // the built set against what we currently hold before the full-replace.
    assertSourceVolume("data-sharing:full-replace", {
      incoming: deposits.length,
      existing: await db.write.datasetDeposit.count(),
      maxDropPct: 50,
    });

    console.log("Replacing person_dataset_deposit + dataset_deposit...");
    const r = await replaceAll(deposits, links);
    console.log(
      `Deleted ${r.delLinks} old links, ${r.delDeposits} old deposits. ` +
        `Inserted ${r.insDeposits} deposits, ${r.insLinks} person links.`,
    );
  } finally {
    await closeReciterPool();
  }

  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

// Records an etl_run row (source "DataSharing", distinct from the bridge
// import's "DataSharing-Import") so the freshness heartbeat tracks this step.
// withEtlRun writes the etl_run success/failure row AFTER main() returns, so
// db.write.$disconnect() is deferred to the .finally below — disconnecting
// inside main() made that trailing update auto-reopen the Prisma pool with
// nothing left to close it, hanging the process after "Done in …s." (same
// exit-hang as etl/reporter #1497, etl/clinical-trials).
// process.exitCode (not process.exit) so the .finally cleanup still runs on
// the failure path.
withEtlRun("DataSharing", main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.write.$disconnect());
