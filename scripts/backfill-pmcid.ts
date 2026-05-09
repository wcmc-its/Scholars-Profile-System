/**
 * Backfill `publication.pmcid` from reciterdb.analysis_summary_article (#87).
 * Targeted update — only writes pmcid; doesn't touch any other columns. Safe
 * to re-run; idempotent UPDATE with WHERE clause to avoid no-op writes.
 */
import { prisma } from "@/lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

const IN_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("Loading publication pmids from local DB...");
  const pubs = await prisma.publication.findMany({ select: { pmid: true } });
  const pmids = pubs.map((p) => Number(p.pmid)).filter((n) => Number.isFinite(n));
  console.log(`Got ${pmids.length} pmids.`);

  console.log("Fetching pmcid values from reciterdb...");
  const pmcidByPmid = new Map<string, string>();
  for (const batch of chunks(pmids, IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT pmid, pmcid FROM analysis_summary_article
          WHERE pmid IN (?) AND pmcid IS NOT NULL AND pmcid <> ''`,
        [batch],
      )) as Array<{ pmid: number; pmcid: string }>;
      for (const r of rows) pmcidByPmid.set(String(r.pmid), r.pmcid);
    });
  }
  console.log(`Found pmcid for ${pmcidByPmid.size} publications.`);

  let updated = 0;
  for (const [pmid, pmcid] of pmcidByPmid.entries()) {
    await prisma.publication.update({
      where: { pmid },
      data: { pmcid },
    });
    updated += 1;
    if (updated % 1000 === 0) console.log(`  ...${updated}/${pmcidByPmid.size}`);
  }
  console.log(`Done. Updated ${updated} rows.`);
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
