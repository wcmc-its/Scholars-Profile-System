/**
 * Clinical Trials ETL (direct) — load each scholar's trials from reciterdb in a
 * single in-process pass.
 *
 * Source of truth chain:
 *   institutional CTMS export → reciterdb.clinical_trials
 *     (cwid, protocolNumber, piName, title, dates, sponsor, status — the spine)
 *   ClinicalTrials.gov API v2 → reciterdb.clinical_trials_enriched
 *     (briefTitle/officialTitle, summary, phases, conditions, MeSH, enrollment;
 *      joined on nctNumber, populated upstream by ReciterAI's enrichment job)
 *     → clinical_trial + person_clinical_trial  (this script)
 *
 * The institutional table already carries cwid, so — unlike etl/nih-profile —
 * no entity resolution is needed; trials arrive pre-linked. `role` is the one
 * derived field (name-match of the scholar against piName).
 *
 * Full-replace each run (the institutional export is a static snapshot).
 *
 * Requires reachability to BOTH reciterdb (read) and the Sps DB (write) from the
 * one runner — true once the SPS↔WCM networking lands (#443). While that gap is
 * open the in-VPC task can't reach reciterdb; use the export/import bridge
 * (export.ts + import.ts) instead, which splits the read and write across the
 * two reachable environments.
 *
 * Usage: `npm run etl:clinical-trials`
 */
import { db } from "../../lib/db";
import { closeReciterPool } from "@/lib/sources/reciterdb";
import { buildTrialsAndLinks, loadScholars, readReciterdbTables, replaceAll } from "./shared";

async function main() {
  const start = Date.now();
  const now = new Date();

  try {
    console.log("Loading scholars from the Sps DB...");
    const scholars = await loadScholars();
    console.log(`${scholars.size} scholars in our DB.`);

    console.log("Loading clinical_trials + clinical_trials_enriched from reciterdb...");
    const { institutional, enriched } = await readReciterdbTables();
    console.log(
      `Loaded ${institutional.length} institutional rows, ${enriched.length} enriched rows.`,
    );

    const { trials, links, stats } = buildTrialsAndLinks(institutional, enriched, scholars, now);
    console.log(
      `Built ${stats.trials} trials (${stats.enrichedHits} institutional rows had NCT enrichment) ` +
        `and ${stats.links} person links. ` +
        `Skipped ${stats.skippedNoProtocol} rows w/o protocolNumber, ` +
        `${stats.skippedUnknownCwid} w/ cwid not in our scholar set.`,
    );

    if (institutional.length > 0 && trials.length === 0) {
      // We read rows but matched none — almost certainly a join/scholar-set
      // problem, not a genuine empty source. Don't wipe good data on a fluke.
      throw new Error(
        `Refusing to full-replace: ${institutional.length} institutional rows read but 0 trials built.`,
      );
    }

    console.log("Replacing person_clinical_trial + clinical_trial...");
    const r = await replaceAll(trials, links);
    console.log(
      `Deleted ${r.delLinks} old links, ${r.delTrials} old trials. ` +
        `Inserted ${r.insTrials} trials, ${r.insLinks} person links.`,
    );
  } finally {
    await closeReciterPool();
    await db.write.$disconnect();
  }

  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
