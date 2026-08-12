/**
 * Journal Impact Factor ETL (direct) — mirrors reciterdb's
 * `journal_impact_alternative` (Web-of-Science journal-level Impact Factor
 * data) into `JournalImpactFactor` in a single in-process pass.
 *
 * Single-process, not the export/import bridge (etl/reciter-rcr, etl/data-
 * sharing's export.ts/import.ts): #2337 already proved in-VPC reciterdb
 * reachability for a direct (same-runner) step — see the `DataSharingWeekly`
 * comment in cdk/lib/etl-stack.ts — so this needs no S3 NDJSON bridge.
 *
 * Source confirmed live 2026-08-12: 21,800 rows;
 * journalTitle/journalAbbrName never null or empty; issn null on 1,301 rows,
 * eissn on 563; impactScore1 (current-year JIF) null on 13, impactScore2
 * (5-year JIF) null on 795; category never null. Spot-checked impactScore1/2
 * against known journals (CA-A Cancer J Clin, NEJM, Lancet, Nature) — see the
 * `JournalImpactFactor` schema doc comment for the exact figures.
 *
 * Full-replace each run — this is a mirror (a JCR release snapshot), not an
 * accreted history.
 *
 * Usage: `npm run etl:journal-impact-factor`
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { Prisma } from "@/lib/generated/prisma/client";
import { normalizeJournalAbbrev } from "@/lib/journal-abbrev";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { withEtlRun } from "@/lib/etl-run";

export const INSERT_BATCH = 1000;

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Raw `reciterdb.journal_impact_alternative` row — column names/types
 *  Step-0-confirmed against the live source (2026-08-12), not assumed. */
export type SourceRow = {
  journalTitle: string | null;
  journalAbbrName: string | null;
  issn: string | null;
  eissn: string | null;
  impactScore1: number | null;
  impactScore2: number | null;
  category: string | null;
};

/** Read the full source table. The only step that needs reciterdb reachability. */
export async function readSourceRows(): Promise<SourceRow[]> {
  let rows: SourceRow[] = [];
  await withReciterConnection(async (conn) => {
    rows = (await conn.query(`
      SELECT journalTitle, journalAbbrName, issn, eissn, impactScore1, impactScore2, category
      FROM journal_impact_alternative
    `)) as SourceRow[];
  });
  return rows;
}

export type BuildResult = {
  rows: Prisma.JournalImpactFactorCreateManyInput[];
  skippedNoAbbrev: number;
  dedupedCollisions: number;
};

/**
 * Normalize + dedupe on `journalAbbrev` (the query-time join key). The live
 * source carries ZERO duplicate `journalAbbrName` values, case-sensitive or
 * normalized, across all 21,800 rows (checked 2026-08-12) — this dedup is a
 * defensive backstop against a future source change, not a known-needed path.
 * Last-row-wins on a genuine collision; a `createMany` on a duplicate
 * `journalAbbrev` would otherwise violate the `@@unique` constraint and abort
 * the whole batch.
 */
export function buildRows(source: SourceRow[]): BuildResult {
  const byAbbrev = new Map<string, Prisma.JournalImpactFactorCreateManyInput>();
  let skippedNoAbbrev = 0;
  let dedupedCollisions = 0;
  for (const r of source) {
    const title = (r.journalTitle ?? "").trim();
    const abbrev = normalizeJournalAbbrev(r.journalAbbrName ?? "");
    if (!abbrev || !title) {
      skippedNoAbbrev++;
      continue;
    }
    if (byAbbrev.has(abbrev)) dedupedCollisions++;
    byAbbrev.set(abbrev, {
      journalTitle: title,
      journalAbbrev: abbrev,
      issn: r.issn,
      eissn: r.eissn,
      impactScore1: r.impactScore1 === null ? null : new Prisma.Decimal(r.impactScore1),
      impactScore2: r.impactScore2 === null ? null : new Prisma.Decimal(r.impactScore2),
      category: r.category,
    });
  }
  return { rows: [...byAbbrev.values()], skippedNoAbbrev, dedupedCollisions };
}

async function replaceAll(rows: Prisma.JournalImpactFactorCreateManyInput[]): Promise<number> {
  let inserted = 0;
  await db.write.$transaction(
    async (tx) => {
      await tx.journalImpactFactor.deleteMany({});
      for (const batch of chunks(rows, INSERT_BATCH)) {
        await tx.journalImpactFactor.createMany({ data: batch });
        inserted += batch.length;
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return inserted;
}

async function main(): Promise<number> {
  try {
    console.log("Loading journal_impact_alternative from reciterdb...");
    const source = await readSourceRows();
    console.log(`Loaded ${source.length} source rows.`);

    const { rows, skippedNoAbbrev, dedupedCollisions } = buildRows(source);
    console.log(
      `Built ${rows.length} rows. Skipped ${skippedNoAbbrev} w/o a usable title/abbreviation, ` +
        `${dedupedCollisions} normalized-abbreviation collisions (last-row-wins).`,
    );

    // Floor 15,000 -- ~69% of the confirmed 21,800-row source (2026-08-12),
    // enough slack for normal JCR-release churn without masking a truncated
    // or broken read. maxDropPct guards a shrink vs whatever's already held
    // (no-op on the first, bootstrap run, when existing is 0).
    assertSourceVolume("journal-impact-factor:full-replace", {
      incoming: rows.length,
      existing: await db.write.journalImpactFactor.count(),
      floor: 15_000,
      maxDropPct: 50,
    });

    const inserted = await replaceAll(rows);
    console.log(`Replaced journal_impact_factor: ${inserted} rows inserted.`);
    return inserted;
  } finally {
    await closeReciterPool();
  }
}

// process.exitCode (not process.exit) so the .finally cleanup below still
// runs on the failure path — same reasoning as etl/data-sharing/index.ts.
withEtlRun("JournalImpactFactor", main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.write.$disconnect());
