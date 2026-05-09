/**
 * RePORTER ETL — two steps:
 *
 *   1. Populate grant.{applId, abstract, abstractFetchedAt} from
 *      reciterdb.grant_reporter_project (idempotent; only writes diffs).
 *
 *   2. Materialize grant_publication from reciterdb.grant_provenance,
 *      bridging the two databases so the Funding API can serve pub counts
 *      and the expanded pub list per grant without a runtime cross-DB
 *      query. Scoped to (grant, pmid) pairs where both the grant exists
 *      in our Postgres and the pmid exists in our Publication table.
 *
 * Source of truth chain:
 *   NIH RePORTER (/projects/search + /publications/search)
 *     → reciterdb.grant_reporter_project + grant_provenance
 *       (populated by ReCiterDB's update/retrieveReporter.py — issue #85)
 *     → grant.{applId, abstract} + grant_publication  (this script)
 *
 * Why this lives here and not in etl/reciter: that pipeline rebuilds
 * publications/authorships from scratch each run. This one operates on
 * Grants (a different cwid-keyed surface) and uses the RePORTER-side
 * tables that retrieveReporter.py owns. Coupling them means a Reciter ETL
 * failure won't block grant abstract updates.
 *
 * Matching key: NIH RePORTER's `core_project_num` (e.g. "R01DK127777"),
 * reconstructed from grant.awardNumber by lib/award-number's
 * coreProjectNum() helper. For grant.applId we pick MAX(appl_id) per core
 * (most recent FY's award). For grant_publication we use the full
 * (personIdentifier, pmid, core_project_num) keying from grant_provenance.
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

type ProvenanceRow = {
  personIdentifier: string;
  pmid: number;
  core_project_num: string;
  source_reporter: number;
  source_reciterdb: number;
  reporter_first_seen: Date | null;
  reciterdb_first_seen: Date | null;
};

async function step1_GrantAbstracts() {
  console.log("\n=== Step 1: Grant abstracts + applId ===");

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
  const toUpdate: Array<{ id: string; applId: number; abstract: string | null }> = [];
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
    console.log("Nothing to write.");
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
}

async function step2_GrantPublications() {
  console.log("\n=== Step 2: grant_publication materialization ===");

  // Load all our grants with awardNumber (we need awardNumber to derive
  // the join key). Index by (cwid, core_project_num) since that's the
  // composite key used in grant_provenance.
  console.log("Loading WCM grants for join...");
  const grants = await prisma.grant.findMany({
    where: { awardNumber: { not: null } },
    select: { id: true, cwid: true, awardNumber: true },
  });
  const grantsByKey = new Map<string, string[]>(); // "cwid|core" → [grantId, ...]
  for (const g of grants) {
    const core = coreProjectNum(g.awardNumber);
    if (!core) continue;
    const key = `${g.cwid}|${core}`;
    const list = grantsByKey.get(key);
    if (list) list.push(g.id);
    else grantsByKey.set(key, [g.id]);
  }
  console.log(`${grants.length} grants → ${grantsByKey.size} distinct (cwid, core_project_num) keys.`);

  // Load all our publication PMIDs as the second filter — we only
  // materialize linkages for pubs the Scholars system actually knows
  // about (Postgres FK on pmid).
  console.log("Loading publication PMIDs...");
  const pubs = await prisma.publication.findMany({ select: { pmid: true } });
  const ourPmids = new Set(pubs.map((p) => p.pmid));
  console.log(`${ourPmids.size} publications in our DB.`);

  // Pull grant_provenance scoped to our scholars. Single big query —
  // ~108K rows in prod, fits comfortably in memory.
  console.log("Loading grant_provenance from reciterdb...");
  const provRows: ProvenanceRow[] = [];
  await withReciterConnection(async (conn) => {
    const cwids = Array.from(new Set(grants.map((g) => g.cwid)));
    if (cwids.length === 0) return;
    for (const batch of chunks(cwids, 500)) {
      const rows = (await conn.query(
        `SELECT personIdentifier, pmid, core_project_num,
                source_reporter, source_reciterdb,
                reporter_first_seen, reciterdb_first_seen
         FROM grant_provenance
         WHERE personIdentifier IN (?)`,
        [batch],
      )) as ProvenanceRow[];
      provRows.push(...rows);
    }
  });
  console.log(`Got ${provRows.length} grant_provenance rows.`);

  // Derive the GrantPublication rows: for each (cwid, core, pmid) provenance
  // row, look up the matching grantIds and the pmid in our DB, and emit one
  // row per (grantId, pmid) pair. Multiple Postgres Grant rows can share
  // (cwid, core) — e.g. duplicate InfoEd entries — and they should each get
  // the linkage.
  type PubRow = {
    id: string;
    grantId: string;
    pmid: string;
    sourceReporter: boolean;
    sourceReciterdb: boolean;
    reporterFirstSeen: Date | null;
    reciterdbFirstSeen: Date | null;
  };
  const seen = new Set<string>(); // dedupe (grantId|pmid)
  const toInsert: PubRow[] = [];
  let provNoGrant = 0;
  let provNoPub = 0;
  for (const p of provRows) {
    const pmidStr = String(p.pmid);
    if (!ourPmids.has(pmidStr)) {
      provNoPub++;
      continue;
    }
    const grantIds = grantsByKey.get(`${p.personIdentifier}|${(p.core_project_num || "").toUpperCase()}`);
    if (!grantIds || grantIds.length === 0) {
      provNoGrant++;
      continue;
    }
    for (const grantId of grantIds) {
      const dedup = `${grantId}|${pmidStr}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      toInsert.push({
        id: crypto.randomUUID(),
        grantId,
        pmid: pmidStr,
        sourceReporter: !!p.source_reporter,
        sourceReciterdb: !!p.source_reciterdb,
        reporterFirstSeen: p.reporter_first_seen,
        reciterdbFirstSeen: p.reciterdb_first_seen,
      });
    }
  }
  console.log(
    `${toInsert.length} (grant, pmid) pairs to materialize ` +
    `(${provNoPub} provenance rows skipped — pmid not in our publications, ` +
    `${provNoGrant} skipped — (cwid, core) not in our grants).`
  );

  // Truncate-reload pattern, scoped to the grants we actually loaded.
  // deleteMany WHERE grantId IN (...) is safer than full TRUNCATE — leaves
  // other rows alone if our grant scope changes.
  console.log("Clearing existing grant_publication rows for these grants...");
  const allGrantIds = grants.map((g) => g.id);
  let deleted = 0;
  for (const batch of chunks(allGrantIds, 1000)) {
    const r = await prisma.grantPublication.deleteMany({
      where: { grantId: { in: batch } },
    });
    deleted += r.count;
  }
  console.log(`Deleted ${deleted} existing rows.`);

  if (toInsert.length === 0) {
    console.log("Nothing to insert.");
    return;
  }

  console.log(`Inserting ${toInsert.length} grant_publication rows...`);
  let inserted = 0;
  for (const batch of chunks(toInsert, 1000)) {
    await prisma.grantPublication.createMany({ data: batch });
    inserted += batch.length;
    if (inserted % 5000 === 0) {
      console.log(`  ...${inserted}/${toInsert.length}`);
    }
  }
  console.log(`Inserted ${inserted} rows.`);
}

async function main() {
  const start = Date.now();
  try {
    await step1_GrantAbstracts();
    await step2_GrantPublications();
  } finally {
    await closeReciterPool();
  }
  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
