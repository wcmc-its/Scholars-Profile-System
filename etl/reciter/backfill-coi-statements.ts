/**
 * Phase 1 (COI-gap) ingestion — populate `publication_conflict_statement` from
 * ReciterDB.reporting_conflicts (issue #594 follow-on). Near-verbatim clone of
 * `backfill-abstracts.ts`.
 *
 * Pulls `conflictsVarchar` (the per-PMID PubMed "Competing interests:" text,
 * already CAST to varchar at the source — read this, NOT the raw `conflictStatement`
 * blob) for every PMID already in our `publication` table, and upserts the text
 * into `publication_conflict_statement`. Idempotent / safe to re-run.
 *
 * The statement is stored verbatim and PAPER-LEVEL; the per-author attribution
 * that decides whether a named relationship belongs to a given scholar is
 * computed at request time by `lib/coi-gap` and never persisted as a verdict
 * (see docs/coi-pubmed-unmatched-feasibility.md). Pure-negation statements
 * ("No competing interests…") are stored too — the gap pipeline drops them at
 * compute time; keeping them preserves auditability and a Case-3 signal.
 *
 * Prerequisites (see docs/coi-pubmed-phase0-precision-study.md):
 *   - ReciterDB reachable (SPS->WCM VPC path; currently fragile — the helper
 *     fails fast at 2s/3s rather than stalling).
 *   - `conflictsImport.py` enabled in the WCM ReciterDB nightly so
 *     `reporting_conflicts` is actually populated. The final log line reports
 *     coverage; investigate if it is unexpectedly zero (do not assume a clean run
 *     over an empty source).
 *
 * Usage: `npm run etl:reciter:coi-statements`  (or `npx tsx etl/reciter/backfill-coi-statements.ts`)
 */
import { db } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { withEtlRun } from "@/lib/etl-run";

type ConflictRow = { pmid: number; conflictsVarchar: string | null };

const IN_BATCH = 500;
const UPSERT_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  console.log("Loading existing publication PMIDs...");
  const pubs = await db.write.publication.findMany({ select: { pmid: true } });
  const pmids = pubs.map((p) => Number(p.pmid)).filter((n) => Number.isFinite(n));
  console.log(`${pmids.length} pmids to check.`);

  console.log("Pulling COI statements from ReciterDB.reporting_conflicts...");
  const statementByPmid = new Map<number, string>();
  let checked = 0;
  for (const batch of chunks(pmids, IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT pmid, conflictsVarchar
         FROM reporting_conflicts
         WHERE pmid IN (?) AND conflictsVarchar IS NOT NULL AND conflictsVarchar <> ''`,
        [batch],
      )) as ConflictRow[];
      for (const r of rows) {
        // reporting_conflicts has no unique pmid constraint; last non-empty wins.
        if (r.conflictsVarchar) statementByPmid.set(Number(r.pmid), r.conflictsVarchar);
      }
    });
    checked += batch.length;
    if (checked % (IN_BATCH * 10) === 0) {
      console.log(`  ...checked ${checked}/${pmids.length}, found ${statementByPmid.size} statements so far`);
    }
  }
  console.log(`Got ${statementByPmid.size} COI statements (of ${pmids.length} pmids).`);

  console.log("Upserting publication_conflict_statement...");
  let written = 0;
  const entries = Array.from(statementByPmid.entries());
  for (const batch of chunks(entries, UPSERT_BATCH)) {
    await db.write.$transaction(
      batch.map(([pmid, statementText]) =>
        db.write.publicationConflictStatement.upsert({
          where: { pmid: String(pmid) },
          create: { pmid: String(pmid), statementText, source: "PubMed" },
          update: { statementText, source: "PubMed", lastRefreshedAt: new Date() },
        }),
      ),
    );
    written += batch.length;
    if (written % (UPSERT_BATCH * 10) === 0) {
      console.log(`  ...${written}/${entries.length}`);
    }
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(
    `Backfill complete in ${elapsed}s: ${written} conflict statements written ` +
      `(${((100 * written) / Math.max(1, pmids.length)).toFixed(1)}% of ${pmids.length} pmids carry a COI statement).`,
  );
  if (written === 0) {
    console.warn(
      "WARNING: 0 statements written. Verify reporting_conflicts is populated " +
        "(conflictsImport.py enabled in the ReciterDB nightly) before trusting a clean run.",
    );
  }
}

withEtlRun("ReCiter-COI-Statements", main)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
    await closeReciterPool();
  });
