/**
 * One-shot backfill — populate `publication.abstract` on existing rows
 * without re-running the full ReciterDB ETL (issue #21).
 *
 * Pulls `abstractVarchar` from ReciterDB.reporting_abstracts for every PMID
 * that's already in our `publication` table and updates the `abstract`
 * column. Safe to re-run; idempotent. After this completes, run
 * `npm run search:index` to push the abstracts into OpenSearch.
 *
 * Usage: `npx tsx etl/reciter/backfill-abstracts.ts`
 */
import { prisma } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

type AbstractRow = { pmid: number; abstractVarchar: string | null };

const IN_BATCH = 500;
const UPDATE_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  console.log("Loading existing publication PMIDs...");
  const pubs = await prisma.publication.findMany({ select: { pmid: true } });
  const pmids = pubs.map((p) => Number(p.pmid)).filter((n) => Number.isFinite(n));
  console.log(`${pmids.length} pmids to backfill.`);

  console.log("Pulling abstracts from ReciterDB.reporting_abstracts...");
  const abstractByPmid = new Map<number, string>();
  let fetched = 0;
  for (const batch of chunks(pmids, IN_BATCH)) {
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
    fetched += batch.length;
    if (fetched % (IN_BATCH * 10) === 0) {
      console.log(`  ...checked ${fetched}/${pmids.length}, found ${abstractByPmid.size} abstracts so far`);
    }
  }
  console.log(`Got ${abstractByPmid.size} abstracts (of ${pmids.length} pmids).`);

  console.log("Updating publication.abstract...");
  let updated = 0;
  const entries = Array.from(abstractByPmid.entries());
  for (const batch of chunks(entries, UPDATE_BATCH)) {
    await prisma.$transaction(
      batch.map(([pmid, abstract]) =>
        prisma.publication.update({
          where: { pmid: String(pmid) },
          data: { abstract },
        }),
      ),
    );
    updated += batch.length;
    if (updated % (UPDATE_BATCH * 10) === 0) {
      console.log(`  ...${updated}/${entries.length}`);
    }
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`Backfill complete in ${elapsed}s: ${updated} publications updated.`);
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
