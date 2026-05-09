/**
 * RePORTER ETL — populates grant.abstract, grant.applId, grant.abstractFetchedAt
 * from reciterdb.grant_reporter_project. Issue #86 (UI) consumes these fields.
 *
 * Source of truth chain:
 *   NIH RePORTER /projects/search
 *     → reciterdb.grant_reporter_project (populated by ReCiterDB's
 *       update/retrieveReporter.py — issue #85)
 *     → grant.{abstract, applId, abstractFetchedAt}  (this script)
 *
 * Why two hops: the same RePORTER pull on the ReciterDB side also drives
 * pub-grant linkage reconciliation (grant_provenance), so we'd otherwise
 * fetch the same data twice. Reading from reciterdb here keeps the API
 * call rate halved and makes ReciterDB the single canonical RePORTER
 * mirror.
 *
 * Matching: parse `grant.awardNumber` (e.g. "R01 DK127777-04") with
 * lib/award-number.ts, reconstruct the core_project_num form
 * ("R01DK127777"), and look it up in reciterdb. Multiple appl_ids per
 * core_project_num (one per fiscal year) — we pick MAX(appl_id) which is
 * the most recent year's award.
 *
 * Idempotent. Safe to re-run. Updates only happen when applId or abstract
 * actually differ from what's stored (avoids touching abstractFetchedAt
 * on no-op runs).
 *
 * Usage: `npm run etl:reporter`
 */
import { prisma } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { coreProjectNum } from "@/lib/award-number";

type ReporterRow = {
  core_project_num: string;
  appl_id: number;
  abstract_text: string | null;
};

const UPDATE_BATCH = 200;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();

  console.log("Loading RePORTER projects from reciterdb.grant_reporter_project...");
  const reporterByCoreProject = new Map<string, ReporterRow>();
  await withReciterConnection(async (conn) => {
    // Pick MAX(appl_id) per core_project_num — the most recent FY's award.
    // Take its abstract too (abstracts can vary slightly across renewal
    // years; the latest is most useful for the Funding UI).
    const rows = (await conn.query(`
      SELECT
        p.core_project_num,
        p.appl_id,
        p.abstract_text
      FROM grant_reporter_project p
      INNER JOIN (
        SELECT core_project_num, MAX(appl_id) AS max_appl_id
        FROM grant_reporter_project
        WHERE core_project_num IS NOT NULL
        GROUP BY core_project_num
      ) latest
        ON p.core_project_num = latest.core_project_num
       AND p.appl_id = latest.max_appl_id
    `)) as ReporterRow[];
    for (const r of rows) {
      if (r.core_project_num) {
        reporterByCoreProject.set(r.core_project_num.toUpperCase(), r);
      }
    }
  });
  console.log(`Loaded ${reporterByCoreProject.size} distinct core_project_num records from RePORTER.`);

  console.log("Loading WCM grants from Postgres...");
  const grants = await prisma.grant.findMany({
    where: { awardNumber: { not: null } },
    select: { id: true, awardNumber: true, applId: true, abstract: true },
  });
  console.log(`${grants.length} grants with non-null awardNumber.`);

  let matched = 0;
  let toUpdate: Array<{ id: string; applId: number; abstract: string | null }> = [];
  let unparsable = 0;
  let unmatched = 0;

  for (const g of grants) {
    const core = coreProjectNum(g.awardNumber);
    if (!core) {
      unparsable++;
      continue;
    }
    const r = reporterByCoreProject.get(core);
    if (!r) {
      unmatched++;
      continue;
    }
    matched++;
    // Only update when something actually changed — avoids churning
    // abstractFetchedAt on no-op runs.
    if (g.applId !== r.appl_id || g.abstract !== r.abstract_text) {
      toUpdate.push({ id: g.id, applId: r.appl_id, abstract: r.abstract_text });
    }
  }

  console.log(
    `Matched ${matched} grants to RePORTER projects ` +
    `(${unparsable} unparsable awardNumber, ${unmatched} parsable but no RePORTER match). ` +
    `${toUpdate.length} need update.`
  );

  if (toUpdate.length === 0) {
    console.log("Nothing to write. Exiting.");
    await closeReciterPool();
    return;
  }

  console.log(`Updating ${toUpdate.length} grant rows...`);
  const fetchedAt = new Date();
  let updated = 0;
  for (const batch of chunks(toUpdate, UPDATE_BATCH)) {
    await prisma.$transaction(
      batch.map((u) =>
        prisma.grant.update({
          where: { id: u.id },
          data: {
            applId: u.applId,
            abstract: u.abstract,
            abstractFetchedAt: fetchedAt,
          },
        })
      )
    );
    updated += batch.length;
    if (updated % (UPDATE_BATCH * 5) === 0) {
      console.log(`  ...${updated}/${toUpdate.length}`);
    }
  }
  console.log(`Updated ${updated} grant rows.`);

  await closeReciterPool();
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
